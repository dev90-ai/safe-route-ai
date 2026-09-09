import { PLACES } from '@/constants/regions';
import { distanceToPath, pathLengthMeters, type LatLng } from '@/lib/geo';
import { parseOrThrow, routeQuerySchema } from '@/lib/validation';
import { request } from '../client';
import { cache, cacheKey, POLICY } from '../cache';
import { db } from '../db';
import { buildRouteCandidates, describeRoute } from '../routing';
import type { RouteCandidate, RouteThreat, ThreatReport } from '../types';
import { redactForPeer } from './reports';
import { API_MODE } from '../supabase/client';
import { supabaseRoutesApi } from '../supabase/routes';

/**
 * Safe Route advisory (mock transport).
 *
 * Route geometry and scoring come from `api/routing.ts`, shared with the
 * Supabase implementation so a route ranks identically either way. What differs
 * is only where the threats come from: here, an in-memory scan standing in for
 * `ST_DWithin(route_line::geography, threat.location, buffer)`.
 *
 * Only verified threats count. An unverified rumour must not close a road.
 */

export type RouteQueryInput = {
  origin: LatLng;
  destination: LatLng;
  originLabel?: string;
  destinationLabel?: string;
  bufferMeters?: number;
  windowHours?: number;
};

export type RouteAnalysis = {
  candidates: RouteCandidate[];
  recommendedId: string | null;
  bufferMeters: number;
  analysedAt: string;
};

function threatsNearPath(path: LatLng[], reports: ThreatReport[], bufferMeters: number): RouteThreat[] {
  const out: RouteThreat[] = [];
  for (const report of reports) {
    const distance = distanceToPath(report.location, path);
    if (distance > bufferMeters) continue;
    out.push({
      reportId: report.id,
      reference: report.reference,
      threatType: report.threatType ?? report.aiSuggestions?.threatType ?? 'other',
      severity: report.severity ?? report.aiSuggestions?.severity ?? 'low',
      location: report.location,
      distanceFromRouteMeters: Math.round(distance),
      occurredAt: report.occurredAt,
      summary: report.aiSuggestions?.summary ?? report.description.slice(0, 120),
    });
  }
  return out;
}

const mockRoutesApi = {
  async analyze(input: RouteQueryInput): Promise<RouteAnalysis> {
    const data = parseOrThrow(routeQuerySchema, input);

    return request({ name: 'routes.analyze', limit: { key: 'routes.analyze' }, latency: [500, 1400] }, (profile) => {
      const cutoff = Date.now() - data.windowHours * 3_600_000;
      const org = db.table('organizations').find((o) => o.id === profile!.organizationId);
      const partners = org?.crossSharePartners ?? [];

      const verified = db
        .table('reports')
        .filter(
          (r) =>
            r.status === 'verified' &&
            Date.parse(r.occurredAt) >= cutoff &&
            (r.organizationId === profile!.organizationId || partners.includes(r.organizationId)),
        )
        .map((r) => (profile!.role === 'worker' ? redactForPeer(r, profile!.id) : r));

      const candidates: RouteCandidate[] = buildRouteCandidates(data.origin, data.destination).map((base) =>
        describeRoute(
          base,
          threatsNearPath(base.path, verified, data.bufferMeters),
          pathLengthMeters(base.path),
          data.bufferMeters,
        ),
      );

      // Never recommend a route carrying a critical incident inside the buffer,
      // whatever its aggregate score says.
      const eligible = candidates.filter((c) => c.highestSeverity !== 'critical');
      const pool = eligible.length ? eligible : candidates;
      const recommended = [...pool].sort(
        (a, b) => a.riskScore - b.riskScore || a.durationMinutes - b.durationMinutes,
      )[0];

      return {
        candidates,
        recommendedId: recommended?.id ?? null,
        bufferMeters: data.bufferMeters,
        analysedAt: new Date().toISOString(),
      };
    });
  },

  async analyzeCached(input: RouteQueryInput, viewerId: string): Promise<RouteAnalysis> {
    const key = cacheKey('routes.analyze', {
      originLat: input.origin.lat.toFixed(3),
      originLng: input.origin.lng.toFixed(3),
      destLat: input.destination.lat.toFixed(3),
      destLng: input.destination.lng.toFixed(3),
      buffer: input.bufferMeters,
      window: input.windowHours,
      viewer: viewerId,
    });
    return cache.fetch(key, () => mockRoutesApi.analyze(input), { ...POLICY.routes, tags: ['routes', 'reports'] });
  },

  /** Place suggestions for the origin/destination pickers. */
  async searchPlaces(query: string) {
    return request({ name: 'routes.searchPlaces', latency: [80, 200], flakiness: 0 }, () => {
      const q = query.trim().toLowerCase();
      if (!q) return PLACES.slice(0, 8);
      return PLACES.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 10);
    });
  },
};


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `routesApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const routesApi = API_MODE === 'supabase' ? supabaseRoutesApi : mockRoutesApi;
export { mockRoutesApi };
