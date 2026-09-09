import { SEVERITIES, THREAT_TYPES, highestSeverity, type Severity } from '@/constants/threats';
import { request, requireRole } from '../client';
import { cache, cacheKey, POLICY } from '../cache';
import { db } from '../db';
import type { Analytics, Profile, ThreatReport } from '../types';
import { API_MODE } from '../supabase/client';
import { supabaseAnalyticsApi } from '../supabase/analytics';

/**
 * Organisation analytics.
 *
 * These are the numbers that tell an operations manager whether the system is
 * working, so the choice of metric matters more than the chart:
 *
 *  - **Median and p90 verification time** - how long a threat sits unverified.
 *    That gap is the window in which the app is silently failing its purpose.
 *  - **AI agreement rate** - how often officers accepted the model unchanged.
 *    Too low means the AI is noise; suspiciously high means officers may be
 *    rubber-stamping, which is the failure mode that would make the human
 *    verification requirement meaningless.
 *  - **Duplicates caught** - the reporting load the AI removed from officers.
 *  - **SOS acknowledgement time** - the one number with a life attached to it.
 */

function median(values: number[]): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
}

function percentile(values: number[], p: number): number {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))];
}

function dayKey(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

const mockAnalyticsApi = {
  async overview(windowHours = 24 * 30): Promise<Analytics> {
    return request({ name: 'analytics.overview', latency: [300, 900] }, (profile) => {
      requireRole(profile!, 'admin', 'officer');

      const cutoff = Date.now() - windowHours * 3_600_000;
      const orgId = profile!.organizationId;

      const reports = db
        .table('reports')
        .filter((r) => r.organizationId === orgId && Date.parse(r.createdAt) >= cutoff);

      const verified = reports.filter((r) => r.status === 'verified');
      const dismissed = reports.filter((r) => r.status === 'dismissed');
      const pending = reports.filter((r) => r.status === 'pending');

      const alerts = db
        .table('alerts')
        .filter((a) => a.organizationId === orgId && Date.parse(a.createdAt) >= cutoff);

      const sosEvents = db
        .table('sosEvents')
        .filter((e) => e.organizationId === orgId && Date.parse(e.createdAt) >= cutoff);

      // --- Verification latency -------------------------------------------
      const verificationTimes = reports
        .filter((r) => r.verifiedAt)
        .map((r) => Date.parse(r.verifiedAt!) - Date.parse(r.createdAt))
        .filter((ms) => ms >= 0);

      // --- SOS acknowledgement latency ------------------------------------
      const ackTimes = sosEvents
        .filter((e) => e.acknowledgedAt)
        .map((e) => Date.parse(e.acknowledgedAt!) - Date.parse(e.createdAt))
        .filter((ms) => ms >= 0);

      // --- AI agreement ----------------------------------------------------
      const comparable = verified.filter((r) => r.aiSuggestions && r.severity && r.threatType);
      const agreed = comparable.filter(
        (r) => r.aiSuggestions!.severity === r.severity && r.aiSuggestions!.threatType === r.threatType,
      );

      const duplicatesCaught = reports.filter(
        (r) => r.status === 'dismissed' && r.possibleDuplicateOf !== null,
      ).length;

      // --- Daily series ----------------------------------------------------
      const days = Math.min(90, Math.max(1, Math.ceil(windowHours / 24)));
      const series: Analytics['reportsByDay'] = [];
      for (let i = days - 1; i >= 0; i -= 1) {
        const date = dayKey(Date.now() - i * 86_400_000);
        const forDay = reports.filter((r) => dayKey(Date.parse(r.createdAt)) === date);
        series.push({
          date,
          total: forDay.length,
          verified: forDay.filter((r) => r.status === 'verified').length,
          dismissed: forDay.filter((r) => r.status === 'dismissed').length,
        });
      }

      // --- Breakdowns ------------------------------------------------------
      const bySeverity = SEVERITIES.map((severity) => ({
        severity,
        count: verified.filter((r) => r.severity === severity).length,
      }));

      const byType = THREAT_TYPES.map((type) => ({
        type,
        count: verified.filter((r) => r.threatType === type).length,
      }))
        .filter((t) => t.count > 0)
        .sort((a, b) => b.count - a.count);

      const regionMap = new Map<string, ThreatReport[]>();
      for (const report of verified) {
        if (!report.regionId) continue;
        regionMap.set(report.regionId, [...(regionMap.get(report.regionId) ?? []), report]);
      }
      const byRegion = [...regionMap.entries()]
        .map(([regionId, list]) => ({
          regionId,
          count: list.length,
          highestSeverity: highestSeverity(list.map((r) => r.severity!).filter(Boolean) as Severity[]),
        }))
        .sort((a, b) => b.count - a.count);

      // --- Officer throughput ---------------------------------------------
      const officerMap = new Map<string, number[]>();
      for (const report of reports) {
        if (!report.verifiedBy || !report.verifiedAt) continue;
        const ms = Date.parse(report.verifiedAt) - Date.parse(report.createdAt);
        officerMap.set(report.verifiedBy, [...(officerMap.get(report.verifiedBy) ?? []), ms]);
      }
      const officerLeaderboard = [...officerMap.entries()]
        .map(([profileId, times]) => ({
          profileId,
          name: db.find('profiles', profileId)?.fullName ?? 'Unknown officer',
          verified: times.length,
          medianMs: median(times),
        }))
        .sort((a, b) => b.verified - a.verified);

      const activeWorkers = db
        .table('profiles')
        .filter(
          (p) =>
            p.organizationId === orgId &&
            p.status === 'active' &&
            p.lastSeenAt &&
            Date.parse(p.lastSeenAt) >= Date.now() - 7 * 86_400_000,
        ).length;

      return {
        generatedAt: new Date().toISOString(),
        windowHours,
        totals: {
          reports: reports.length,
          verified: verified.length,
          dismissed: dismissed.length,
          pending: pending.length,
          alerts: alerts.length,
          sosEvents: sosEvents.length,
          activeWorkers,
          duplicatesCaught,
        },
        medianVerificationMs: median(verificationTimes),
        p90VerificationMs: percentile(verificationTimes, 0.9),
        medianSosAckMs: median(ackTimes),
        aiAgreementRate: comparable.length ? agreed.length / comparable.length : 0,
        reportsByDay: series,
        bySeverity,
        byType,
        byRegion,
        officerLeaderboard,
      };
    });
  },

  async overviewCached(windowHours: number, viewerId: string) {
    const key = cacheKey('analytics.overview', { windowHours, viewer: viewerId });
    return cache.fetch(key, () => mockAnalyticsApi.overview(windowHours), {
      ...POLICY.analytics,
      tags: ['analytics', 'reports'],
    });
  },

  /**
   * The worker's personal summary. Small on purpose - it exists to answer
   * "am I in a risky place right now", not to gamify reporting.
   */
  async workerSummary(): Promise<{
    myReports: number;
    myVerified: number;
    myPending: number;
    unreadAlerts: number;
    activeThreatsNearby: number;
    highestNearbySeverity: Severity | null;
  }> {
    return request({ name: 'analytics.workerSummary', latency: [120, 340] }, (profile: Profile | null) => {
      const mine = db.table('reports').filter((r) => r.reporterId === profile!.id);
      const org = db.find('organizations', profile!.organizationId);
      const partners = org?.crossSharePartners ?? [];

      const recentVerified = db
        .table('reports')
        .filter(
          (r) =>
            r.status === 'verified' &&
            Date.parse(r.occurredAt) >= Date.now() - 14 * 86_400_000 &&
            (r.organizationId === profile!.organizationId || partners.includes(r.organizationId)),
        );

      const inMyRegions = recentVerified.filter(
        (r) => r.regionId && profile!.operatingRegions.includes(r.regionId),
      );

      return {
        myReports: mine.length,
        myVerified: mine.filter((r) => r.status === 'verified').length,
        myPending: mine.filter((r) => r.status === 'pending').length,
        unreadAlerts: db.table('notifications').filter((n) => n.profileId === profile!.id && !n.readAt).length,
        activeThreatsNearby: inMyRegions.length,
        highestNearbySeverity: highestSeverity(
          inMyRegions.map((r) => r.severity!).filter(Boolean) as Severity[],
        ),
      };
    });
  },

  /** Officer console header numbers. */
  async officerSummary(): Promise<{
    pendingCount: number;
    oldestPendingMs: number;
    criticalPending: number;
    activeSos: number;
    verifiedToday: number;
    activeAlerts: number;
  }> {
    return request({ name: 'analytics.officerSummary', latency: [120, 320] }, (profile) => {
      requireRole(profile!, 'officer', 'admin');
      const org = db.find('organizations', profile!.organizationId);
      const partners = org?.crossSharePartners ?? [];
      const scope = (orgId: string) => orgId === profile!.organizationId || partners.includes(orgId);

      const pending = db.table('reports').filter((r) => r.status === 'pending' && scope(r.organizationId));
      const oldest = pending.length
        ? Date.now() - Math.min(...pending.map((r) => Date.parse(r.createdAt)))
        : 0;

      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);

      return {
        pendingCount: pending.length,
        oldestPendingMs: oldest,
        criticalPending: pending.filter(
          (r) => r.aiSuggestions?.severity === 'critical' || r.aiSuggestions?.severity === 'high',
        ).length,
        activeSos: db
          .table('sosEvents')
          .filter(
            (e) => e.organizationId === profile!.organizationId && (e.status === 'active' || e.status === 'acknowledged'),
          ).length,
        verifiedToday: db
          .table('reports')
          .filter(
            (r) =>
              r.verifiedBy === profile!.id && r.verifiedAt && Date.parse(r.verifiedAt) >= startOfDay.getTime(),
          ).length,
        activeAlerts: db
          .table('alerts')
          .filter(
            (a) =>
              scope(a.organizationId) &&
              !a.cancelledAt &&
              (!a.expiresAt || Date.parse(a.expiresAt) > Date.now()),
          ).length,
      };
    });
  },
};


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `analyticsApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const analyticsApi = API_MODE === 'supabase' ? supabaseAnalyticsApi : mockAnalyticsApi;
export { mockAnalyticsApi };
