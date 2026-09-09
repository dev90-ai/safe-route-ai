import { PLACES } from '@/constants/regions';
import type { Severity } from '@/constants/threats';
import { pathLengthMeters, type LatLng } from '@/lib/geo';
import { parseOrThrow, routeQuerySchema } from '@/lib/validation';
import { rateLimiter } from '../rateLimit';
import type { RouteCandidate, RouteThreat } from '../types';
import type { RouteAnalysis, RouteQueryInput } from '../endpoints/routes';
import { buildRouteCandidates, describeRoute, scoreRoute } from '../routing';
import { call } from './call';
import { supabase } from './client';
import { toGeoJSONLine } from './mappers';

/**
 * Safe Route, backed by PostGIS.
 *
 * The candidate geometry is still synthesised from the real road corridors -
 * that only changes when a Directions API is wired in. What is real here is the
 * analysis: `threats_near_route` runs `ST_DWithin` against the route line in
 * Postgres, so the buffer query the mock approximated is now genuinely spatial.
 */
export const supabaseRoutesApi = {
  async analyze(input: RouteQueryInput): Promise<RouteAnalysis> {
    const data = parseOrThrow(routeQuerySchema, input);
    await rateLimiter.consume('routes.analyze');

    const bufferMeters = data.bufferMeters ?? 2000;
    const windowHours = data.windowHours ?? 24 * 30;
    const bases = buildRouteCandidates(data.origin, data.destination);

    const candidates: RouteCandidate[] = await Promise.all(
      bases.map(async (base) => {
        const rows = await call('routes.threatsNearRoute', () =>
          supabase().rpc('threats_near_route', {
            route_geojson: toGeoJSONLine(base.path),
            buffer_meters: bufferMeters,
            window_hours: windowHours,
          }),
        );

        const threats: RouteThreat[] = (rows ?? []).map((r: Record<string, any>) => ({
          reportId: r.report_id,
          reference: r.reference,
          threatType: r.threat_type,
          severity: r.severity as Severity,
          location: { lat: r.lat, lng: r.lng },
          distanceFromRouteMeters: r.distance_from_route_meters,
          occurredAt: r.occurred_at,
          summary: r.reference,
        }));

        const distance = pathLengthMeters(base.path);
        return describeRoute(base, threats, distance, bufferMeters);
      }),
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
      bufferMeters,
      analysedAt: new Date().toISOString(),
    };
  },

  async analyzeCached(input: RouteQueryInput, _viewerId: string): Promise<RouteAnalysis> {
    return supabaseRoutesApi.analyze(input);
  },

  async searchPlaces(query: string) {
    const q = query.trim().toLowerCase();
    if (!q) return PLACES.slice(0, 8);
    return PLACES.filter((p) => p.name.toLowerCase().includes(q)).slice(0, 10);
  },
};

export type { LatLng };
void scoreRoute;
