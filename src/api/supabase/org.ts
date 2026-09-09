import { inviteSchema, organizationUpdateSchema, parseOrThrow } from '@/lib/validation';
import { ApiError } from '../errors';
import { rateLimiter } from '../rateLimit';
import type { AuditEntry, Invite, Organization, Profile, Role } from '../types';
import { call, deniedOrMissing } from './call';
import { supabase } from './client';
import { mapAudit, mapInvite, mapOrganization, mapProfile } from './mappers';

const PROFILE_SELECT = '*, lat, lng';

async function myOrgId(): Promise<string> {
  const { data } = await supabase().auth.getUser();
  if (!data.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

  const row = await call('org.myOrg', () =>
    supabase().from('profiles').select('organization_id').eq('id', data.user!.id).maybeSingle(),
  );
  if (!row) throw deniedOrMissing('profile');
  return row.organization_id;
}

function inviteCode(acronym: string): string {
  return `${acronym.toUpperCase().slice(0, 4)}-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

export const supabaseOrgApi = {
  async get(): Promise<Organization> {
    const orgId = await myOrgId();
    const row = await call('org.get', () =>
      supabase().from('organizations').select('*').eq('id', orgId).maybeSingle(),
    );
    if (!row) throw deniedOrMissing('organization');
    return mapOrganization(row);
  },

  async update(input: unknown): Promise<Organization> {
    const data = parseOrThrow(organizationUpdateSchema, input);
    const orgId = await myOrgId();

    const patch: Record<string, unknown> = {};
    if (data.name !== undefined) patch.name = data.name;
    if (data.contactEmail !== undefined) patch.contact_email = data.contactEmail;
    if (data.regions !== undefined) patch.regions = data.regions;
    if (data.crossSharePartners !== undefined) patch.cross_share_partners = data.crossSharePartners;
    if (data.settings !== undefined) patch.settings = data.settings;

    const row = await call('org.update', () =>
      supabase().from('organizations').update(patch).eq('id', orgId).select('*').maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'org update rejected',
        userMessage: 'Only an organisation admin can change these settings.',
      });
    }
    // Reciprocity is mirrored by a database trigger, so no second write here.
    return mapOrganization(row);
  },

  async listOrganizations(): Promise<Organization[]> {
    const orgId = await myOrgId();
    const rows = await call('org.listOrganizations', () =>
      supabase().from('organizations').select('*').neq('id', orgId).order('name'),
    );
    return (rows ?? []).map(mapOrganization);
  },

  async members(): Promise<Profile[]> {
    const rows = await call('org.members', () =>
      supabase().from('profiles').select(PROFILE_SELECT).order('full_name'),
    );
    return (rows ?? []).map(mapProfile);
  },

  async invites(): Promise<Invite[]> {
    const rows = await call('org.invites', () =>
      supabase().from('invites').select('*').order('created_at', { ascending: false }),
    );
    return (rows ?? []).map(mapInvite);
  },

  async createInvite(input: unknown): Promise<Invite> {
    const data = parseOrThrow(inviteSchema, input);
    await rateLimiter.consume('invites.create');

    const { data: me } = await supabase().auth.getUser();
    if (!me.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

    const orgId = await myOrgId();
    const org = await call('org.acronym', () =>
      supabase().from('organizations').select('acronym').eq('id', orgId).maybeSingle(),
    );

    const row = await call('org.createInvite', () =>
      supabase()
        .from('invites')
        .insert({
          email: data.email,
          full_name: data.fullName,
          role: data.role,
          organization_id: orgId,
          invited_by: me.user!.id,
          code: inviteCode(org?.acronym ?? 'ORG'),
          operating_regions: data.operatingRegions,
          expires_at: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        })
        .select('*')
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'invite rejected',
        userMessage: 'Only an organisation admin can invite people.',
      });
    }
    return mapInvite(row);
  },

  async revokeInvite(inviteId: string): Promise<void> {
    const row = await call('org.revokeInvite', () =>
      supabase().from('invites').delete().eq('id', inviteId).is('accepted_at', null).select('id').maybeSingle(),
    );
    if (!row) {
      throw new ApiError({
        kind: 'conflict',
        message: 'revoke rejected',
        userMessage: 'That invite has already been used, or you cannot revoke it.',
      });
    }
  },

  /**
   * Role changes. The last-admin guard and the self-promotion guard both live
   * in a database trigger, so their messages come back verbatim.
   */
  async setRole(profileId: string, role: Role): Promise<Profile> {
    const row = await call('org.setRole', () =>
      supabase().from('profiles').update({ role }).eq('id', profileId).select(PROFILE_SELECT).maybeSingle(),
    );
    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'role change rejected',
        userMessage: 'Only an organisation admin can change roles.',
      });
    }
    return mapProfile(row);
  },

  async setStatus(profileId: string, status: Profile['status']): Promise<Profile> {
    const row = await call('org.setStatus', () =>
      supabase().from('profiles').update({ status }).eq('id', profileId).select(PROFILE_SELECT).maybeSingle(),
    );
    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'status change rejected',
        userMessage: 'Only an organisation admin can deactivate or reactivate an account.',
      });
    }
    return mapProfile(row);
  },

  async setMemberRegions(profileId: string, regionIds: string[]): Promise<Profile> {
    const row = await call('org.setMemberRegions', () =>
      supabase()
        .from('profiles')
        .update({ operating_regions: regionIds })
        .eq('id', profileId)
        .select(PROFILE_SELECT)
        .maybeSingle(),
    );
    if (!row) throw deniedOrMissing('region update rejected');
    return mapProfile(row);
  },

  async auditLog(
    options: { limit?: number; entity?: AuditEntry['entity']; actorId?: string; search?: string } = {},
  ): Promise<AuditEntry[]> {
    let query = supabase().from('audit_log').select('*').order('ts', { ascending: false });

    if (options.entity) query = query.eq('entity', options.entity);
    if (options.actorId) query = query.eq('actor_id', options.actorId);
    if (options.search) {
      const q = options.search.replace(/[%,()]/g, '');
      query = query.or(`summary.ilike.%${q}%,action.ilike.%${q}%`);
    }

    const rows = await call('org.auditLog', () => query.limit(options.limit ?? 100));
    return (rows ?? []).map(mapAudit);
  },

  /** Name/colour lookup for ids referenced across the UI. */
  async directory(): Promise<Record<string, { name: string; role: Role; color: string; organizationId: string }>> {
    const rows = await call('org.directory', () =>
      supabase().from('profiles').select('id, full_name, role, avatar_color, organization_id'),
    );

    const out: Record<string, { name: string; role: Role; color: string; organizationId: string }> = {};
    for (const p of rows ?? []) {
      out[p.id] = {
        name: p.full_name,
        role: p.role,
        color: p.avatar_color ?? '#3B82F6',
        organizationId: p.organization_id,
      };
    }
    out.anonymous = { name: 'Anonymous reporter', role: 'worker', color: '#5C6C89', organizationId: '' };
    out.system = { name: 'Safe Route AI', role: 'admin', color: '#3B82F6', organizationId: '' };
    return out;
  },
};
