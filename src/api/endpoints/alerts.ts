import { REGIONS_BY_ID } from '@/constants/regions';
import { SEVERITY_META, THREAT_META, severityRank } from '@/constants/threats';
import { distanceMeters } from '@/lib/geo';
import { uuid } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { advisorySchema, parseOrThrow, sanitizeText } from '@/lib/validation';
import { assertOrgVisible, request, requireRole } from '../client';
import { cache } from '../cache';
import { db } from '../db';
import { ApiError } from '../errors';
import type { MatchReason, NotificationRecord, Profile, SafetyAlert, ThreatReport } from '../types';
import { API_MODE } from '../supabase/client';
import { supabaseAlertsApi } from '../supabase/alerts';

/**
 * Alerting.
 *
 * `fanOut` is the heart of the product. A worker is notified when ANY of these
 * hold, and the reasons are carried into the notification so the recipient can
 * see why they were told - "you are inside the 12 km radius" is actionable in a
 * way that an unexplained alert is not:
 *
 *   - same organisation as the report
 *   - a cross-share partner of the reporting organisation
 *   - their last known position is inside the alert radius
 *   - the threat falls inside one of their declared operating regions
 *
 * Admins are excluded by default: they manage the organisation, they are not
 * the people in the field, and paging them on every incident trains everyone to
 * ignore alerts.
 */

type FanOutResult = { alert: SafetyAlert; notifications: NotificationRecord[] };

function matchProfile(
  profile: Profile,
  alert: Pick<SafetyAlert, 'organizationId' | 'location' | 'radiusMeters' | 'regionIds'>,
  partnerIds: string[],
): { reasons: MatchReason[]; distance: number | null } {
  const reasons: MatchReason[] = [];

  if (profile.organizationId === alert.organizationId) reasons.push('same-organization');
  else if (partnerIds.includes(profile.organizationId)) reasons.push('partner-organization');

  let distance: number | null = null;
  if (alert.location && profile.lastKnownLocation) {
    distance = Math.round(distanceMeters(alert.location, profile.lastKnownLocation));
    if (alert.radiusMeters && distance <= alert.radiusMeters) reasons.push('within-alert-radius');
  }

  const declaredMatch = alert.regionIds.some((r) => profile.operatingRegions.includes(r));
  const geographicMatch =
    !!alert.location &&
    profile.operatingRegions.some((rid) => {
      const region = REGIONS_BY_ID[rid];
      return region && distanceMeters(region.center, alert.location!) <= region.radiusMeters;
    });

  if (declaredMatch || geographicMatch) reasons.push('operating-region');

  return { reasons, distance };
}

/** Respect quiet hours, but never for a critical alert. */
function suppressedByQuietHours(profile: Profile, severity: SafetyAlert['severity']): boolean {
  const quiet = profile.notificationPreferences.quietHours;
  if (!quiet.enabled) return false;
  if (severity === 'critical') return false;

  const hour = new Date().getHours();
  const { startHour, endHour } = quiet;
  const inWindow = startHour <= endHour ? hour >= startHour && hour < endHour : hour >= startHour || hour < endHour;
  return inWindow;
}

function deliver(alert: SafetyAlert, exclude: string[] = []): NotificationRecord[] {
  const org = db.table('organizations').find((o) => o.id === alert.organizationId);
  const partnerIds = org?.crossSharePartners ?? [];
  const created: NotificationRecord[] = [];

  for (const profile of db.table('profiles')) {
    if (profile.status !== 'active') continue;
    if (profile.role === 'admin') continue;
    if (exclude.includes(profile.id)) continue;

    const { reasons, distance } = matchProfile(profile, alert, partnerIds);
    if (!reasons.length) continue;

    // A worker who only wants criticals still gets everything in their radius -
    // proximity outranks preference when it is about their own safety.
    if (
      profile.notificationPreferences.criticalOnly &&
      severityRank(alert.severity) < 3 &&
      !reasons.includes('within-alert-radius')
    ) {
      continue;
    }

    const record: NotificationRecord = {
      id: `ntf_${uuid().slice(0, 12)}`,
      profileId: profile.id,
      alertId: alert.id,
      reportId: alert.relatedReportId,
      title: alert.title,
      body: alert.message,
      severity: alert.severity,
      matchReasons: reasons,
      distanceMeters: distance,
      deliveredAt: new Date().toISOString(),
      readAt: null,
    };

    db.insert('notifications', record);
    created.push(record);

    if (suppressedByQuietHours(profile, alert.severity)) {
      logger.debug('alerts', 'push suppressed by quiet hours', { profileId: profile.id });
    }
  }

  db.update('alerts', alert.id, { recipientCount: created.length });
  logger.info('alerts', 'fan-out complete', { alertId: alert.id, recipients: created.length });
  return created;
}

const mockAlertsApi = {
  /** Called by reports.verify. Creates the alert row and fans it out. */
  async fanOutForReport(report: ThreatReport, officer: Profile): Promise<FanOutResult> {
    if (!report.severity || !report.threatType) {
      throw new ApiError({ kind: 'server', message: 'cannot alert on an unclassified report' });
    }

    const meta = THREAT_META[report.threatType];
    const now = new Date();

    const alert: SafetyAlert = {
      id: `alt_${uuid().slice(0, 12)}`,
      issuedBy: officer.id,
      organizationId: report.organizationId,
      relatedReportId: report.id,
      title: `${meta.label} near ${report.placeLabel ?? 'your area'}`,
      message: `${report.aiSuggestions?.summary ?? meta.label}. ${SEVERITY_META[report.severity].guidance}`,
      severity: report.severity,
      threatType: report.threatType,
      location: report.location,
      radiusMeters: report.alertRadiusMeters,
      regionIds: report.regionId ? [report.regionId] : [],
      kind: 'threat',
      createdAt: now.toISOString(),
      // 72 h is long enough to stay useful and short enough that a stale threat
      // stops competing for attention with a live one.
      expiresAt: new Date(now.getTime() + 72 * 3_600_000).toISOString(),
      cancelledAt: null,
      recipientCount: 0,
    };

    db.insert('alerts', alert);

    // The reporter already knows; alerting them adds noise, not safety.
    const notifications = deliver(alert, [report.reporterId]);

    db.audit({
      actorId: officer.id,
      actorRole: 'officer',
      organizationId: report.organizationId,
      action: 'alert.fanout',
      entity: 'alert',
      entityId: alert.id,
      summary: `Alert for ${report.reference} delivered to ${notifications.length} worker(s) within ${(
        (report.alertRadiusMeters ?? 0) / 1000
      ).toFixed(1)} km and matching regions.`,
    });

    cache.invalidateTags('alerts', 'notifications');
    return { alert: db.find('alerts', alert.id)!, notifications };
  },

  /** Standalone advisory, not tied to a report. Officers only. */
  async createAdvisory(input: unknown): Promise<SafetyAlert> {
    const data = parseOrThrow(advisorySchema, input);

    return request({ name: 'alerts.createAdvisory', limit: { key: 'alerts.create' } }, (profile) => {
      requireRole(profile!, 'officer');

      const now = new Date();
      const alert: SafetyAlert = {
        id: `alt_${uuid().slice(0, 12)}`,
        issuedBy: profile!.id,
        organizationId: profile!.organizationId,
        relatedReportId: null,
        title: sanitizeText(data.title),
        message: sanitizeText(data.message),
        severity: data.severity,
        threatType: data.threatType,
        location: data.location,
        radiusMeters: data.radiusMeters,
        regionIds: data.regionIds,
        kind: 'advisory',
        createdAt: now.toISOString(),
        expiresAt: new Date(now.getTime() + data.expiresInHours * 3_600_000).toISOString(),
        cancelledAt: null,
        recipientCount: 0,
      };

      db.insert('alerts', alert);

      // Cross-share is opt-in per advisory: not every internal instruction
      // should land on a partner organisation's phones.
      if (!data.shareWithPartners) {
        const org = db.table('organizations').find((o) => o.id === profile!.organizationId);
        const partnerWorkerIds = db
          .table('profiles')
          .filter((p) => org?.crossSharePartners.includes(p.organizationId))
          .map((p) => p.id);
        deliver(alert, partnerWorkerIds);
      } else {
        deliver(alert);
      }

      db.audit({
        actorId: profile!.id,
        actorRole: 'officer',
        organizationId: profile!.organizationId,
        action: 'alert.advisory_issued',
        entity: 'alert',
        entityId: alert.id,
        summary: `${profile!.fullName} issued advisory "${alert.title}" (${data.severity}) to ${
          db.find('alerts', alert.id)?.recipientCount ?? 0
        } recipient(s)${data.shareWithPartners ? ', shared with partners' : ''}.`,
      });

      cache.invalidateTags('alerts', 'notifications');
      return db.find('alerts', alert.id)!;
    });
  },

  /** Withdraw an advisory that no longer applies. */
  async cancel(alertId: string, reason: string): Promise<SafetyAlert> {
    return request({ name: 'alerts.cancel' }, (profile) => {
      requireRole(profile!, 'officer');
      const alert = db.find('alerts', alertId);
      if (!alert) throw new ApiError({ kind: 'not-found', message: 'alert' });
      assertOrgVisible(profile!, alert.organizationId);
      if (alert.cancelledAt) {
        throw new ApiError({ kind: 'conflict', message: 'already cancelled' });
      }

      const updated = db.update('alerts', alertId, { cancelledAt: new Date().toISOString() })!;
      db.audit({
        actorId: profile!.id,
        actorRole: 'officer',
        organizationId: alert.organizationId,
        action: 'alert.cancelled',
        entity: 'alert',
        entityId: alertId,
        summary: `${profile!.fullName} withdrew "${alert.title}": ${sanitizeText(reason)}`,
      });

      cache.invalidateTags('alerts', 'notifications');
      return updated;
    });
  },

  /** Alerts issued by the viewer's org (and partners), newest first. */
  async list(options: { includeExpired?: boolean } = {}): Promise<SafetyAlert[]> {
    return request({ name: 'alerts.list' }, (profile) => {
      const org = db.table('organizations').find((o) => o.id === profile!.organizationId);
      const partners = org?.crossSharePartners ?? [];
      const now = Date.now();

      return db
        .table('alerts')
        .filter((a) => a.organizationId === profile!.organizationId || partners.includes(a.organizationId))
        .filter((a) => options.includeExpired || (!a.cancelledAt && (!a.expiresAt || Date.parse(a.expiresAt) > now)))
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    });
  },

  /** The signed-in worker's persistent alert feed. */
  async feed(limit = 60): Promise<{ notification: NotificationRecord; alert: SafetyAlert | null }[]> {
    return request({ name: 'alerts.feed' }, (profile) =>
      db
        .table('notifications')
        .filter((n) => n.profileId === profile!.id)
        .sort((a, b) => Date.parse(b.deliveredAt) - Date.parse(a.deliveredAt))
        .slice(0, limit)
        .map((notification) => ({
          notification,
          alert: db.find('alerts', notification.alertId) ?? null,
        })),
    );
  },

  async unreadCount(): Promise<number> {
    return request({ name: 'alerts.unreadCount', latency: [40, 140], flakiness: 0 }, (profile) =>
      db.table('notifications').filter((n) => n.profileId === profile!.id && !n.readAt).length,
    );
  },

  async markRead(notificationId: string): Promise<void> {
    return request({ name: 'alerts.markRead', latency: [50, 160], flakiness: 0 }, (profile) => {
      const record = db.find('notifications', notificationId);
      if (!record || record.profileId !== profile!.id) {
        throw new ApiError({ kind: 'not-found', message: 'notification' });
      }
      if (!record.readAt) db.update('notifications', notificationId, { readAt: new Date().toISOString() });
      cache.invalidateTags('notifications');
    });
  },

  async markAllRead(): Promise<number> {
    return request({ name: 'alerts.markAllRead', flakiness: 0 }, (profile) => {
      const now = new Date().toISOString();
      const unread = db.table('notifications').filter((n) => n.profileId === profile!.id && !n.readAt);
      unread.forEach((n) => db.update('notifications', n.id, { readAt: now }));
      cache.invalidateTags('notifications');
      return unread.length;
    });
  },

  /** Preview the fan-out before issuing - officers should know the blast radius. */
  async previewRecipients(input: {
    organizationId: string;
    location: { lat: number; lng: number } | null;
    radiusMeters: number | null;
    regionIds: string[];
    shareWithPartners: boolean;
  }): Promise<{ total: number; byReason: Record<MatchReason, number>; sample: { name: string; reasons: MatchReason[]; distanceMeters: number | null }[] }> {
    return request({ name: 'alerts.previewRecipients', latency: [80, 220], flakiness: 0 }, (profile) => {
      requireRole(profile!, 'officer');
      const org = db.table('organizations').find((o) => o.id === input.organizationId);
      const partnerIds = input.shareWithPartners ? org?.crossSharePartners ?? [] : [];

      const byReason: Record<MatchReason, number> = {
        'same-organization': 0,
        'partner-organization': 0,
        'within-alert-radius': 0,
        'operating-region': 0,
        'direct-advisory': 0,
      };

      const matches: { name: string; reasons: MatchReason[]; distanceMeters: number | null }[] = [];

      for (const candidate of db.table('profiles')) {
        if (candidate.status !== 'active' || candidate.role === 'admin') continue;
        const { reasons, distance } = matchProfile(
          candidate,
          {
            organizationId: input.organizationId,
            location: input.location,
            radiusMeters: input.radiusMeters,
            regionIds: input.regionIds,
          },
          partnerIds,
        );
        if (!reasons.length) continue;
        reasons.forEach((r) => (byReason[r] += 1));
        matches.push({ name: candidate.fullName, reasons, distanceMeters: distance });
      }

      return { total: matches.length, byReason, sample: matches.slice(0, 6) };
    });
  },
};


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `alertsApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const alertsApi = API_MODE === 'supabase' ? supabaseAlertsApi : mockAlertsApi;
export { mockAlertsApi };
