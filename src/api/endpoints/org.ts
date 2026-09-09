import { uuid } from '@/lib/ids';
import { inviteSchema, organizationUpdateSchema, parseOrThrow } from '@/lib/validation';
import { request, requireRole } from '../client';
import { cache } from '../cache';
import { db } from '../db';
import { ApiError } from '../errors';
import type { AuditEntry, Invite, Organization, Profile, Role } from '../types';
import { API_MODE } from '../supabase/client';
import { supabaseOrgApi } from '../supabase/org';

/**
 * Organisation and people management. Admin-only, by design.
 *
 * The separation of duties is the point: an admin can create the officer who
 * verifies a report, but cannot verify it themselves, and cannot issue an
 * alert. That keeps the verification chain auditable - no single account can
 * both create the authority and exercise it.
 */

function inviteCode(acronym: string): string {
  return `${acronym.toUpperCase().slice(0, 4)}-${String(Math.floor(1000 + Math.random() * 9000))}`;
}

const mockOrgApi = {
  async get(): Promise<Organization> {
    return request({ name: 'org.get' }, (profile) => {
      const org = db.find('organizations', profile!.organizationId);
      if (!org) throw new ApiError({ kind: 'not-found', message: 'organization' });
      return org;
    });
  },

  async update(input: unknown): Promise<Organization> {
    const data = parseOrThrow(organizationUpdateSchema, input);

    return request({ name: 'org.update' }, (profile) => {
      requireRole(profile!, 'admin');
      const before = db.find('organizations', profile!.organizationId);
      if (!before) throw new ApiError({ kind: 'not-found', message: 'organization' });

      const updated = db.update('organizations', before.id, data)!;

      // Cross-share is reciprocal: a one-sided partnership would mean one org
      // seeing the other's threats without contributing its own.
      if (data.crossSharePartners) {
        for (const partnerId of data.crossSharePartners) {
          const partner = db.find('organizations', partnerId);
          if (partner && !partner.crossSharePartners.includes(before.id)) {
            db.update('organizations', partnerId, {
              crossSharePartners: [...partner.crossSharePartners, before.id],
            });
          }
        }
        for (const removedId of before.crossSharePartners.filter((p) => !data.crossSharePartners!.includes(p))) {
          const partner = db.find('organizations', removedId);
          if (partner) {
            db.update('organizations', removedId, {
              crossSharePartners: partner.crossSharePartners.filter((p) => p !== before.id),
            });
          }
        }
      }

      db.audit({
        actorId: profile!.id,
        actorRole: 'admin',
        organizationId: before.id,
        action: 'organization.updated',
        entity: 'organization',
        entityId: before.id,
        summary: `${profile!.fullName} updated the organisation profile.`,
        before: { regions: before.regions, crossSharePartners: before.crossSharePartners },
        after: data as Record<string, unknown>,
      });

      cache.invalidateTags('org');
      return updated;
    });
  },

  /** Every organisation, for the partnership picker. */
  async listOrganizations(): Promise<Organization[]> {
    return request({ name: 'org.listOrganizations' }, (profile) => {
      requireRole(profile!, 'admin');
      return db.table('organizations').filter((o) => o.id !== profile!.organizationId);
    });
  },

  async members(): Promise<Profile[]> {
    return request({ name: 'org.members' }, (profile) => {
      requireRole(profile!, 'admin', 'officer');
      return db
        .table('profiles')
        .filter((p) => p.organizationId === profile!.organizationId)
        .sort((a, b) => a.fullName.localeCompare(b.fullName));
    });
  },

  async invites(): Promise<Invite[]> {
    return request({ name: 'org.invites' }, (profile) => {
      requireRole(profile!, 'admin');
      return db
        .table('invites')
        .filter((i) => i.organizationId === profile!.organizationId)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    });
  },

  async createInvite(input: unknown): Promise<Invite> {
    const data = parseOrThrow(inviteSchema, input);

    return request({ name: 'org.createInvite', limit: { key: 'invites.create' } }, (profile) => {
      requireRole(profile!, 'admin');

      if (db.table('profiles').some((p) => p.email === data.email)) {
        throw new ApiError({
          kind: 'conflict',
          message: 'email in use',
          userMessage: 'Someone with that email already has an account.',
        });
      }
      const outstanding = db.table('invites').find((i) => i.email === data.email && !i.acceptedAt);
      if (outstanding) {
        throw new ApiError({
          kind: 'conflict',
          message: 'invite outstanding',
          userMessage: `An unused invite for that address already exists (code ${outstanding.code}).`,
        });
      }

      const org = db.find('organizations', profile!.organizationId)!;
      const invite: Invite = {
        id: `inv_${uuid().slice(0, 12)}`,
        email: data.email,
        fullName: data.fullName,
        role: data.role,
        organizationId: profile!.organizationId,
        invitedBy: profile!.id,
        createdAt: new Date().toISOString(),
        acceptedAt: null,
        expiresAt: new Date(Date.now() + 7 * 86_400_000).toISOString(),
        code: inviteCode(org.acronym),
        operatingRegions: data.operatingRegions,
      };

      db.insert('invites', invite);
      db.audit({
        actorId: profile!.id,
        actorRole: 'admin',
        organizationId: profile!.organizationId,
        action: 'invite.created',
        entity: 'profile',
        entityId: invite.id,
        summary: `${profile!.fullName} invited ${data.fullName} as ${data.role}.`,
      });

      cache.invalidateTags('org');
      return invite;
    });
  },

  async revokeInvite(inviteId: string): Promise<void> {
    return request({ name: 'org.revokeInvite' }, (profile) => {
      requireRole(profile!, 'admin');
      const invite = db.find('invites', inviteId);
      if (!invite || invite.organizationId !== profile!.organizationId) {
        throw new ApiError({ kind: 'not-found', message: 'invite' });
      }
      if (invite.acceptedAt) {
        throw new ApiError({ kind: 'conflict', message: 'already accepted', userMessage: 'That invite has already been used.' });
      }

      db.remove('invites', inviteId);
      db.audit({
        actorId: profile!.id,
        actorRole: 'admin',
        organizationId: profile!.organizationId,
        action: 'invite.revoked',
        entity: 'profile',
        entityId: inviteId,
        summary: `${profile!.fullName} revoked the invite for ${invite.fullName}.`,
      });
      cache.invalidateTags('org');
    });
  },

  /**
   * Change someone's role. Guarded so an organisation cannot be left without an
   * admin, and so nobody can quietly promote themselves.
   */
  async setRole(profileId: string, role: Role): Promise<Profile> {
    return request({ name: 'org.setRole' }, (profile) => {
      requireRole(profile!, 'admin');

      const target = db.find('profiles', profileId);
      if (!target || target.organizationId !== profile!.organizationId) {
        throw new ApiError({ kind: 'not-found', message: 'profile' });
      }
      if (target.id === profile!.id) {
        throw new ApiError({
          kind: 'forbidden',
          message: 'self role change',
          userMessage: 'You cannot change your own role. Ask another admin.',
        });
      }

      const adminsLeft = db
        .table('profiles')
        .filter((p) => p.organizationId === profile!.organizationId && p.role === 'admin' && p.status === 'active');
      if (target.role === 'admin' && role !== 'admin' && adminsLeft.length <= 1) {
        throw new ApiError({
          kind: 'conflict',
          message: 'last admin',
          userMessage: 'An organisation must keep at least one active admin.',
        });
      }

      const updated = db.update('profiles', profileId, { role })!;
      db.audit({
        actorId: profile!.id,
        actorRole: 'admin',
        organizationId: profile!.organizationId,
        action: 'profile.role_changed',
        entity: 'profile',
        entityId: profileId,
        summary: `${profile!.fullName} changed ${target.fullName} from ${target.role} to ${role}.`,
        before: { role: target.role },
        after: { role },
      });

      cache.invalidateTags('org', 'profiles');
      return updated;
    });
  },

  async setStatus(profileId: string, status: Profile['status']): Promise<Profile> {
    return request({ name: 'org.setStatus' }, (profile) => {
      requireRole(profile!, 'admin');

      const target = db.find('profiles', profileId);
      if (!target || target.organizationId !== profile!.organizationId) {
        throw new ApiError({ kind: 'not-found', message: 'profile' });
      }
      if (target.id === profile!.id) {
        throw new ApiError({
          kind: 'forbidden',
          message: 'self deactivate',
          userMessage: 'You cannot deactivate your own account.',
        });
      }

      const activeAdmins = db
        .table('profiles')
        .filter((p) => p.organizationId === profile!.organizationId && p.role === 'admin' && p.status === 'active');
      if (target.role === 'admin' && status !== 'active' && activeAdmins.length <= 1) {
        throw new ApiError({
          kind: 'conflict',
          message: 'last admin',
          userMessage: 'An organisation must keep at least one active admin.',
        });
      }

      // Deactivation revokes sessions immediately - this is the control used
      // when a device is lost or a member leaves.
      if (status === 'deactivated') {
        db.table('sessions')
          .filter((s) => s.profileId === profileId)
          .forEach((s) => db.remove('sessions', s.token));
      }

      const updated = db.update('profiles', profileId, { status })!;
      db.audit({
        actorId: profile!.id,
        actorRole: 'admin',
        organizationId: profile!.organizationId,
        action: status === 'deactivated' ? 'profile.deactivated' : 'profile.reactivated',
        entity: 'profile',
        entityId: profileId,
        summary: `${profile!.fullName} set ${target.fullName} to ${status}.${
          status === 'deactivated' ? ' All their sessions were revoked.' : ''
        }`,
        before: { status: target.status },
        after: { status },
      });

      cache.invalidateTags('org', 'profiles');
      return updated;
    });
  },

  async setMemberRegions(profileId: string, regionIds: string[]): Promise<Profile> {
    return request({ name: 'org.setMemberRegions' }, (profile) => {
      requireRole(profile!, 'admin');
      const target = db.find('profiles', profileId);
      if (!target || target.organizationId !== profile!.organizationId) {
        throw new ApiError({ kind: 'not-found', message: 'profile' });
      }

      const updated = db.update('profiles', profileId, { operatingRegions: regionIds })!;
      db.audit({
        actorId: profile!.id,
        actorRole: 'admin',
        organizationId: profile!.organizationId,
        action: 'profile.regions_changed',
        entity: 'profile',
        entityId: profileId,
        summary: `${profile!.fullName} set ${target.fullName}'s operating regions (${regionIds.length}).`,
        before: { operatingRegions: target.operatingRegions },
        after: { operatingRegions: regionIds },
      });

      cache.invalidateTags('org', 'profiles');
      return updated;
    });
  },

  /**
   * The audit log. Admins see their whole organisation; officers see it too,
   * because verification is a shared accountability, not a private one.
   */
  async auditLog(options: { limit?: number; entity?: AuditEntry['entity']; actorId?: string; search?: string } = {}): Promise<AuditEntry[]> {
    return request({ name: 'org.auditLog' }, (profile) => {
      requireRole(profile!, 'admin', 'officer');
      let entries = db.table('audit').filter((a) => a.organizationId === profile!.organizationId || a.organizationId === '');

      if (options.entity) entries = entries.filter((a) => a.entity === options.entity);
      if (options.actorId) entries = entries.filter((a) => a.actorId === options.actorId);
      if (options.search) {
        const q = options.search.toLowerCase();
        entries = entries.filter((a) => a.summary.toLowerCase().includes(q) || a.action.toLowerCase().includes(q));
      }

      return entries.sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts)).slice(0, options.limit ?? 100);
    });
  },

  /** Resolve display names for ids referenced across the UI. */
  async directory(): Promise<Record<string, { name: string; role: Role; color: string; organizationId: string }>> {
    return request({ name: 'org.directory', allowOffline: true, latency: [60, 180], flakiness: 0 }, () => {
      const out: Record<string, { name: string; role: Role; color: string; organizationId: string }> = {};
      for (const p of db.table('profiles')) {
        out[p.id] = { name: p.fullName, role: p.role, color: p.avatarColor, organizationId: p.organizationId };
      }
      out.anonymous = { name: 'Anonymous reporter', role: 'worker', color: '#5C6C89', organizationId: '' };
      out.system = { name: 'Safe Route AI', role: 'admin', color: '#3B82F6', organizationId: '' };
      return out;
    });
  },
};


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `orgApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const orgApi = API_MODE === 'supabase' ? supabaseOrgApi : mockOrgApi;
export { mockOrgApi };
