import { CORRIDORS } from '@/constants/regions';
import { SEVERITY_META, THREAT_META, highestSeverity, severityRank, type Severity } from '@/constants/threats';
import { bearing, destinationPoint, distanceMeters, type LatLng } from '@/lib/geo';
import type { RouteCandidate, RouteThreat } from './types';

/**
 * Route construction and risk scoring, shared by both transports.
 *
 * Candidate geometry is synthesised from the real road corridors in
 * `constants/regions`; a Directions API replaces only `buildRouteCandidates`.
 * The scoring below is the part that carries meaning, and it is identical
 * whether the threats came from the mock or from PostGIS - so a route ranks the
 * same way in a demo as it does in the field.
 */

const SEVERITY_WEIGHT: Record<Severity, number> = { low: 1, medium: 3, high: 8, critical: 20 };

export type RouteBase = {
  id: string;
  label: string;
  summary: string;
  path: LatLng[];
  corridorId: string | null;
  kind: 'corridor' | 'direct' | 'detour';
};

function interpolate(from: LatLng, to: LatLng, steps: number): LatLng[] {
  const out: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    out.push({ lat: from.lat + (to.lat - from.lat) * t, lng: from.lng + (to.lng - from.lng) * t });
  }
  return out;
}

/** Bend a path sideways at its midpoint, producing a plausible alternative. */
function bowedPath(from: LatLng, to: LatLng, offsetMeters: number, steps = 24): LatLng[] {
  const perpendicular = (bearing(from, to) + 90) % 360;
  const mid = { lat: (from.lat + to.lat) / 2, lng: (from.lng + to.lng) / 2 };
  const control = destinationPoint(mid, offsetMeters, perpendicular);

  const out: LatLng[] = [];
  for (let i = 0; i <= steps; i += 1) {
    const t = i / steps;
    const inv = 1 - t;
    out.push({
      lat: inv * inv * from.lat + 2 * inv * t * control.lat + t * t * to.lat,
      lng: inv * inv * from.lng + 2 * inv * t * control.lng + t * t * to.lng,
    });
  }
  return out;
}

/** Snap onto a known corridor when one runs roughly between the two points. */
function corridorPath(from: LatLng, to: LatLng): { path: LatLng[]; corridorId: string; name: string } | null {
  let best: { path: LatLng[]; corridorId: string; name: string; penalty: number } | null = null;

  for (const corridor of CORRIDORS) {
    const entry = corridor.waypoints.map((w, i) => ({ i, d: distanceMeters(w, from) })).sort((a, b) => a.d - b.d)[0];
    const exit = corridor.waypoints.map((w, i) => ({ i, d: distanceMeters(w, to) })).sort((a, b) => a.d - b.d)[0];

    if (entry.i === exit.i) continue;
    const penalty = entry.d + exit.d;
    // Only useful if both endpoints are genuinely near the corridor.
    if (penalty > 90_000) continue;

    const slice =
      entry.i < exit.i
        ? corridor.waypoints.slice(entry.i, exit.i + 1)
        : [...corridor.waypoints.slice(exit.i, entry.i + 1)].reverse();

    const path = [
      ...interpolate(from, slice[0], 4),
      ...slice.flatMap((w, i) => (i === 0 ? [] : interpolate(slice[i - 1], w, 6).slice(1))),
      ...interpolate(slice[slice.length - 1], to, 4).slice(1),
    ];

    if (!best || penalty < best.penalty) {
      best = { path, corridorId: corridor.id, name: corridor.name, penalty };
    }
  }

  return best ? { path: best.path, corridorId: best.corridorId, name: best.name } : null;
}

/** Conservative average speeds by road quality. */
function estimateMinutes(meters: number, kind: RouteBase['kind']): number {
  const kmh = kind === 'corridor' ? 58 : kind === 'direct' ? 45 : 38;
  return Math.round((meters / 1000 / kmh) * 60);
}

function bandFor(score: number): RouteCandidate['riskBand'] {
  if (score === 0) return 'low';
  if (score < 6) return 'moderate';
  if (score < 18) return 'elevated';
  if (score < 40) return 'high';
  return 'severe';
}

/**
 * Score a route.
 *
 * Recency and proximity both decay: a critical ambush 200 m off the road last
 * night matters far more than the same event 1.9 km away a month ago, and the
 * number has to say so.
 */
export function scoreRoute(threats: RouteThreat[], bufferMeters: number): number {
  let score = 0;
  for (const threat of threats) {
    const ageDays = (Date.now() - Date.parse(threat.occurredAt)) / 86_400_000;
    const recency = Math.exp(-ageDays / 14);
    const proximity = 1 - Math.min(1, threat.distanceFromRouteMeters / bufferMeters) * 0.7;
    score += SEVERITY_WEIGHT[threat.severity] * recency * proximity;
  }
  return Number(score.toFixed(1));
}

function advisoryFor(candidate: Omit<RouteCandidate, 'advisory'>): string {
  if (candidate.incidentCount === 0) {
    return 'No verified incidents recorded within the analysis buffer of this route in the selected window. Standard precautions still apply.';
  }

  const worst = candidate.highestSeverity!;
  const closest = [...candidate.threats].sort((a, b) => a.distanceFromRouteMeters - b.distanceFromRouteMeters)[0];
  const recent = [...candidate.threats].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))[0];

  const parts = [
    `${candidate.incidentCount} verified incident${candidate.incidentCount === 1 ? '' : 's'} near this route, the most serious rated ${SEVERITY_META[worst].label.toLowerCase()}.`,
    `Closest is ${THREAT_META[closest.threatType].label.toLowerCase()} about ${Math.round(closest.distanceFromRouteMeters / 100) * 100} m from the road.`,
  ];

  if (severityRank(worst) >= 3) parts.push(SEVERITY_META[worst].guidance);
  else parts.push(`Most recent activity was ${THREAT_META[recent.threatType].label.toLowerCase()}. Brief the driver before departure.`);

  return parts.join(' ');
}

/** Assemble a scored, described candidate from its geometry and threats. */
export function describeRoute(
  base: RouteBase,
  threats: RouteThreat[],
  distanceMetersTotal: number,
  bufferMeters: number,
): RouteCandidate {
  const sorted = [...threats].sort((a, b) => a.distanceFromRouteMeters - b.distanceFromRouteMeters);
  const partial: Omit<RouteCandidate, 'advisory'> = {
    id: base.id,
    label: base.label,
    summary: base.summary,
    path: base.path,
    distanceMeters: Math.round(distanceMetersTotal),
    durationMinutes: estimateMinutes(distanceMetersTotal, base.kind),
    corridorId: base.corridorId,
    threats: sorted,
    incidentCount: sorted.length,
    highestSeverity: highestSeverity(sorted.map((t) => t.severity)),
    riskScore: scoreRoute(sorted, bufferMeters),
    riskBand: bandFor(scoreRoute(sorted, bufferMeters)),
  };

  return { ...partial, advisory: advisoryFor(partial) };
}

export function buildRouteCandidates(origin: LatLng, destination: LatLng): RouteBase[] {
  const candidates: RouteBase[] = [];
  const straightLine = distanceMeters(origin, destination);

  const corridor = corridorPath(origin, destination);
  if (corridor) {
    candidates.push({
      id: 'route_main',
      label: 'Main road',
      summary: corridor.name,
      path: corridor.path,
      corridorId: corridor.corridorId,
      kind: 'corridor',
    });
  }

  candidates.push({
    id: 'route_direct',
    label: corridor ? 'Direct track' : 'Primary route',
    summary: corridor ? 'Shorter cross-country track, lower road quality' : 'Most direct available line',
    path: bowedPath(origin, destination, straightLine * 0.04, 20),
    corridorId: null,
    kind: 'direct',
  });

  // A meaningful detour only exists over a real distance.
  if (straightLine > 12_000) {
    candidates.push({
      id: 'route_alternate',
      label: 'Northern detour',
      summary: 'Longer alternative avoiding the direct axis',
      path: bowedPath(origin, destination, -straightLine * 0.22, 26),
      corridorId: null,
      kind: 'detour',
    });
  }

  return candidates;
}
