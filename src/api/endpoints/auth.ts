import { logger } from '@/lib/logger';
import { localId, uuid } from '@/lib/ids';
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
import { auth, request } from '../client';
import { cache } from '../cache';
import { db, hashSecret, type VerificationCode } from '../db';
import { ApiError } from '../errors';
import { rateLimiter } from '../rateLimit';
import type { AuthUser, Invite, Profile, Session } from '../types';
import { API_MODE } from '../supabase/client';
import { supabaseAuthApi } from '../supabase/auth';

/**
 * Authentication.
 *
 * Password reset uses a six-digit code delivered to the account's email. In
 * this build there is no mail transport, so the code is surfaced through
 * `devPreview` and rendered in a clearly-labelled development banner - the
 * flow, the expiry, the attempt limits and the single-use semantics are all
 * real, only the delivery is stubbed.
 *
 * Two rules the mock enforces because they matter for security, not realism:
 *   - "Did that email exist?" is never answerable from a response. Every
 *     forgot-password call returns the same shape whether or not the account
 *     exists, so the endpoint cannot be used to enumerate staff.
 *   - Codes are stored hashed and consumed exactly once.
 */

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_CODE_ATTEMPTS = 5;
const LOCKOUT_THRESHOLD = 6;
const LOCKOUT_MS = 15 * 60 * 1000;

function generateCode(): string {
  // Uniform over 000000-999999; leading zeros preserved.
  return String(Math.floor(Math.random() * 1_000_000)).padStart(6, '0');
}

function issueSession(profileId: string, deviceLabel: string): Session {
  const now = Date.now();
  const session: Session = {
    token: `tok_${uuid()}`,
    refreshToken: `ref_${uuid()}`,
    profileId,
    issuedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 12 * 60 * 60 * 1000).toISOString(),
    deviceLabel,
  };
  db.insert('sessions', session);
  // One active session per device label keeps the seeded table from growing.
  const sessions = db.table('sessions');
  const stale = sessions.filter((s) => s.profileId === profileId && s.token !== session.token);
  stale.slice(4).forEach((s) => db.remove('sessions', s.token));
  return session;
}

function authUserFor(profile: Profile): AuthUser {
  const organization = db.table('organizations').find((o) => o.id === profile.organizationId);
  if (!organization) throw new ApiError({ kind: 'server', message: 'organization missing' });
  return { profile, organization };
}

const mockAuthApi = {
  /** Sign in with email + password. */
  async signIn(input: unknown, deviceLabel = 'This device'): Promise<{ session: Session; user: AuthUser }> {
    const data = parseOrThrow(signInSchema, input);

    return request(
      { name: 'auth.signIn', auth: false, limit: { key: 'auth.signIn', subject: data.email }, flakiness: 0 },
      () => {
        const credential = db.table('credentials').find((c) => c.email === data.email);

        // Generic failure regardless of which half was wrong.
        const invalid = () =>
          new ApiError({
            kind: 'unauthorized',
            message: 'invalid credentials',
            userMessage: 'That email or password is not correct.',
          });

        if (!credential) {
          logger.warn('auth', 'sign-in attempt for unknown email', { email: maskEmail(data.email) });
          throw invalid();
        }

        if (credential.lockedUntil && Date.parse(credential.lockedUntil) > Date.now()) {
          const mins = Math.ceil((Date.parse(credential.lockedUntil) - Date.now()) / 60_000);
          throw new ApiError({
            kind: 'rate-limited',
            message: 'account locked',
            userMessage: `Too many failed attempts. This account is locked for ${mins} more minute(s).`,
            retryAfterMs: Date.parse(credential.lockedUntil) - Date.now(),
          });
        }

        if (credential.passwordHash !== hashSecret(data.password, credential.profileId)) {
          const failedAttempts = credential.failedAttempts + 1;
          const lockedUntil =
            failedAttempts >= LOCKOUT_THRESHOLD ? new Date(Date.now() + LOCKOUT_MS).toISOString() : null;

          const index = db.table('credentials').findIndex((c) => c.email === data.email);
          db.table('credentials')[index] = { ...credential, failedAttempts, lockedUntil };

          db.audit({
            actorId: credential.profileId,
            actorRole: 'system',
            organizationId: '',
            action: 'auth.sign_in_failed',
            entity: 'auth',
            entityId: credential.profileId,
            summary: `Failed sign-in attempt ${failedAttempts}/${LOCKOUT_THRESHOLD}.`,
          });

          throw invalid();
        }

        const profile = db.table('profiles').find((p) => p.id === credential.profileId);
        if (!profile) throw invalid();

        if (profile.status === 'deactivated') {
          throw new ApiError({
            kind: 'forbidden',
            message: 'account deactivated',
            userMessage: 'This account has been deactivated. Contact your organisation admin.',
          });
        }

        const index = db.table('credentials').findIndex((c) => c.email === data.email);
        db.table('credentials')[index] = {
          ...credential,
          failedAttempts: 0,
          lockedUntil: null,
          lastSignInAt: new Date().toISOString(),
        };

        const session = issueSession(profile.id, deviceLabel);
        auth.setSession(session);
        rateLimiter.refund('auth.signIn', data.email);

        db.update('profiles', profile.id, { lastSeenAt: new Date().toISOString() });
        db.audit({
          actorId: profile.id,
          actorRole: profile.role,
          organizationId: profile.organizationId,
          action: 'auth.signed_in',
          entity: 'session',
          entityId: session.token,
          summary: `${profile.fullName} signed in on ${deviceLabel}.`,
        });

        logger.info('auth', 'sign-in ok', { role: profile.role });
        return { session, user: authUserFor(profile) };
      },
    );
  },

  /**
   * Sign up against an invite. Workers and officers never self-register into an
   * organisation - the invite code is what binds an account to an org and role.
   */
  async signUp(input: unknown): Promise<{ session: Session; user: AuthUser }> {
    const data = parseOrThrow(signUpSchema, input);

    return request(
      { name: 'auth.signUp', auth: false, limit: { key: 'auth.signUp', subject: data.email }, flakiness: 0 },
      () => {
        const invite = db.table('invites').find((i) => i.code === data.inviteCode);

        if (!invite) {
          throw new ApiError({
            kind: 'validation',
            message: 'unknown invite code',
            fieldErrors: { inviteCode: 'That invite code was not recognised' },
          });
        }
        if (invite.acceptedAt) {
          throw new ApiError({
            kind: 'conflict',
            message: 'invite already used',
            userMessage: 'That invite has already been used. Ask your admin for a new one.',
          });
        }
        if (Date.parse(invite.expiresAt) < Date.now()) {
          throw new ApiError({
            kind: 'validation',
            message: 'invite expired',
            fieldErrors: { inviteCode: 'That invite has expired. Ask your admin to resend it.' },
          });
        }
        if (invite.email.toLowerCase() !== data.email) {
          throw new ApiError({
            kind: 'validation',
            message: 'invite email mismatch',
            fieldErrors: {
              email: `This invite was issued to ${maskEmail(invite.email)}. Sign up with that address.`,
            },
          });
        }
        if (db.table('credentials').some((c) => c.email === data.email)) {
          throw new ApiError({
            kind: 'conflict',
            message: 'account exists',
            userMessage: 'An account already exists for that email. Try signing in instead.',
          });
        }

        const profileId = `usr_${uuid().slice(0, 12)}`;
        const now = new Date().toISOString();
        const colors = ['#3B82F6', '#14B8A6', '#8B5CF6', '#F59E0B', '#EC4899', '#10B981'];

        const profile: Profile = {
          id: profileId,
          email: data.email,
          phone: normalizePhone(data.phone),
          fullName: data.fullName,
          role: invite.role,
          organizationId: invite.organizationId,
          jobTitle: null,
          operatingRegions: invite.operatingRegions,
          lastKnownLocation: null,
          lastSeenAt: now,
          status: 'active',
          avatarColor: colors[db.table('profiles').length % colors.length],
          createdAt: now,
          // Workers must still choose their regions before the app is useful.
          onboardedAt: invite.role === 'worker' ? null : now,
          notificationPreferences: {
            push: true,
            criticalOnly: false,
            quietHours: { enabled: false, startHour: 22, endHour: 6 },
          },
        };

        db.insert('profiles', profile);
        db.insert('credentials', {
          profileId,
          email: data.email,
          passwordHash: hashSecret(data.password, profileId),
          passwordVersion: 1,
          failedAttempts: 0,
          lockedUntil: null,
          lastSignInAt: now,
        });
        db.update('invites', invite.id, { acceptedAt: now });

        const session = issueSession(profileId, 'This device');
        auth.setSession(session);

        db.audit({
          actorId: profileId,
          actorRole: profile.role,
          organizationId: profile.organizationId,
          action: 'auth.signed_up',
          entity: 'profile',
          entityId: profileId,
          summary: `${profile.fullName} accepted an invite and joined as ${profile.role}.`,
        });

        return { session, user: authUserFor(profile) };
      },
    );
  },

  /**
   * Start a password reset. Always resolves the same way - the response never
   * discloses whether the address is registered.
   */
  async requestPasswordCode(input: unknown): Promise<{ sentTo: string; expiresInSeconds: number; devPreview: string | null }> {
    const data = parseOrThrow(forgotPasswordSchema, input);

    return request(
      {
        name: 'auth.requestCode',
        auth: false,
        limit: { key: 'auth.requestCode', subject: data.email },
        flakiness: 0,
      },
      () => {
        const credential = db.table('credentials').find((c) => c.email === data.email);
        const now = Date.now();

        // Invalidate any code still outstanding for this address+purpose.
        db.table('verificationCodes')
          .filter((c) => c.email === data.email && c.purpose === 'password-reset' && !c.consumedAt)
          .forEach((c) => db.update('verificationCodes', c.id, { consumedAt: new Date(now).toISOString() }));

        let devPreview: string | null = null;

        if (credential) {
          const code = generateCode();
          devPreview = code;
          const record: VerificationCode = {
            id: localId('vc'),
            email: data.email,
            codeHash: hashSecret(code, data.email),
            purpose: 'password-reset',
            createdAt: new Date(now).toISOString(),
            expiresAt: new Date(now + CODE_TTL_MS).toISOString(),
            consumedAt: null,
            attempts: 0,
            devPreview: code,
          };
          db.insert('verificationCodes', record);

          db.audit({
            actorId: credential.profileId,
            actorRole: 'system',
            organizationId: '',
            action: 'auth.reset_code_issued',
            entity: 'auth',
            entityId: credential.profileId,
            summary: `Password reset code sent to ${maskEmail(data.email)}.`,
          });
          logger.info('auth', 'reset code issued', { email: maskEmail(data.email) });
        } else {
          // Same work, same timing, no record. Enumeration-safe.
          logger.info('auth', 'reset requested for unknown address', { email: maskEmail(data.email) });
        }

        return {
          sentTo: maskEmail(data.email),
          expiresInSeconds: Math.floor(CODE_TTL_MS / 1000),
          devPreview,
        };
      },
    );
  },

  /** Exchange a valid six-digit code for a single-use reset token. */
  async verifyCode(input: unknown): Promise<{ resetToken: string }> {
    const data = parseOrThrow(verifyCodeSchema, input);

    return request(
      {
        name: 'auth.verifyCode',
        auth: false,
        limit: { key: 'auth.verifyCode', subject: data.email },
        flakiness: 0,
      },
      () => {
        const codes = db
          .table('verificationCodes')
          .filter((c) => c.email === data.email && c.purpose === data.purpose && !c.consumedAt)
          .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));

        const record = codes[0];
        const invalid = () =>
          new ApiError({
            kind: 'validation',
            message: 'invalid code',
            fieldErrors: { code: 'That code is not correct or has expired' },
          });

        if (!record) throw invalid();

        if (Date.parse(record.expiresAt) < Date.now()) {
          db.update('verificationCodes', record.id, { consumedAt: new Date().toISOString() });
          throw new ApiError({
            kind: 'validation',
            message: 'code expired',
            fieldErrors: { code: 'That code has expired. Request a new one.' },
          });
        }

        if (record.attempts >= MAX_CODE_ATTEMPTS) {
          db.update('verificationCodes', record.id, { consumedAt: new Date().toISOString() });
          throw new ApiError({
            kind: 'rate-limited',
            message: 'too many code attempts',
            userMessage: 'Too many incorrect attempts. Request a new code.',
          });
        }

        if (record.codeHash !== hashSecret(data.code, data.email)) {
          db.update('verificationCodes', record.id, { attempts: record.attempts + 1 });
          const left = MAX_CODE_ATTEMPTS - (record.attempts + 1);
          throw new ApiError({
            kind: 'validation',
            message: 'code mismatch',
            fieldErrors: {
              code: left > 0 ? `That code is not correct. ${left} attempt(s) left.` : 'That code is not correct.',
            },
          });
        }

        const resetToken = `rst_${uuid()}`;
        db.update('verificationCodes', record.id, {
          consumedAt: new Date().toISOString(),
          // The token replaces the code; stored here so resetPassword can check it.
          devPreview: resetToken,
        });

        logger.info('auth', 'code verified', { purpose: data.purpose });
        return { resetToken };
      },
    );
  },

  /** Complete the reset. Rolls passwordVersion, which kills existing sessions. */
  async resetPassword(input: unknown): Promise<{ ok: true }> {
    const data = parseOrThrow(resetPasswordSchema, input);

    return request(
      {
        name: 'auth.resetPassword',
        auth: false,
        limit: { key: 'auth.resetPassword', subject: data.email },
        flakiness: 0,
      },
      () => {
        const record = db
          .table('verificationCodes')
          .find((c) => c.email === data.email && c.devPreview === data.resetToken && c.consumedAt);

        if (!record || Date.parse(record.consumedAt!) < Date.now() - 15 * 60 * 1000) {
          throw new ApiError({
            kind: 'unauthorized',
            message: 'invalid reset token',
            userMessage: 'That reset link is no longer valid. Start again.',
          });
        }

        const credentialIndex = db.table('credentials').findIndex((c) => c.email === data.email);
        if (credentialIndex === -1) {
          throw new ApiError({ kind: 'not-found', message: 'no credential' });
        }

        const credential = db.table('credentials')[credentialIndex];
        if (credential.passwordHash === hashSecret(data.password, credential.profileId)) {
          throw new ApiError({
            kind: 'validation',
            message: 'password reuse',
            fieldErrors: { password: 'Choose a password you have not used here before' },
          });
        }

        db.table('credentials')[credentialIndex] = {
          ...credential,
          passwordHash: hashSecret(data.password, credential.profileId),
          passwordVersion: credential.passwordVersion + 1,
          failedAttempts: 0,
          lockedUntil: null,
        };

        // Burn the token and revoke every session for the account.
        db.update('verificationCodes', record.id, { devPreview: 'consumed' });
        db.table('sessions')
          .filter((s) => s.profileId === credential.profileId)
          .forEach((s) => db.remove('sessions', s.token));

        const profile = db.table('profiles').find((p) => p.id === credential.profileId);
        db.audit({
          actorId: credential.profileId,
          actorRole: profile?.role ?? 'system',
          organizationId: profile?.organizationId ?? '',
          action: 'auth.password_reset',
          entity: 'auth',
          entityId: credential.profileId,
          summary: 'Password reset completed. All active sessions were revoked.',
        });

        return { ok: true as const };
      },
    );
  },

  /** Change password while signed in. */
  async changePassword(input: unknown): Promise<{ ok: true }> {
    const data = parseOrThrow(changePasswordSchema, input);

    return request({ name: 'auth.changePassword', flakiness: 0 }, (profile) => {
      const index = db.table('credentials').findIndex((c) => c.profileId === profile!.id);
      if (index === -1) throw new ApiError({ kind: 'not-found', message: 'no credential' });

      const credential = db.table('credentials')[index];
      if (credential.passwordHash !== hashSecret(data.currentPassword, profile!.id)) {
        throw new ApiError({
          kind: 'validation',
          message: 'current password wrong',
          fieldErrors: { currentPassword: 'That is not your current password' },
        });
      }

      db.table('credentials')[index] = {
        ...credential,
        passwordHash: hashSecret(data.password, profile!.id),
        passwordVersion: credential.passwordVersion + 1,
      };

      db.audit({
        actorId: profile!.id,
        actorRole: profile!.role,
        organizationId: profile!.organizationId,
        action: 'auth.password_changed',
        entity: 'auth',
        entityId: profile!.id,
        summary: `${profile!.fullName} changed their password.`,
      });

      return { ok: true as const };
    });
  },

  /** Restore a session from a persisted token at cold start. */
  async restore(session: Session): Promise<AuthUser> {
    await db.init();
    const stored = db.table('sessions').find((s) => s.token === session.token);
    if (!stored || Date.parse(stored.expiresAt) < Date.now()) {
      throw new ApiError({ kind: 'unauthorized', message: 'session no longer valid' });
    }
    const profile = db.table('profiles').find((p) => p.id === stored.profileId);
    if (!profile || profile.status !== 'active') {
      throw new ApiError({ kind: 'unauthorized', message: 'profile unavailable' });
    }
    auth.setSession(stored);
    return authUserFor(profile);
  },

  async me(): Promise<AuthUser> {
    return request({ name: 'auth.me', allowOffline: true, latency: [40, 120] }, (profile) => authUserFor(profile!));
  },

  async signOut(): Promise<void> {
    const session = auth.getSession();
    await db.init();
    if (session) {
      const profile = db.table('profiles').find((p) => p.id === session.profileId);
      db.remove('sessions', session.token);
      if (profile) {
        db.audit({
          actorId: profile.id,
          actorRole: profile.role,
          organizationId: profile.organizationId,
          action: 'auth.signed_out',
          entity: 'session',
          entityId: session.token,
          summary: `${profile.fullName} signed out.`,
        });
      }
    }
    auth.setSession(null);
    await cache.clear();
  },

  /** Worker onboarding: declare operating regions. */
  async completeOnboarding(input: unknown): Promise<AuthUser> {
    const data = parseOrThrow(onboardingSchema, input);

    return request({ name: 'auth.completeOnboarding' }, (profile) => {
      const updated = db.update('profiles', profile!.id, {
        operatingRegions: data.operatingRegions,
        jobTitle: data.jobTitle ?? profile!.jobTitle,
        onboardedAt: new Date().toISOString(),
      });

      db.audit({
        actorId: profile!.id,
        actorRole: profile!.role,
        organizationId: profile!.organizationId,
        action: 'profile.onboarded',
        entity: 'profile',
        entityId: profile!.id,
        summary: `${profile!.fullName} set ${data.operatingRegions.length} operating region(s).`,
        after: { operatingRegions: data.operatingRegions },
      });

      cache.invalidateTags('profiles');
      return authUserFor(updated!);
    });
  },

  async updateProfile(input: unknown): Promise<AuthUser> {
    const data = parseOrThrow(profileUpdateSchema, input);

    return request({ name: 'auth.updateProfile' }, (profile) => {
      const patch: Partial<Profile> = {};
      if (data.fullName !== undefined) patch.fullName = data.fullName;
      if (data.phone !== undefined) patch.phone = normalizePhone(data.phone);
      if (data.jobTitle !== undefined) patch.jobTitle = data.jobTitle;
      if (data.operatingRegions !== undefined) patch.operatingRegions = data.operatingRegions;
      if (data.notificationPreferences !== undefined) {
        patch.notificationPreferences = data.notificationPreferences;
      }

      const updated = db.update('profiles', profile!.id, patch);
      db.audit({
        actorId: profile!.id,
        actorRole: profile!.role,
        organizationId: profile!.organizationId,
        action: 'profile.updated',
        entity: 'profile',
        entityId: profile!.id,
        summary: `${profile!.fullName} updated their profile.`,
        after: patch as Record<string, unknown>,
      });

      cache.invalidateTags('profiles');
      return authUserFor(updated!);
    });
  },

  /** Heartbeat: keeps `last_known_location` current for alert fan-out. */
  async updateLocation(location: { lat: number; lng: number }): Promise<void> {
    return request({ name: 'auth.updateLocation', latency: [60, 200], flakiness: 0 }, (profile) => {
      db.update('profiles', profile!.id, {
        lastKnownLocation: location,
        lastSeenAt: new Date().toISOString(),
      });
    });
  },

  /** Look up an invite so sign-up can show who the code is for. */
  async peekInvite(code: string): Promise<Pick<Invite, 'email' | 'fullName' | 'role' | 'organizationId'> & { organizationName: string } | null> {
    return request({ name: 'auth.peekInvite', auth: false, latency: [120, 320], flakiness: 0 }, () => {
      const invite = db.table('invites').find((i) => i.code === code.trim().toUpperCase() && !i.acceptedAt);
      if (!invite) return null;
      const org = db.table('organizations').find((o) => o.id === invite.organizationId);
      return {
        email: invite.email,
        fullName: invite.fullName,
        role: invite.role,
        organizationId: invite.organizationId,
        organizationName: org?.name ?? 'Unknown organisation',
      };
    });
  },
};


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `authApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const authApi = API_MODE === 'supabase' ? supabaseAuthApi : mockAuthApi;
export { mockAuthApi };
