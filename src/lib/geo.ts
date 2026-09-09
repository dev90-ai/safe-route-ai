/**
 * Geospatial helpers.
 *
 * These mirror the PostGIS operations the real backend will run, so the screens
 * built against the mock API keep working unchanged once the queries move
 * server-side:
 *   distanceMeters       -> ST_Distance(geography, geography)
 *   isWithin             -> ST_DWithin(geography, geography, radius)
 *   threatsNearRoute     -> ST_DWithin(route_line::geography, threat, buffer)
 */

export type LatLng = { lat: number; lng: number };

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;
const toDeg = (rad: number) => (rad * 180) / Math.PI;

/** Great-circle distance in metres (haversine). */
export function distanceMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.sin(dLng / 2) ** 2 * Math.cos(lat1) * Math.cos(lat2);
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** ST_DWithin equivalent. */
export function isWithin(a: LatLng, b: LatLng, radiusMeters: number): boolean {
  return distanceMeters(a, b) <= radiusMeters;
}

/** Initial bearing from a to b, in degrees clockwise from north. */
export function bearing(a: LatLng, b: LatLng): number {
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const dLng = toRad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(lat2);
  const x = Math.cos(lat1) * Math.sin(lat2) - Math.sin(lat1) * Math.cos(lat2) * Math.cos(dLng);
  return (toDeg(Math.atan2(y, x)) + 360) % 360;
}

export function compassPoint(deg: number): string {
  const points = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return points[Math.round(deg / 45) % 8];
}

/** Move `meters` from an origin along a bearing. Used to synthesise route legs. */
export function destinationPoint(origin: LatLng, meters: number, bearingDeg: number): LatLng {
  const angular = meters / EARTH_RADIUS_M;
  const brg = toRad(bearingDeg);
  const lat1 = toRad(origin.lat);
  const lng1 = toRad(origin.lng);

  const lat2 = Math.asin(
    Math.sin(lat1) * Math.cos(angular) + Math.cos(lat1) * Math.sin(angular) * Math.cos(brg),
  );
  const lng2 =
    lng1 +
    Math.atan2(
      Math.sin(brg) * Math.sin(angular) * Math.cos(lat1),
      Math.cos(angular) - Math.sin(lat1) * Math.sin(lat2),
    );

  return { lat: toDeg(lat2), lng: ((toDeg(lng2) + 540) % 360) - 180 };
}

/** Perpendicular distance from a point to a segment, in metres. */
export function distanceToSegment(p: LatLng, a: LatLng, b: LatLng): number {
  // Work in a local equirectangular projection - accurate enough over the few
  // kilometres a single route segment spans.
  const latRef = toRad((a.lat + b.lat) / 2);
  const x = (pt: LatLng) => toRad(pt.lng) * Math.cos(latRef) * EARTH_RADIUS_M;
  const y = (pt: LatLng) => toRad(pt.lat) * EARTH_RADIUS_M;

  const px = x(p);
  const py = y(p);
  const ax = x(a);
  const ay = y(a);
  const bx = x(b);
  const by = y(b);

  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(px - ax, py - ay);

  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / lenSq));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Shortest distance from a point to a polyline, in metres. */
export function distanceToPath(p: LatLng, path: LatLng[]): number {
  if (path.length === 0) return Number.POSITIVE_INFINITY;
  if (path.length === 1) return distanceMeters(p, path[0]);
  let min = Number.POSITIVE_INFINITY;
  for (let i = 0; i < path.length - 1; i += 1) {
    min = Math.min(min, distanceToSegment(p, path[i], path[i + 1]));
    if (min === 0) break;
  }
  return min;
}

export function pathLengthMeters(path: LatLng[]): number {
  let total = 0;
  for (let i = 0; i < path.length - 1; i += 1) total += distanceMeters(path[i], path[i + 1]);
  return total;
}

export type Bounds = { minLat: number; maxLat: number; minLng: number; maxLng: number };

export function boundsOf(points: LatLng[], padRatio = 0.18): Bounds {
  if (points.length === 0) return { minLat: -1, maxLat: 1, minLng: -1, maxLng: 1 };
  let minLat = points[0].lat;
  let maxLat = points[0].lat;
  let minLng = points[0].lng;
  let maxLng = points[0].lng;
  for (const p of points) {
    minLat = Math.min(minLat, p.lat);
    maxLat = Math.max(maxLat, p.lat);
    minLng = Math.min(minLng, p.lng);
    maxLng = Math.max(maxLng, p.lng);
  }
  const latPad = Math.max((maxLat - minLat) * padRatio, 0.02);
  const lngPad = Math.max((maxLng - minLng) * padRatio, 0.02);
  return {
    minLat: minLat - latPad,
    maxLat: maxLat + latPad,
    minLng: minLng - lngPad,
    maxLng: maxLng + lngPad,
  };
}

export function centerOf(points: LatLng[]): LatLng {
  if (!points.length) return { lat: 0, lng: 0 };
  const sum = points.reduce((acc, p) => ({ lat: acc.lat + p.lat, lng: acc.lng + p.lng }), { lat: 0, lng: 0 });
  return { lat: sum.lat / points.length, lng: sum.lng / points.length };
}

export function formatDistance(meters: number): string {
  if (!Number.isFinite(meters)) return '-';
  if (meters < 950) return `${Math.round(meters / 10) * 10} m`;
  if (meters < 10_000) return `${(meters / 1000).toFixed(1)} km`;
  return `${Math.round(meters / 1000)} km`;
}

export function formatRadius(meters: number): string {
  if (meters < 1000) return `${meters} m`;
  const km = meters / 1000;
  return `${Number.isInteger(km) ? km : km.toFixed(1)} km`;
}

/** Jitter a coordinate by up to `meters` - used to blur reporter positions. */
export function jitter(point: LatLng, meters: number, seed: number): LatLng {
  const rand = (n: number) => {
    const x = Math.sin(seed * 9301 + n * 49297) * 233280;
    return x - Math.floor(x);
  };
  return destinationPoint(point, rand(1) * meters, rand(2) * 360);
}
