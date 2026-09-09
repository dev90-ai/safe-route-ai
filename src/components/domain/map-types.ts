import type { Severity, ThreatType } from '@/constants/threats';
import type { LatLng } from '@/lib/geo';

/**
 * One props contract, two implementations.
 *
 * `ThreatMap.tsx` renders with react-native-maps on device; `ThreatMap.web.tsx`
 * renders an equivalent schematic map in SVG, because react-native-maps has no
 * web build. Screens import `ThreatMap` and never learn which one they got.
 */

export type MapThreat = {
  id: string;
  point: LatLng;
  severity: Severity;
  threatType: ThreatType;
  label: string;
  /** Alert radius, drawn as a translucent circle when `showRadii` is on. */
  radiusMeters?: number | null;
};

export type MapRoute = {
  id: string;
  path: LatLng[];
  color: string;
  active?: boolean;
  dashed?: boolean;
};

export type MapMarker = {
  id: string;
  point: LatLng;
  label: string;
  color: string;
  kind: 'origin' | 'destination' | 'user' | 'pin' | 'sos';
};

export type ThreatMapProps = {
  threats?: MapThreat[];
  routes?: MapRoute[];
  markers?: MapMarker[];
  /** Explicit centre. When omitted the map frames everything it was given. */
  center?: LatLng | null;
  zoomRadiusMeters?: number;
  selectedId?: string | null;
  onSelectThreat?: (id: string) => void;
  /** Enables drop-a-pin. The presence of this prop turns the map into an input. */
  onMapPress?: (point: LatLng) => void;
  showsUserLocation?: boolean;
  showRadii?: boolean;
  interactive?: boolean;
  height?: number;
  style?: object;
};
