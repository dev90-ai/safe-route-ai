import { SEVERITIES, THREAT_TYPES, highestSeverity, type Severity, type ThreatType } from '@/constants/threats';
import type { Analytics } from '../types';
import { call, type Row } from './call';
import { supabase } from './client';

/**
 * Analytics.
 *
 * Computed client-side from a scoped fetch rather than in SQL, because RLS
 * already limits the rows to this organisation and the volumes are small
 * (hundreds of reports, not millions). If that stops being true, these become
 * materialised views - the shape returned here would not change.
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

const dayKey = (ts: number) => new Date(ts).toISOString().slice(0, 10);

export const supabaseAnalyticsApi = {
  async overview(windowHours = 24 * 30): Promise<Analytics> {
    const since = new Date(Date.now() - windowHours * 3_600_000).toISOString();

    const [reports, alerts, sosEvents, profiles] = await Promise.all([
      call<Row[]>('analytics.reports', () =>
        supabase()
          .from('threat_reports')
          .select('id, status, severity, threat_type, region_id, created_at, verified_at, verified_by, ai_suggestions, possible_duplicate_of')
          .gte('created_at', since),
      ),
      call<Row[]>('analytics.alerts', () => supabase().from('safety_alerts').select('id').gte('created_at', since)),
      call<Row[]>('analytics.sos', () =>
        supabase().from('sos_events').select('id, created_at, acknowledged_at').gte('created_at', since),
      ),
      call<Row[]>('analytics.profiles', () => supabase().from('profiles').select('id, full_name, last_seen_at')),
    ]);

    const all = reports ?? [];
    const verified = all.filter((r) => r.status === 'verified');
    const dismissed = all.filter((r) => r.status === 'dismissed');
    const pending = all.filter((r) => r.status === 'pending');

    const verificationTimes = all
      .filter((r) => r.verified_at)
      .map((r) => Date.parse(r.verified_at) - Date.parse(r.created_at))
      .filter((ms) => ms >= 0);

    const ackTimes = (sosEvents ?? [])
      .filter((e) => e.acknowledged_at)
      .map((e) => Date.parse(e.acknowledged_at) - Date.parse(e.created_at))
      .filter((ms) => ms >= 0);

    // AI agreement: how often an officer accepted the model unchanged. Too high
    // is as much a warning as too low - it suggests rubber-stamping, which
    // would make the human verification step decorative.
    const comparable = verified.filter((r) => r.ai_suggestions && r.severity && r.threat_type);
    const agreed = comparable.filter(
      (r) => r.ai_suggestions.severity === r.severity && r.ai_suggestions.threatType === r.threat_type,
    );

    const days = Math.min(90, Math.max(1, Math.ceil(windowHours / 24)));
    const series: Analytics['reportsByDay'] = [];
    for (let i = days - 1; i >= 0; i -= 1) {
      const date = dayKey(Date.now() - i * 86_400_000);
      const forDay = all.filter((r) => dayKey(Date.parse(r.created_at)) === date);
      series.push({
        date,
        total: forDay.length,
        verified: forDay.filter((r) => r.status === 'verified').length,
        dismissed: forDay.filter((r) => r.status === 'dismissed').length,
      });
    }

    const regionMap = new Map<string, Severity[]>();
    for (const r of verified) {
      if (!r.region_id) continue;
      regionMap.set(r.region_id, [...(regionMap.get(r.region_id) ?? []), r.severity as Severity]);
    }

    const officerMap = new Map<string, number[]>();
    for (const r of all) {
      if (!r.verified_by || !r.verified_at) continue;
      const ms = Date.parse(r.verified_at) - Date.parse(r.created_at);
      officerMap.set(r.verified_by, [...(officerMap.get(r.verified_by) ?? []), ms]);
    }
    const nameById = new Map<string, string>((profiles ?? []).map((p) => [p.id as string, p.full_name as string]));

    return {
      generatedAt: new Date().toISOString(),
      windowHours,
      totals: {
        reports: all.length,
        verified: verified.length,
        dismissed: dismissed.length,
        pending: pending.length,
        alerts: alerts?.length ?? 0,
        sosEvents: sosEvents?.length ?? 0,
        activeWorkers: (profiles ?? []).filter(
          (p) => p.last_seen_at && Date.parse(p.last_seen_at) >= Date.now() - 7 * 86_400_000,
        ).length,
        duplicatesCaught: all.filter((r) => r.status === 'dismissed' && r.possible_duplicate_of).length,
      },
      medianVerificationMs: median(verificationTimes),
      p90VerificationMs: percentile(verificationTimes, 0.9),
      medianSosAckMs: median(ackTimes),
      aiAgreementRate: comparable.length ? agreed.length / comparable.length : 0,
      reportsByDay: series,
      bySeverity: SEVERITIES.map((severity) => ({
        severity,
        count: verified.filter((r) => r.severity === severity).length,
      })),
      byType: THREAT_TYPES.map((type) => ({
        type: type as ThreatType,
        count: verified.filter((r) => r.threat_type === type).length,
      }))
        .filter((t) => t.count > 0)
        .sort((a, b) => b.count - a.count),
      byRegion: [...regionMap.entries()]
        .map(([regionId, severities]) => ({
          regionId,
          count: severities.length,
          highestSeverity: highestSeverity(severities.filter(Boolean)),
        }))
        .sort((a, b) => b.count - a.count),
      officerLeaderboard: [...officerMap.entries()]
        .map(([profileId, times]) => ({
          profileId,
          name: nameById.get(profileId) ?? 'Unknown officer',
          verified: times.length,
          medianMs: median(times),
        }))
        .sort((a, b) => b.verified - a.verified),
    };
  },

  async overviewCached(windowHours: number, _viewerId: string): Promise<Analytics> {
    return supabaseAnalyticsApi.overview(windowHours);
  },

  async workerSummary() {
    const { data: me } = await supabase().auth.getUser();

    const [mine, recent, unread, profile] = await Promise.all([
      call<Row[]>('analytics.mine', () =>
        supabase().from('threat_reports').select('id, status').eq('reporter_id', me.user?.id ?? ''),
      ),
      call<Row[]>('analytics.recentVerified', () =>
        supabase()
          .from('reports_for_worker')
          .select('id, severity, region_id')
          .eq('status', 'verified')
          .gte('occurred_at', new Date(Date.now() - 14 * 86_400_000).toISOString()),
      ),
      supabase().from('notifications').select('id', { count: 'exact', head: true }).is('read_at', null),
      call<Row>('analytics.myProfile', () =>
        supabase().from('profiles').select('operating_regions').eq('id', me.user?.id ?? '').maybeSingle(),
      ),
    ]);

    const regions: string[] = profile?.operating_regions ?? [];
    const inMyRegions = (recent ?? []).filter((r) => r.region_id && regions.includes(r.region_id));

    return {
      myReports: mine?.length ?? 0,
      myVerified: (mine ?? []).filter((r) => r.status === 'verified').length,
      myPending: (mine ?? []).filter((r) => r.status === 'pending').length,
      unreadAlerts: unread.count ?? 0,
      activeThreatsNearby: inMyRegions.length,
      highestNearbySeverity: highestSeverity(
        inMyRegions.map((r) => r.severity as Severity).filter(Boolean),
      ),
    };
  },

  async officerSummary() {
    const { data: me } = await supabase().auth.getUser();
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const [pending, sos, alerts, verifiedToday] = await Promise.all([
      call<Row[]>('analytics.pending', () =>
        supabase().from('threat_reports').select('id, created_at, ai_suggestions').eq('status', 'pending'),
      ),
      call<Row[]>('analytics.activeSos', () =>
        supabase().from('sos_events').select('id').in('status', ['active', 'acknowledged']),
      ),
      call<Row[]>('analytics.activeAlerts', () =>
        supabase()
          .from('safety_alerts')
          .select('id')
          .is('cancelled_at', null)
          .or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`),
      ),
      call<Row[]>('analytics.verifiedToday', () =>
        supabase()
          .from('threat_reports')
          .select('id')
          .eq('verified_by', me.user?.id ?? '')
          .gte('verified_at', startOfDay.toISOString()),
      ),
    ]);

    const oldest = (pending ?? []).length
      ? Date.now() - Math.min(...(pending ?? []).map((r) => Date.parse(r.created_at)))
      : 0;

    return {
      pendingCount: pending?.length ?? 0,
      oldestPendingMs: oldest,
      criticalPending: (pending ?? []).filter(
        (r) => r.ai_suggestions?.severity === 'critical' || r.ai_suggestions?.severity === 'high',
      ).length,
      activeSos: sos?.length ?? 0,
      verifiedToday: verifiedToday?.length ?? 0,
      activeAlerts: alerts?.length ?? 0,
    };
  },
};
