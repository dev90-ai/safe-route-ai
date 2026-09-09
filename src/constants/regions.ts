import type { LatLng } from '@/lib/geo';

/**
 * Operating regions for North Eastern Kenya.
 *
 * Regions are sub-county granularity because that is the unit humanitarian
 * organisations actually deploy against, and it is coarse enough that declaring
 * one in a profile does not disclose where an individual worker sleeps.
 */

export type County = 'Garissa' | 'Wajir' | 'Mandera' | 'Isiolo' | 'Marsabit' | 'Tana River';

export type Region = {
  id: string;
  name: string;
  county: County;
  center: LatLng;
  /** Nominal radius in metres - used for "threat falls inside my region" tests. */
  radiusMeters: number;
};

export const REGIONS: Region[] = [
  // --- Garissa County ---
  { id: 'garissa-township', name: 'Garissa Township', county: 'Garissa', center: { lat: -0.4569, lng: 39.6583 }, radiusMeters: 25_000 },
  { id: 'dadaab', name: 'Dadaab', county: 'Garissa', center: { lat: 0.0553, lng: 40.3086 }, radiusMeters: 45_000 },
  { id: 'fafi', name: 'Fafi', county: 'Garissa', center: { lat: -0.55, lng: 40.05 }, radiusMeters: 50_000 },
  { id: 'ijara', name: 'Ijara', county: 'Garissa', center: { lat: -1.5936, lng: 40.5261 }, radiusMeters: 50_000 },
  { id: 'hulugho', name: 'Hulugho', county: 'Garissa', center: { lat: -1.15, lng: 41.05 }, radiusMeters: 45_000 },
  { id: 'lagdera', name: 'Lagdera (Modogashe)', county: 'Garissa', center: { lat: 0.7167, lng: 39.6833 }, radiusMeters: 50_000 },
  { id: 'balambala', name: 'Balambala', county: 'Garissa', center: { lat: -0.0667, lng: 39.6333 }, radiusMeters: 40_000 },

  // --- Wajir County ---
  { id: 'wajir-east', name: 'Wajir East', county: 'Wajir', center: { lat: 1.7471, lng: 40.0573 }, radiusMeters: 40_000 },
  { id: 'wajir-west', name: 'Wajir West (Griftu)', county: 'Wajir', center: { lat: 1.7333, lng: 39.7 }, radiusMeters: 45_000 },
  { id: 'wajir-north', name: 'Wajir North (Bute)', county: 'Wajir', center: { lat: 2.7667, lng: 39.8167 }, radiusMeters: 50_000 },
  { id: 'wajir-south', name: 'Wajir South (Habaswein)', county: 'Wajir', center: { lat: 1.0117, lng: 39.4906 }, radiusMeters: 50_000 },
  { id: 'tarbaj', name: 'Tarbaj', county: 'Wajir', center: { lat: 1.9333, lng: 40.4667 }, radiusMeters: 45_000 },
  { id: 'eldas', name: 'Eldas', county: 'Wajir', center: { lat: 2.5167, lng: 39.5833 }, radiusMeters: 45_000 },

  // --- Mandera County ---
  { id: 'mandera-east', name: 'Mandera East', county: 'Mandera', center: { lat: 3.9366, lng: 41.867 }, radiusMeters: 35_000 },
  { id: 'mandera-north', name: 'Mandera North (Rhamu)', county: 'Mandera', center: { lat: 3.9333, lng: 41.2167 }, radiusMeters: 40_000 },
  { id: 'mandera-west', name: 'Mandera West (Takaba)', county: 'Mandera', center: { lat: 3.4167, lng: 40.2167 }, radiusMeters: 45_000 },
  { id: 'mandera-south', name: 'Mandera South (El Wak)', county: 'Mandera', center: { lat: 2.8, lng: 40.9333 }, radiusMeters: 45_000 },
  { id: 'banissa', name: 'Banissa', county: 'Mandera', center: { lat: 3.9167, lng: 40.3167 }, radiusMeters: 40_000 },
  { id: 'lafey', name: 'Lafey', county: 'Mandera', center: { lat: 3.6333, lng: 41.5167 }, radiusMeters: 40_000 },

  // --- Adjacent corridors humanitarian convoys routinely transit ---
  { id: 'isiolo', name: 'Isiolo', county: 'Isiolo', center: { lat: 0.3546, lng: 37.5822 }, radiusMeters: 40_000 },
  { id: 'moyale', name: 'Moyale', county: 'Marsabit', center: { lat: 3.5231, lng: 39.0561 }, radiusMeters: 35_000 },
  { id: 'tana-delta', name: 'Tana Delta (Hola)', county: 'Tana River', center: { lat: -1.4989, lng: 40.0306 }, radiusMeters: 45_000 },
];

export const REGIONS_BY_ID: Record<string, Region> = Object.fromEntries(REGIONS.map((r) => [r.id, r]));

export const COUNTIES: County[] = ['Garissa', 'Wajir', 'Mandera', 'Isiolo', 'Marsabit', 'Tana River'];

export function regionName(id: string): string {
  return REGIONS_BY_ID[id]?.name ?? id;
}

export function regionNames(ids: string[]): string {
  if (!ids.length) return 'No regions set';
  const names = ids.map(regionName);
  if (names.length <= 2) return names.join(' & ');
  return `${names.slice(0, 2).join(', ')} +${names.length - 2}`;
}

/** Which declared region a coordinate falls inside, if any. */
export function regionForPoint(point: LatLng, candidateIds?: string[]): Region | null {
  const pool = candidateIds?.length ? candidateIds.map((id) => REGIONS_BY_ID[id]).filter(Boolean) : REGIONS;
  let best: Region | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const region of pool as Region[]) {
    const dLat = (point.lat - region.center.lat) * 111_320;
    const dLng = (point.lng - region.center.lng) * 111_320 * Math.cos((point.lat * Math.PI) / 180);
    const dist = Math.hypot(dLat, dLng);
    if (dist <= region.radiusMeters && dist < bestDist) {
      best = region;
      bestDist = dist;
    }
  }
  return best;
}

/**
 * Named places used as origin/destination suggestions in Safe Route, and as
 * human-readable labels on the map. Includes the field sites and the road
 * junctions that matter for convoy planning.
 */
export type Place = { id: string; name: string; region: string; point: LatLng; kind: 'town' | 'camp' | 'field-site' | 'junction' };

export const PLACES: Place[] = [
  { id: 'garissa-town', name: 'Garissa Town', region: 'garissa-township', point: { lat: -0.4569, lng: 39.6583 }, kind: 'town' },
  { id: 'garissa-hub', name: 'Garissa Logistics Hub', region: 'garissa-township', point: { lat: -0.4497, lng: 39.6404 }, kind: 'field-site' },
  { id: 'dadaab-town', name: 'Dadaab Town', region: 'dadaab', point: { lat: 0.0553, lng: 40.3086 }, kind: 'town' },
  { id: 'ifo-camp', name: 'Ifo Camp', region: 'dadaab', point: { lat: 0.1167, lng: 40.3167 }, kind: 'camp' },
  { id: 'dagahaley-camp', name: 'Dagahaley Camp', region: 'dadaab', point: { lat: 0.1533, lng: 40.2867 }, kind: 'camp' },
  { id: 'hagadera-camp', name: 'Hagadera Camp', region: 'dadaab', point: { lat: 0.0, lng: 40.35 }, kind: 'camp' },
  { id: 'modogashe', name: 'Modogashe', region: 'lagdera', point: { lat: 0.7167, lng: 39.6833 }, kind: 'town' },
  { id: 'balambala-town', name: 'Balambala', region: 'balambala', point: { lat: -0.0667, lng: 39.6333 }, kind: 'town' },
  { id: 'bura-junction', name: 'Bura Junction', region: 'fafi', point: { lat: -1.1, lng: 39.85 }, kind: 'junction' },
  { id: 'masalani', name: 'Masalani', region: 'ijara', point: { lat: -1.6897, lng: 40.1244 }, kind: 'town' },
  { id: 'wajir-town', name: 'Wajir Town', region: 'wajir-east', point: { lat: 1.7471, lng: 40.0573 }, kind: 'town' },
  { id: 'habaswein', name: 'Habaswein', region: 'wajir-south', point: { lat: 1.0117, lng: 39.4906 }, kind: 'town' },
  { id: 'griftu', name: 'Griftu', region: 'wajir-west', point: { lat: 1.7333, lng: 39.7 }, kind: 'town' },
  { id: 'bute', name: 'Bute', region: 'wajir-north', point: { lat: 2.7667, lng: 39.8167 }, kind: 'town' },
  { id: 'tarbaj-town', name: 'Tarbaj', region: 'tarbaj', point: { lat: 1.9333, lng: 40.4667 }, kind: 'town' },
  { id: 'mandera-town', name: 'Mandera Town', region: 'mandera-east', point: { lat: 3.9366, lng: 41.867 }, kind: 'town' },
  { id: 'el-wak', name: 'El Wak', region: 'mandera-south', point: { lat: 2.8, lng: 40.9333 }, kind: 'town' },
  { id: 'rhamu', name: 'Rhamu', region: 'mandera-north', point: { lat: 3.9333, lng: 41.2167 }, kind: 'town' },
  { id: 'takaba', name: 'Takaba', region: 'mandera-west', point: { lat: 3.4167, lng: 40.2167 }, kind: 'town' },
  { id: 'banissa-town', name: 'Banissa', region: 'banissa', point: { lat: 3.9167, lng: 40.3167 }, kind: 'town' },
  { id: 'lafey-town', name: 'Lafey', region: 'lafey', point: { lat: 3.6333, lng: 41.5167 }, kind: 'town' },
  { id: 'isiolo-town', name: 'Isiolo Town', region: 'isiolo', point: { lat: 0.3546, lng: 37.5822 }, kind: 'town' },
  { id: 'moyale-town', name: 'Moyale', region: 'moyale', point: { lat: 3.5231, lng: 39.0561 }, kind: 'town' },
  { id: 'hola', name: 'Hola', region: 'tana-delta', point: { lat: -1.4989, lng: 40.0306 }, kind: 'town' },
];

export const PLACES_BY_ID: Record<string, Place> = Object.fromEntries(PLACES.map((p) => [p.id, p]));

/**
 * The road corridors Safe Route builds candidate routes along. Real routing
 * comes from the Directions API in production; these waypoint chains keep the
 * mock geometrically honest so the PostGIS buffer maths is exercised properly.
 */
export type Corridor = { id: string; name: string; waypoints: LatLng[] };

export const CORRIDORS: Corridor[] = [
  {
    id: 'a3-garissa-dadaab',
    name: 'Garissa - Dadaab (A3 / Dadaab Road)',
    waypoints: [
      { lat: -0.4569, lng: 39.6583 },
      { lat: -0.24, lng: 39.83 },
      { lat: -0.05, lng: 40.0 },
      { lat: 0.02, lng: 40.18 },
      { lat: 0.0553, lng: 40.3086 },
    ],
  },
  {
    id: 'garissa-modogashe-wajir',
    name: 'Garissa - Modogashe - Wajir',
    waypoints: [
      { lat: -0.4569, lng: 39.6583 },
      { lat: -0.0667, lng: 39.6333 },
      { lat: 0.7167, lng: 39.6833 },
      { lat: 1.0117, lng: 39.4906 },
      { lat: 1.45, lng: 39.75 },
      { lat: 1.7471, lng: 40.0573 },
    ],
  },
  {
    id: 'wajir-elwak-mandera',
    name: 'Wajir - El Wak - Mandera',
    waypoints: [
      { lat: 1.7471, lng: 40.0573 },
      { lat: 1.9333, lng: 40.4667 },
      { lat: 2.8, lng: 40.9333 },
      { lat: 3.4, lng: 41.35 },
      { lat: 3.6333, lng: 41.5167 },
      { lat: 3.9366, lng: 41.867 },
    ],
  },
  {
    id: 'garissa-ijara',
    name: 'Garissa - Bura - Masalani (Ijara Road)',
    waypoints: [
      { lat: -0.4569, lng: 39.6583 },
      { lat: -0.85, lng: 39.78 },
      { lat: -1.1, lng: 39.85 },
      { lat: -1.45, lng: 40.02 },
      { lat: -1.6897, lng: 40.1244 },
    ],
  },
  {
    id: 'isiolo-wajir',
    name: 'Isiolo - Modogashe - Wajir (A13)',
    waypoints: [
      { lat: 0.3546, lng: 37.5822 },
      { lat: 0.55, lng: 38.35 },
      { lat: 0.7167, lng: 39.6833 },
      { lat: 1.2, lng: 39.8 },
      { lat: 1.7471, lng: 40.0573 },
    ],
  },
];
