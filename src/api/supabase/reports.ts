import { REGIONS_BY_ID, PLACES, regionForPoint } from '@/constants/regions';
import { distanceMeters } from '@/lib/geo';
import { parseOrThrow, reportDraftSchema, dismissReportSchema, sanitizeText, verifyReportSchema } from '@/lib/validation';
import { ApiError } from '../errors';
import { rateLimiter } from '../rateLimit';
import type { AuditEntry, Paginated, ThreatReport } from '../types';
import type { ReportFilterInput } from '../endpoints/reports';
import { call, deniedOrMissing } from './call';
import { supabase } from './client';
import { mapAudit, mapReport } from './mappers';

/**
 * Threat reports, backed by Postgres.
 *
 * Almost all the scoping that `visibleReportsFor` did by hand in the mock is
 * now done by RLS, so these queries are deliberately plain: the database
 * decides what comes back. The one thing still chosen here is *which relation*
 * to read - workers go through `reports_for_worker`, which strips the reporter
 * and blurs the pin, while officers and admins read the table directly.
 */

const WORKER_VIEW = 'reports_for_worker';
const TABLE = 'threat_reports';
const SELECT = '*, lat, lng';

async function currentRole(): Promise<{ id: string; role: string } | null> {
  const { data } = await supabase().auth.getUser();
  if (!data.user) return null;
  const row = await call('reports.role', () =>
    supabase().from('profiles').select('id, role').eq('id', data.user!.id).maybeSingle(),
  );
  return row ? { id: row.id, role: row.role } : null;
}

/** Workers read the anonymised view; officers and admins read the table. */
async function sourceFor(): Promise<string> {
  const me = await currentRole();
  return me?.role === 'worker' ? WORKER_VIEW : TABLE;
}

export const supabaseReportsApi = {
  async list(input: ReportFilterInput = {}): Promise<Paginated<ThreatReport>> {
    const from = await sourceFor();
    const limit = input.limit ?? 25;

    let query = supabase().from(from).select(SELECT, { count: 'exact' }).order('created_at', { ascending: false });

    if (input.status) query = query.eq('status', input.status);
    if (input.severities?.length) query = query.in('severity', input.severities);
    if (input.types?.length) query = query.in('threat_type', input.types);
    if (input.regionIds?.length) query = query.in('region_id', input.regionIds);
    if (input.windowHours) {
      query = query.gte('occurred_at', new Date(Date.now() - input.windowHours * 3_600_000).toISOString());
    }
    if (input.search) {
      const q = input.search.replace(/[%,()]/g, '');
      query = query.or(`description.ilike.%${q}%,reference.ilike.%${q}%,place_label.ilike.%${q}%`);
    }

    const rows = await call('reports.list', () => query.limit(limit));
    const items = (rows ?? []).map(mapReport);

    return {
      items,
      total: items.length,
      cursor: items.length === limit ? items[items.length - 1].id : null,
      hasMore: items.length === limit,
    };
  },

  async listCached(input: ReportFilterInput, _viewerId: string): Promise<Paginated<ThreatReport>> {
    return supabaseReportsApi.list(input);
  },

  async get(id: string): Promise<ThreatReport> {
    const from = await sourceFor();
    const row = await call('reports.get', () =>
      supabase().from(from).select(SELECT).eq('id', id).maybeSingle(),
    );
    if (!row) throw deniedOrMissing(`report ${id}`);
    return mapReport(row);
  },

  /**
   * File a report. RLS forces status `pending` and forbids setting any
   * classification field, so a client cannot self-verify however it is called.
   */
  async create(input: unknown, options: { clientId?: string } = {}): Promise<ThreatReport> {
    const data = parseOrThrow(reportDraftSchema, input);
    await rateLimiter.consume('reports.create');

    const me = await currentRole();
    if (!me) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

    const profile = await call('reports.myOrg', () =>
      supabase().from('profiles').select('organization_id').eq('id', me.id).maybeSingle(),
    );
    if (!profile) throw deniedOrMissing('profile');

    // The client mints the id so a queued submission retried after a timeout is
    // the same row, not a second report.
    const id = options.clientId;
    const region = regionForPoint(data.location);
    const nearest = PLACES.map((p) => ({ p, d: distanceMeters(p.point, data.location) })).sort((a, b) => a.d - b.d)[0];

    const row = await call('reports.create', () =>
      supabase()
        .from(TABLE)
        .insert({
          ...(id ? { id } : {}),
          reporter_id: me.id,
          organization_id: profile.organization_id,
          description: sanitizeText(data.description),
          photo_url: data.photoUrl,
          location: `SRID=4326;POINT(${data.location.lng} ${data.location.lat})`,
          location_accuracy_meters: data.locationAccuracyMeters,
          location_source: data.locationSource,
          region_id: region?.id ?? null,
          place_label: nearest && nearest.d < 60_000 ? nearest.p.name : null,
          reported_type: data.reportedType,
          status: 'pending',
          occurred_at: data.occurredAt,
        })
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) throw deniedOrMissing('report insert rejected');

    // Classification runs server-side. Until the Edge Function is deployed the
    // report simply stays `queued`, which the officer UI already handles.
    void supabase()
      .functions.invoke('classify-report', { body: { reportId: row.id } })
      .catch(() => undefined);

    return mapReport(row);
  },

  /** Retry classification. No-op unless the Edge Function is deployed. */
  async retryClassification(reportId: string): Promise<void> {
    await supabase().functions.invoke('classify-report', { body: { reportId, force: true } });
  },

  /**
   * Verify. The officer's decisions go into the report's own columns; the
   * trigger stamps who did it and refuses to let `ai_suggestions` be touched,
   * so the model's proposal and the human's decision stay separable forever.
   */
  async verify(input: unknown): Promise<ThreatReport> {
    const data = parseOrThrow(verifyReportSchema, input);
    await rateLimiter.consume('reports.verify');

    // Confirming a duplicate closes the report without alerting - the original
    // already did that.
    if (data.confirmDuplicate && data.duplicateOf) {
      const original = await call('reports.duplicateRef', () =>
        supabase().from(TABLE).select('reference').eq('id', data.duplicateOf!).maybeSingle(),
      );

      const merged = await call('reports.merge', () =>
        supabase()
          .from(TABLE)
          .update({
            status: 'dismissed',
            possible_duplicate_of: data.duplicateOf,
            dismissed_reason: `Confirmed duplicate of ${original?.reference ?? data.duplicateOf}.`,
          })
          .eq('id', data.reportId)
          .select(SELECT)
          .maybeSingle(),
      );

      if (!merged) throw deniedOrMissing('merge rejected');
      return mapReport(merged);
    }

    const row = await call('reports.verify', () =>
      supabase()
        .from(TABLE)
        .update({
          status: 'verified',
          threat_type: data.threatType,
          severity: data.severity,
          priority: data.priority,
          alert_radius_meters: Math.round(data.alertRadiusMeters),
          possible_duplicate_of: null,
        })
        .eq('id', data.reportId)
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'verify rejected',
        userMessage: 'Only a security officer can verify a report, and only while it is still pending.',
      });
    }

    const report = mapReport(row);

    // Create the alert and fan it out through the database function that owns
    // the four matching rules.
    const alert = await call('alerts.createForReport', () =>
      supabase()
        .from('safety_alerts')
        .insert({
          issued_by: report.verifiedBy,
          organization_id: report.organizationId,
          related_report_id: report.id,
          title: `${data.threatType.replace(/_/g, ' ')} near ${report.placeLabel ?? 'your area'}`.replace(/^./, (c) => c.toUpperCase()),
          message: `${report.aiSuggestions?.summary ?? 'Verified threat'}. ${
            data.severity === 'critical'
              ? 'Do not move. Shelter in place and contact your security officer now.'
              : data.severity === 'high'
                ? 'Suspend movement through the area. Essential travel only, with clearance.'
                : data.severity === 'medium'
                  ? 'Avoid the immediate area. Confirm before non-essential movement.'
                  : 'Stay aware. No movement restriction required.'
          }`,
          severity: data.severity,
          threat_type: data.threatType,
          location: `SRID=4326;POINT(${report.location.lng} ${report.location.lat})`,
          radius_meters: Math.round(data.alertRadiusMeters),
          region_ids: report.regionId ? [report.regionId] : [],
          kind: 'threat',
          expires_at: new Date(Date.now() + 72 * 3_600_000).toISOString(),
        })
        .select('id')
        .maybeSingle(),
    );

    if (alert?.id) {
      await call('alerts.fanOut', () => supabase().rpc('fan_out_alert', { p_alert_id: alert.id }));
    }

    return report;
  },

  async dismiss(input: unknown): Promise<ThreatReport> {
    const data = parseOrThrow(dismissReportSchema, input);

    const row = await call('reports.dismiss', () =>
      supabase()
        .from(TABLE)
        .update({ status: 'dismissed', dismissed_reason: sanitizeText(data.reason) })
        .eq('id', data.reportId)
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'dismiss rejected',
        userMessage: 'Only a security officer can dismiss a report, and only while it is still pending.',
      });
    }
    return mapReport(row);
  },

  async mine(limit = 30): Promise<ThreatReport[]> {
    const me = await currentRole();
    if (!me) return [];

    // Own reports come from the table, not the view: you always see your own in
    // full, including the photo and exact position.
    const rows = await call('reports.mine', () =>
      supabase()
        .from(TABLE)
        .select(SELECT)
        .eq('reporter_id', me.id)
        .order('created_at', { ascending: false })
        .limit(limit),
    );
    return (rows ?? []).map(mapReport);
  },

  async pendingQueue(): Promise<ThreatReport[]> {
    const rows = await call('reports.pendingQueue', () =>
      supabase().from(TABLE).select(SELECT).eq('status', 'pending').order('created_at', { ascending: true }),
    );

    // Highest AI-suggested priority first, then oldest, so nothing that looks
    // serious sits behind something that merely arrived later.
    return (rows ?? [])
      .map(mapReport)
      .sort((a: ThreatReport, b: ThreatReport) => {
        const pa = a.aiSuggestions?.priority ?? 0;
        const pb = b.aiSuggestions?.priority ?? 0;
        if (pa !== pb) return pb - pa;
        return Date.parse(a.createdAt) - Date.parse(b.createdAt);
      });
  },

  async mapThreats(windowHours: number): Promise<ThreatReport[]> {
    const from = await sourceFor();
    const rows = await call('reports.mapThreats', () =>
      supabase()
        .from(from)
        .select(SELECT)
        .eq('status', 'verified')
        .gte('occurred_at', new Date(Date.now() - windowHours * 3_600_000).toISOString())
        .order('occurred_at', { ascending: false }),
    );
    return (rows ?? []).map(mapReport);
  },

  /** PostGIS does the distance work; this is the real ST_DWithin query. */
  async nearby(point: { lat: number; lng: number }, radiusMeters: number, windowHours = 24 * 14): Promise<{ report: ThreatReport; distance: number }[]> {
    const rows = await call('reports.nearby', () =>
      supabase().rpc('threats_nearby', {
        p_lat: point.lat,
        p_lng: point.lng,
        radius_meters: radiusMeters,
        window_hours: windowHours,
      }),
    );

    if (!rows?.length) return [];

    const ids = rows.map((r: { report_id: string }) => r.report_id);
    const from = await sourceFor();
    const full = await call('reports.nearbyHydrate', () =>
      supabase().from(from).select(SELECT).in('id', ids),
    );

    const byId = new Map((full ?? []).map((r: Record<string, unknown>) => [r.id as string, mapReport(r)]));
    return rows
      .map((r: { report_id: string; distance_meters: number }) => {
        const report = byId.get(r.report_id);
        return report ? { report, distance: r.distance_meters } : null;
      })
      .filter((v: { report: ThreatReport; distance: number } | null): v is { report: ThreatReport; distance: number } => v !== null);
  },

  async duplicateCandidates(reportId: string) {
    const rows = await call('reports.duplicateCandidates', () =>
      supabase().rpc('duplicate_candidates', { p_report_id: reportId }),
    );
    if (!rows?.length) return [];

    const ids = rows.map((r: { report_id: string }) => r.report_id);
    const full = await call('reports.duplicateHydrate', () =>
      supabase().from(TABLE).select(SELECT).in('id', ids),
    );
    const byId = new Map((full ?? []).map((r: Record<string, unknown>) => [r.id as string, mapReport(r)]));

    return rows
      .map((r: { report_id: string; distance_meters: number; minutes_apart: number }) => {
        const report = byId.get(r.report_id);
        return report
          ? { report, distanceMeters: r.distance_meters, minutesApart: r.minutes_apart, score: 0 }
          : null;
      })
      .filter((v: any) => v !== null);
  },

  async history(reportId: string): Promise<AuditEntry[]> {
    const rows = await call('reports.history', () =>
      supabase()
        .from('audit_log')
        .select('*')
        .eq('entity', 'report')
        .eq('entity_id', reportId)
        .order('ts', { ascending: true }),
    );
    return (rows ?? []).map(mapAudit);
  },
};

export { REGIONS_BY_ID };
