import { classifyReport } from '@/ai/classifier';
import { regionForPoint, REGIONS_BY_ID, PLACES } from '@/constants/regions';
import { SEVERITY_META, THREAT_META, type Severity } from '@/constants/threats';
import { distanceMeters, jitter } from '@/lib/geo';
import { shortRef, uuid } from '@/lib/ids';
import { logger } from '@/lib/logger';
import {
  dismissReportSchema,
  parseOrThrow,
  reportDraftSchema,
  reportFilterSchema,
  sanitizeText,
  verifyReportSchema,
} from '@/lib/validation';
import { assertOrgVisible, request, requireRole } from '../client';
import { cache, cacheKey, POLICY } from '../cache';
import { db } from '../db';
import { ApiError } from '../errors';
import type { Paginated, Profile, ThreatReport } from '../types';
import { mockAlertsApi } from './alerts';
import { API_MODE } from '../supabase/client';
import { supabaseReportsApi } from '../supabase/reports';

/**
 * Threat reports: create, read (scoped), verify, dismiss.
 *
 * The visibility rules here are the RLS policies written out in TypeScript:
 *
 *   worker  -> verified reports from their org or a cross-share partner, plus
 *              their own reports at any status. Reporter identity is stripped.
 *   officer -> every report belonging to their org or a partner, at any status,
 *              with reporter identity intact (unless the org has opted into
 *              anonymising reporters even from officers).
 *   admin   -> every report in their own org, read-only. Admins cannot verify.
 */

const DUPLICATE_WINDOW_MS = 12 * 60 * 60 * 1000;
const DUPLICATE_RADIUS_M = 5000;

export type ReportFilterInput = Partial<{
  status: ThreatReport['status'];
  severities: NonNullable<ThreatReport['severity']>[];
  types: NonNullable<ThreatReport['threatType']>[];
  regionIds: string[];
  windowHours: number;
  search: string;
  limit: number;
  cursor: string | null;
}>;

/**
 * Strip the reporter's identity, and blur the position slightly, before a
 * report reaches a peer worker. Retaliation against reporters is the specific
 * risk this protects against, so it happens at the data layer - not by
 * omitting a field in a component.
 */
export function redactForPeer(report: ThreatReport, viewerId: string): ThreatReport {
  if (report.reporterId === viewerId) return report;
  return {
    ...report,
    reporterId: 'anonymous',
    // ~250 m of blur: enough to protect the reporter, far below any alert radius.
    location: jitter(report.location, 250, report.id.length),
    photoUrl: null,
    aiSuggestions: report.aiSuggestions
      ? { ...report.aiSuggestions, duplicateCandidates: [] }
      : null,
  };
}

function visibleReportsFor(profile: Profile): ThreatReport[] {
  const org = db.table('organizations').find((o) => o.id === profile.organizationId);
  const partnerIds = org?.crossSharePartners ?? [];
  const all = db.table('reports');

  if (profile.role === 'worker') {
    return all
      .filter(
        (r) =>
          r.reporterId === profile.id ||
          (r.status === 'verified' &&
            (r.organizationId === profile.organizationId || partnerIds.includes(r.organizationId))),
      )
      .map((r) => redactForPeer(r, profile.id));
  }

  if (profile.role === 'officer') {
    const visible = all.filter(
      (r) => r.organizationId === profile.organizationId || partnerIds.includes(r.organizationId),
    );
    // Some organisations run reporter-blind verification.
    return org?.settings.anonymiseReportersToOfficers
      ? visible.map((r) => ({ ...r, reporterId: 'anonymous' }))
      : visible;
  }

  // Admin: own organisation only, and read-only by policy.
  return all.filter((r) => r.organizationId === profile.organizationId);
}

function applyFilters(reports: ThreatReport[], filter: ReturnType<typeof reportFilterSchema.parse>) {
  let out = reports;

  if (filter.status) out = out.filter((r) => r.status === filter.status);
  if (filter.severities?.length) {
    const set = new Set(filter.severities);
    out = out.filter((r) => {
      const sev = r.severity ?? r.aiSuggestions?.severity;
      return sev ? set.has(sev) : false;
    });
  }
  if (filter.types?.length) {
    const set = new Set(filter.types);
    out = out.filter((r) => {
      const type = r.threatType ?? r.aiSuggestions?.threatType ?? r.reportedType;
      return type ? set.has(type) : false;
    });
  }
  if (filter.regionIds?.length) {
    const set = new Set(filter.regionIds);
    out = out.filter((r) => (r.regionId ? set.has(r.regionId) : false));
  }
  if (filter.windowHours) {
    const cutoff = Date.now() - filter.windowHours * 3_600_000;
    out = out.filter((r) => Date.parse(r.occurredAt) >= cutoff);
  }
  if (filter.search) {
    const q = filter.search.toLowerCase();
    out = out.filter(
      (r) =>
        r.description.toLowerCase().includes(q) ||
        r.reference.toLowerCase().includes(q) ||
        (r.placeLabel ?? '').toLowerCase().includes(q),
    );
  }

  return out;
}

const mockReportsApi = {
  /** Paginated, filtered, role-scoped list. */
  async list(input: ReportFilterInput = {}): Promise<Paginated<ThreatReport>> {
    const filter = parseOrThrow(reportFilterSchema, input);

    return request({ name: 'reports.list', allowOffline: false }, (profile) => {
      const scoped = applyFilters(visibleReportsFor(profile!), filter).sort(
        (a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt),
      );

      const limit = filter.limit ?? 25;
      const startIndex = filter.cursor ? scoped.findIndex((r) => r.id === filter.cursor) + 1 : 0;
      const items = scoped.slice(startIndex, startIndex + limit);
      const nextIndex = startIndex + items.length;

      return {
        items,
        total: scoped.length,
        cursor: nextIndex < scoped.length ? items[items.length - 1]?.id ?? null : null,
        hasMore: nextIndex < scoped.length,
      };
    });
  },

  /** Cached wrapper used by screens; falls back to disk when offline. */
  async listCached(input: ReportFilterInput, viewerId: string): Promise<Paginated<ThreatReport>> {
    const key = cacheKey('reports.list', { ...input, viewer: viewerId });
    return cache.fetch(key, () => mockReportsApi.list(input), { ...POLICY.threats, tags: ['reports'] });
  },

  async get(id: string): Promise<ThreatReport> {
    return request({ name: 'reports.get' }, (profile) => {
      const report = visibleReportsFor(profile!).find((r) => r.id === id);
      if (!report) throw new ApiError({ kind: 'not-found', message: `report ${id}` });
      return report;
    });
  },

  /**
   * Submit a report. The row lands as `pending` with `aiStatus: 'queued'`, and
   * classification runs afterwards - a worker is never made to wait for a model
   * before their report is recorded.
   */
  async create(input: unknown, options: { clientId?: string } = {}): Promise<ThreatReport> {
    const data = parseOrThrow(reportDraftSchema, input);

    return request(
      { name: 'reports.create', limit: { key: 'reports.create' } },
      async (profile) => {
        requireRole(profile!, 'worker', 'officer');

        // Idempotency: a queued submission retried after a timeout must not
        // create a second report. The client mints the id before going offline.
        const id = options.clientId ?? uuid();
        const existing = db.table('reports').find((r) => r.id === id);
        if (existing) {
          logger.info('reports', 'idempotent replay ignored', { id });
          return existing;
        }

        const description = sanitizeText(data.description);
        const region = regionForPoint(data.location);
        const nearestPlace = PLACES.map((p) => ({ p, d: distanceMeters(p.point, data.location) })).sort(
          (a, b) => a.d - b.d,
        )[0];

        const now = new Date().toISOString();
        const report: ThreatReport = {
          id,
          reference: shortRef(id),
          reporterId: profile!.id,
          organizationId: profile!.organizationId,
          description,
          photoUrl: data.photoUrl,
          location: data.location,
          locationAccuracyMeters: data.locationAccuracyMeters,
          locationSource: data.locationSource,
          regionId: region?.id ?? null,
          placeLabel: nearestPlace && nearestPlace.d < 60_000 ? nearestPlace.p.name : null,
          reportedType: data.reportedType,
          threatType: null,
          severity: null,
          priority: null,
          alertRadiusMeters: null,
          status: 'pending',
          possibleDuplicateOf: null,
          aiSuggestions: null,
          aiStatus: 'queued',
          verifiedBy: null,
          verifiedAt: null,
          dismissedReason: null,
          occurredAt: data.occurredAt,
          createdAt: now,
          updatedAt: now,
        };

        db.insert('reports', report);
        db.audit({
          actorId: profile!.id,
          actorRole: profile!.role,
          organizationId: profile!.organizationId,
          action: 'report.created',
          entity: 'report',
          entityId: report.id,
          summary: `${profile!.fullName} filed report ${report.reference}${
            report.placeLabel ? ` near ${report.placeLabel}` : ''
          }.`,
        });

        cache.invalidateTags('reports', 'analytics');

        // Fire-and-forget, mirroring the database trigger that calls the Edge
        // Function. The officer queue picks up the result over realtime.
        void mockReportsApi.runClassification(report.id);

        return report;
      },
    );
  },

  /**
   * The Grok Edge Function, client-side stand-in. Never called from a screen -
   * it is invoked by `create`, exactly as the database trigger will invoke the
   * real function. Failure is non-fatal: the report stays reviewable without
   * any AI assistance at all.
   */
  async runClassification(reportId: string): Promise<void> {
    await db.init();
    const report = db.find('reports', reportId);
    if (!report || report.aiStatus === 'complete') return;

    db.update('reports', reportId, { aiStatus: 'processing' });

    try {
      // Geo + time pre-filter: the shortlist the model actually sees.
      const candidates = db
        .table('reports')
        .filter(
          (r) =>
            r.id !== reportId &&
            r.status !== 'dismissed' &&
            Math.abs(Date.parse(r.occurredAt) - Date.parse(report.occurredAt)) <= DUPLICATE_WINDOW_MS &&
            distanceMeters(r.location, report.location) <= DUPLICATE_RADIUS_M,
        )
        .slice(0, 8);

      const suggestion = await classifyReport({
        description: report.description,
        reportedType: report.reportedType,
        location: report.location,
        occurredAt: report.occurredAt,
        candidates,
      });

      db.update('reports', reportId, {
        aiSuggestions: suggestion,
        aiStatus: 'complete',
        possibleDuplicateOf: suggestion.possibleDuplicateOf,
        updatedAt: new Date().toISOString(),
      });

      db.audit({
        actorId: null,
        actorRole: 'system',
        organizationId: report.organizationId,
        action: 'report.ai_classified',
        entity: 'report',
        entityId: reportId,
        summary: `AI suggested ${THREAT_META[suggestion.threatType].label} / ${suggestion.severity} at ${Math.round(
          suggestion.confidence * 100,
        )}% confidence${suggestion.possibleDuplicateOf ? ', flagged as a possible duplicate' : ''}.`,
        after: {
          threatType: suggestion.threatType,
          severity: suggestion.severity,
          alertRadiusMeters: suggestion.alertRadiusMeters,
          possibleDuplicateOf: suggestion.possibleDuplicateOf,
        },
      });

      cache.invalidateTags('reports');
      logger.info('ai', 'classification complete', {
        reportId,
        confidence: suggestion.confidence,
        latencyMs: suggestion.latencyMs,
      });
    } catch (e) {
      db.update('reports', reportId, { aiStatus: 'failed' });
      logger.capture('ai', e, { reportId });
      db.audit({
        actorId: null,
        actorRole: 'system',
        organizationId: report.organizationId,
        action: 'report.ai_failed',
        entity: 'report',
        entityId: reportId,
        summary: 'AI classification failed. The report remains reviewable without suggestions.',
      });
      cache.invalidateTags('reports');
    }
  },

  /** Retry a failed classification from the officer UI. */
  async retryClassification(reportId: string): Promise<void> {
    return request({ name: 'reports.retryClassification' }, async (profile) => {
      requireRole(profile!, 'officer');
      const report = db.find('reports', reportId);
      if (!report) throw new ApiError({ kind: 'not-found', message: 'report' });
      assertOrgVisible(profile!, report.organizationId);
      db.update('reports', reportId, { aiStatus: 'queued', aiSuggestions: null });
      void mockReportsApi.runClassification(reportId);
    });
  },

  /**
   * Verify a report. This is the only path from `pending` to `verified`, it is
   * restricted to officers, and it is what triggers alert fan-out. The officer's
   * decisions are written to the report's own columns; the AI's suggestions stay
   * untouched in `aiSuggestions` so the two can always be compared afterwards.
   */
  async verify(input: unknown): Promise<ThreatReport> {
    const data = parseOrThrow(verifyReportSchema, input);

    return request(
      { name: 'reports.verify', limit: { key: 'reports.verify' } },
      async (profile) => {
        requireRole(profile!, 'officer');

        const report = db.find('reports', data.reportId);
        if (!report) throw new ApiError({ kind: 'not-found', message: 'report' });
        assertOrgVisible(profile!, report.organizationId);

        if (report.status !== 'pending') {
          throw new ApiError({
            kind: 'conflict',
            message: 'already resolved',
            userMessage: `This report was already ${report.status} by someone else.`,
          });
        }

        const org = db.table('organizations').find((o) => o.id === report.organizationId);
        if (org?.settings.dualControlForCritical && data.severity === 'critical' && report.verifiedBy === profile!.id) {
          throw new ApiError({
            kind: 'forbidden',
            message: 'dual control required',
            userMessage: 'Critical reports need a second officer to countersign in this organisation.',
          });
        }

        // Confirming a duplicate closes the report without alerting - the
        // original already did that. This is the whole point of the flag.
        if (data.confirmDuplicate && data.duplicateOf) {
          const updated = db.update('reports', report.id, {
            status: 'dismissed',
            possibleDuplicateOf: data.duplicateOf,
            dismissedReason: `Confirmed duplicate of ${db.find('reports', data.duplicateOf)?.reference ?? data.duplicateOf}.`,
            verifiedBy: profile!.id,
            verifiedAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
          })!;

          db.audit({
            actorId: profile!.id,
            actorRole: 'officer',
            organizationId: report.organizationId,
            action: 'report.merged_duplicate',
            entity: 'report',
            entityId: report.id,
            summary: `${profile!.fullName} confirmed ${report.reference} as a duplicate. No alert was issued.`,
            before: { status: 'pending' },
            after: { status: 'dismissed', duplicateOf: data.duplicateOf },
          });

          cache.invalidateTags('reports', 'analytics');
          return updated;
        }

        const verifiedAt = new Date().toISOString();
        const updated = db.update('reports', report.id, {
          status: 'verified',
          threatType: data.threatType,
          severity: data.severity,
          priority: data.priority,
          alertRadiusMeters: data.alertRadiusMeters,
          possibleDuplicateOf: data.confirmDuplicate ? data.duplicateOf : null,
          verifiedBy: profile!.id,
          verifiedAt,
          updatedAt: verifiedAt,
        })!;

        const ai = report.aiSuggestions;
        const overrides: string[] = [];
        if (ai && ai.threatType !== data.threatType) overrides.push(`type ${ai.threatType} to ${data.threatType}`);
        if (ai && ai.severity !== data.severity) overrides.push(`severity ${ai.severity} to ${data.severity}`);
        if (ai && ai.alertRadiusMeters !== data.alertRadiusMeters) {
          overrides.push(`radius ${(ai.alertRadiusMeters / 1000).toFixed(1)} km to ${(data.alertRadiusMeters / 1000).toFixed(1)} km`);
        }

        db.audit({
          actorId: profile!.id,
          actorRole: 'officer',
          organizationId: report.organizationId,
          action: 'report.verified',
          entity: 'report',
          entityId: report.id,
          summary: `${profile!.fullName} verified ${report.reference} as ${SEVERITY_META[data.severity].label} ${
            THREAT_META[data.threatType].label
          }${overrides.length ? `, overriding AI ${overrides.join(' and ')}` : ', accepting the AI suggestion'}.${
            data.note ? ` Note: ${data.note}` : ''
          }`,
          before: { status: 'pending', aiSuggested: ai ? { threatType: ai.threatType, severity: ai.severity } : null },
          after: {
            status: 'verified',
            threatType: data.threatType,
            severity: data.severity,
            alertRadiusMeters: data.alertRadiusMeters,
          },
        });

        cache.invalidateTags('reports', 'alerts', 'notifications', 'analytics');

        // The fan-out function, triggered by the transition to verified.
        await mockAlertsApi.fanOutForReport(updated, profile!);

        return db.find('reports', report.id)!;
      },
    );
  },

  /** Reject a report. No alert fires; the reason is recorded permanently. */
  async dismiss(input: unknown): Promise<ThreatReport> {
    const data = parseOrThrow(dismissReportSchema, input);

    return request({ name: 'reports.dismiss' }, (profile) => {
      requireRole(profile!, 'officer');

      const report = db.find('reports', data.reportId);
      if (!report) throw new ApiError({ kind: 'not-found', message: 'report' });
      assertOrgVisible(profile!, report.organizationId);

      if (report.status !== 'pending') {
        throw new ApiError({
          kind: 'conflict',
          message: 'already resolved',
          userMessage: `This report was already ${report.status}.`,
        });
      }

      const now = new Date().toISOString();
      const updated = db.update('reports', report.id, {
        status: 'dismissed',
        dismissedReason: sanitizeText(data.reason),
        verifiedBy: profile!.id,
        verifiedAt: now,
        updatedAt: now,
      })!;

      db.audit({
        actorId: profile!.id,
        actorRole: 'officer',
        organizationId: report.organizationId,
        action: 'report.dismissed',
        entity: 'report',
        entityId: report.id,
        summary: `${profile!.fullName} dismissed ${report.reference}: ${data.reason}`,
        before: { status: 'pending' },
        after: { status: 'dismissed' },
      });

      cache.invalidateTags('reports', 'analytics');
      return updated;
    });
  },

  /** Reports the signed-in worker filed, including their pending ones. */
  async mine(limit = 30): Promise<ThreatReport[]> {
    return request({ name: 'reports.mine' }, (profile) =>
      db
        .table('reports')
        .filter((r) => r.reporterId === profile!.id)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit),
    );
  },

  /** The officer's verification queue, priority-ordered. */
  async pendingQueue(): Promise<ThreatReport[]> {
    return request({ name: 'reports.pendingQueue' }, (profile) => {
      requireRole(profile!, 'officer', 'admin');
      const org = db.table('organizations').find((o) => o.id === profile!.organizationId);
      const partners = org?.crossSharePartners ?? [];

      return db
        .table('reports')
        .filter(
          (r) =>
            r.status === 'pending' &&
            (r.organizationId === profile!.organizationId || partners.includes(r.organizationId)),
        )
        .sort((a, b) => {
          // Highest AI-suggested priority first, then oldest - so nothing that
          // looks serious sits behind something that merely arrived later.
          const pa = a.aiSuggestions?.priority ?? 0;
          const pb = b.aiSuggestions?.priority ?? 0;
          if (pa !== pb) return pb - pa;
          return Date.parse(a.createdAt) - Date.parse(b.createdAt);
        });
    });
  },

  /** Verified threats for the map, already scoped and redacted. */
  async mapThreats(windowHours: number): Promise<ThreatReport[]> {
    return request({ name: 'reports.mapThreats' }, (profile) => {
      const cutoff = Date.now() - windowHours * 3_600_000;
      return visibleReportsFor(profile!)
        .filter((r) => r.status === 'verified' && Date.parse(r.occurredAt) >= cutoff)
        .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
    });
  },

  /** Threats near a point - used for the "near you" home card. */
  async nearby(point: { lat: number; lng: number }, radiusMeters: number, windowHours = 24 * 14): Promise<{ report: ThreatReport; distance: number }[]> {
    return request({ name: 'reports.nearby' }, (profile) => {
      const cutoff = Date.now() - windowHours * 3_600_000;
      return visibleReportsFor(profile!)
        .filter((r) => r.status === 'verified' && Date.parse(r.occurredAt) >= cutoff)
        .map((r) => ({ report: r, distance: distanceMeters(point, r.location) }))
        .filter((r) => r.distance <= radiusMeters)
        .sort((a, b) => a.distance - b.distance);
    });
  },

  /** Resolve the duplicate candidates an officer needs to compare side by side. */
  async duplicateCandidates(reportId: string): Promise<{ report: ThreatReport; distanceMeters: number; minutesApart: number; score: number }[]> {
    return request({ name: 'reports.duplicateCandidates' }, (profile) => {
      requireRole(profile!, 'officer');
      const report = db.find('reports', reportId);
      if (!report) throw new ApiError({ kind: 'not-found', message: 'report' });

      const listed = report.aiSuggestions?.duplicateCandidates ?? [];
      return listed
        .map((candidate) => {
          const other = db.find('reports', candidate.reportId);
          return other
            ? {
                report: other,
                distanceMeters: candidate.distanceMeters,
                minutesApart: candidate.minutesApart,
                score: candidate.score,
              }
            : null;
        })
        .filter((v): v is NonNullable<typeof v> => v !== null);
    });
  },

  /** Full audit trail for one report - the accountability view. */
  async history(reportId: string) {
    return request({ name: 'reports.history' }, (profile) => {
      const report = visibleReportsFor(profile!).find((r) => r.id === reportId);
      if (!report) throw new ApiError({ kind: 'not-found', message: 'report' });
      return db
        .table('audit')
        .filter((a) => a.entity === 'report' && a.entityId === reportId)
        .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
    });
  },
};

/** Severity of a report as the UI should read it: confirmed first, else AI. */
export function effectiveSeverity(report: ThreatReport): Severity | null {
  return report.severity ?? report.aiSuggestions?.severity ?? null;
}

export function effectiveType(report: ThreatReport) {
  return report.threatType ?? report.aiSuggestions?.threatType ?? report.reportedType ?? 'other';
}

export function regionLabel(report: ThreatReport): string {
  if (report.placeLabel) return report.placeLabel;
  if (report.regionId) return REGIONS_BY_ID[report.regionId]?.name ?? 'Unknown area';
  return 'Unknown area';
}


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `reportsApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const reportsApi = API_MODE === 'supabase' ? supabaseReportsApi : mockReportsApi;
export { mockReportsApi };
