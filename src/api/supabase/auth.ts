import { logger } from '@/lib/logger';
import { maskEmail, normalizePhone } from '@/lib/format';
import {
  changePasswordSchema,
  forgotPasswordSchema,
  onboardingSchema,
  parseOrThrow,
  profileUpdateSchema,
  resetPasswordSchema,
  signInSchema,
  signUpSchema,
  verifyCodeSchema,
} from '@/lib/validation';
import { ApiError } from '../errors';
import { rateLimiter } from '../rateLimit';
import type { AuthUser, Invite, Session } from '../types';
import { call, deniedOrMissing } from './call';
import { resetSupabaseClient, supabase } from './client';
import { mapOrganization, mapProfile } from './mappers';

/**
 * Authentication against Supabase Auth.
 *
 * The password reset genuinely sends a six-digit code now: Supabase emails an
 * OTP, `verifyOtp` exchanges it for a session, and the password is updated
 * within that session. The dev-preview panel in the UI simply gets nothing to
 * show, which is the correct behaviour once mail is real.
 *
 * Rate limiting stays client-side as a courtesy - it stops a user hammering the
 * button and burning their Supabase email quota. The authoritative limits are
 * Supabase's own.
 */

async function loadAuthUser(userId: string): Promise<AuthUser> {
  const profileRow = await call('auth.profile', () =>
    supabase()
      .from('profiles')
      .select('*, lat, lng')
      .eq('id', userId)
      .maybeSingle(),
  );

  if (!profileRow) {
    // Signed in but no profile: the signup trigger did not complete.
    throw new ApiError({
      kind: 'forbidden',
      message: 'no profile for user',
      userMessage: 'Your account is not fully set up. Contact your organisation admin.',
    });
  }

  const profile = mapProfile(profileRow);

  const orgRow = await call('auth.organization', () =>
    supabase().from('organizations').select('*').eq('id', profile.organizationId).maybeSingle(),
  );

  if (!orgRow) throw deniedOrMissing('organization not visible');

  return { profile, organization: mapOrganization(orgRow) };
}

function toSession(raw: { access_token: string; refresh_token: string; expires_at?: number; user: { id: string } }, deviceLabel: string): Session {
  return {
    token: raw.access_token,
    refreshToken: raw.refresh_token,
    profileId: raw.user.id,
    issuedAt: new Date().toISOString(),
    expiresAt: new Date((raw.expires_at ?? Math.floor(Date.now() / 1000) + 3600) * 1000).toISOString(),
    deviceLabel,
  };
}

export const supabaseAuthApi = {
  async signIn(input: unknown, deviceLabel = 'This device'): Promise<{ session: Session; user: AuthUser }> {
    const data = parseOrThrow(signInSchema, input);
    await rateLimiter.consume('auth.signIn', data.email);

    const { data: result, error } = await supabase().auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });

    if (error || !result.session) {
      logger.warn('auth', 'sign-in failed', { email: maskEmail(data.email) });
      throw new ApiError({
        kind: error?.status === 400 ? 'unauthorized' : 'server',
        message: error?.message ?? 'sign-in failed',
        userMessage:
          error?.message === 'Invalid login credentials'
            ? 'That email or password is not correct.'
            : error?.message ?? 'Could not sign in.',
      });
    }

    rateLimiter.refund('auth.signIn', data.email);
    const user = await loadAuthUser(result.session.user.id);

    // Best-effort presence; never worth failing a sign-in over.
    void supabase()
      .from('profiles')
      .update({ last_seen_at: new Date().toISOString() })
      .eq('id', user.profile.id)
      .then(() => undefined);

    logger.info('auth', 'sign-in ok', { role: user.profile.role });
    return { session: toSession(result.session, deviceLabel), user };
  },

  /**
   * Invite-gated sign-up. The invite code travels in user metadata, and the
   * `handle_new_user` database trigger is what actually validates it and builds
   * the profile - so an invalid code fails inside the signup transaction and no
   * orphan account is left behind.
   */
  async signUp(input: unknown): Promise<{ session: Session; user: AuthUser }> {
    const data = parseOrThrow(signUpSchema, input);
    await rateLimiter.consume('auth.signUp', data.email);

    const { data: result, error } = await supabase().auth.signUp({
      email: data.email,
      password: data.password,
      options: {
        data: {
          full_name: data.fullName,
          phone: normalizePhone(data.phone),
          invite_code: data.inviteCode,
        },
      },
    });

    if (error) {
      const message = error.message ?? '';
      // The trigger raises these; they are written to be shown to a person.
      if (/invite/i.test(message)) {
        throw new ApiError({
          kind: 'validation',
          message,
          fieldErrors: { inviteCode: message },
        });
      }
      if (/already registered|already exists/i.test(message)) {
        throw new ApiError({
          kind: 'conflict',
          message,
          userMessage: 'An account already exists for that email. Try signing in instead.',
        });
      }
      throw new ApiError({ kind: 'validation', message, userMessage: message });
    }

    if (!result.session) {
      // Email confirmation is enabled on the project.
      throw new ApiError({
        kind: 'validation',
        message: 'confirmation required',
        userMessage: 'Check your email to confirm your account, then sign in.',
      });
    }

    const user = await loadAuthUser(result.session.user.id);
    return { session: toSession(result.session, 'This device'), user };
  },

  /**
   * Send a six-digit reset code.
   *
   * Always resolves the same way whether or not the address is registered, so
   * the endpoint cannot be used to discover which humanitarian staff use the
   * system. `devPreview` is always null here - the code goes by email.
   */
  async requestPasswordCode(input: unknown): Promise<{ sentTo: string; expiresInSeconds: number; devPreview: string | null }> {
    const data = parseOrThrow(forgotPasswordSchema, input);
    await rateLimiter.consume('auth.requestCode', data.email);

    const { error } = await supabase().auth.resetPasswordForEmail(data.email);

    // Deliberately not surfaced: a failure here would reveal whether the
    // address exists. It is logged for operators instead.
    if (error) logger.warn('auth', 'reset request failed', { email: maskEmail(data.email), message: error.message });

    return { sentTo: maskEmail(data.email), expiresInSeconds: 3600, devPreview: null };
  },

  /**
   * Exchange the emailed code for a session. Supabase's `recovery` OTP returns
   * a real session, which is what authorises the password update that follows.
   */
  async verifyCode(input: unknown): Promise<{ resetToken: string }> {
    const data = parseOrThrow(verifyCodeSchema, input);
    await rateLimiter.consume('auth.verifyCode', data.email);

    const { data: result, error } = await supabase().auth.verifyOtp({
      email: data.email,
      token: data.code,
      type: 'recovery',
    });

    if (error || !result.session) {
      throw new ApiError({
        kind: 'validation',
        message: error?.message ?? 'invalid code',
        fieldErrors: { code: 'That code is not correct or has expired' },
      });
    }

    // The session itself is the credential for the reset; the screen carries
    // this token forward only so the flow keeps the same shape as the mock.
    return { resetToken: result.session.access_token };
  },

  async resetPassword(input: unknown): Promise<{ ok: true }> {
    const data = parseOrThrow(resetPasswordSchema, input);

    const { error } = await supabase().auth.updateUser({ password: data.password });
    if (error) {
      throw new ApiError({
        kind: 'validation',
        message: error.message,
        fieldErrors: { password: error.message },
      });
    }

    // Evict every other device. This is the control someone uses when a phone
    // has been lost or taken, so it must actually revoke.
    await supabase().auth.signOut({ scope: 'others' });
    return { ok: true as const };
  },

  async changePassword(input: unknown): Promise<{ ok: true }> {
    const data = parseOrThrow(changePasswordSchema, input);

    const { data: me } = await supabase().auth.getUser();
    if (!me.user?.email) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

    // Supabase cannot verify the current password directly, so re-authenticate.
    const { error: reauth } = await supabase().auth.signInWithPassword({
      email: me.user.email,
      password: data.currentPassword,
    });
    if (reauth) {
      throw new ApiError({
        kind: 'validation',
        message: 'current password wrong',
        fieldErrors: { currentPassword: 'That is not your current password' },
      });
    }

    const { error } = await supabase().auth.updateUser({ password: data.password });
    if (error) {
      throw new ApiError({ kind: 'validation', message: error.message, fieldErrors: { password: error.message } });
    }

    return { ok: true as const };
  },

  /** Restore a persisted session at cold start. */
  async restore(): Promise<AuthUser> {
    const { data, error } = await supabase().auth.getSession();
    if (error || !data.session) {
      throw new ApiError({ kind: 'unauthorized', message: 'no session' });
    }
    return loadAuthUser(data.session.user.id);
  },

  async currentSession(): Promise<Session | null> {
    const { data } = await supabase().auth.getSession();
    return data.session ? toSession(data.session, 'This device') : null;
  },

  async me(): Promise<AuthUser> {
    const { data } = await supabase().auth.getUser();
    if (!data.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });
    return loadAuthUser(data.user.id);
  },

  async signOut(): Promise<void> {
    await supabase().auth.signOut();
    await resetSupabaseClient();
  },

  async completeOnboarding(input: unknown): Promise<AuthUser> {
    const data = parseOrThrow(onboardingSchema, input);
    const { data: me } = await supabase().auth.getUser();
    if (!me.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

    const row = await call('auth.completeOnboarding', () =>
      supabase()
        .from('profiles')
        .update({
          operating_regions: data.operatingRegions,
          ...(data.jobTitle ? { job_title: data.jobTitle } : {}),
          onboarded_at: new Date().toISOString(),
        })
        .eq('id', me.user!.id)
        .select('*, lat, lng')
        .maybeSingle(),
    );

    if (!row) throw deniedOrMissing('profile update rejected');
    return loadAuthUser(me.user.id);
  },

  async updateProfile(input: unknown): Promise<AuthUser> {
    const data = parseOrThrow(profileUpdateSchema, input);
    const { data: me } = await supabase().auth.getUser();
    if (!me.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

    const patch: Record<string, unknown> = {};
    if (data.fullName !== undefined) patch.full_name = data.fullName;
    if (data.phone !== undefined) patch.phone = normalizePhone(data.phone);
    if (data.jobTitle !== undefined) patch.job_title = data.jobTitle;
    if (data.operatingRegions !== undefined) patch.operating_regions = data.operatingRegions;
    if (data.notificationPreferences !== undefined) patch.notification_preferences = data.notificationPreferences;

    if (Object.keys(patch).length) {
      const row = await call('auth.updateProfile', () =>
        supabase().from('profiles').update(patch).eq('id', me.user!.id).select('id').maybeSingle(),
      );
      if (!row) throw deniedOrMissing('profile update rejected');
    }

    return loadAuthUser(me.user.id);
  },

  /** Presence heartbeat, so alert fan-out can reach this user by radius. */
  async updateLocation(location: { lat: number; lng: number }): Promise<void> {
    const { data: me } = await supabase().auth.getUser();
    if (!me.user) return;

    await call('auth.updateLocation', () =>
      supabase()
        .from('profiles')
        .update({
          last_known_location: `SRID=4326;POINT(${location.lng} ${location.lat})`,
          last_seen_at: new Date().toISOString(),
        })
        .eq('id', me.user!.id)
        .select('id')
        .maybeSingle(),
    );
  },

  /**
   * Validate an invite before sign-up. Runs through a SECURITY DEFINER function
   * because the invites table is closed to anonymous readers - it returns only
   * the invitee's name, role and organisation, never the whole row.
   */
  async peekInvite(code: string): Promise<(Pick<Invite, 'email' | 'fullName' | 'role' | 'organizationId'> & { organizationName: string }) | null> {
    const rows = await call('auth.peekInvite', () =>
      supabase().rpc('peek_invite', { invite_code: code.trim() }),
    );

    const row = Array.isArray(rows) ? rows[0] : null;
    if (!row) return null;

    return {
      email: row.email,
      fullName: row.full_name,
      role: row.role,
      organizationId: '',
      organizationName: row.organization_name,
    };
  },
};
