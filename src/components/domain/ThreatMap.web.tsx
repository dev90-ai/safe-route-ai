import { useCallback, useMemo, useState } from 'react';
import { Pressable, View, type LayoutChangeEvent } from 'react-native';
import Svg, { Circle, G, Line, Path, Rect, Text as SvgText } from 'react-native-svg';

import { CORRIDORS, PLACES } from '@/constants/regions';
import { SEVERITY_META } from '@/constants/threats';
import { boundsOf, type LatLng } from '@/lib/geo';
import { useTheme } from '@/theme';
import { Text } from '../ui/Text';
import type { ThreatMapProps } from './map-types';

/**
 * Web map.
 *
 * react-native-maps has no web implementation, so the web build gets a
 * schematic map drawn in SVG: real road corridors, real place names, real
 * coordinates, equirectangular projection. It is not a tile map and does not
 * pretend to be - but every position, radius and route on it is accurate, which
 * is what the analysis actually depends on.
 */

const PAD = 14;

export function ThreatMap({
  threats = [],
  routes = [],
  markers = [],
  center,
  zoomRadiusMeters,
  selectedId,
  onSelectThreat,
  onMapPress,
  showRadii = false,
  height = 280,
  style,
}: ThreatMapProps) {
  const { colors, radius: tokens } = useTheme();
  const [size, setSize] = useState({ width: 0, height });

  const points = useMemo(
    () => [...threats.map((t) => t.point), ...markers.map((m) => m.point), ...routes.flatMap((r) => r.path)],
    [threats, markers, routes],
  );

  const bounds = useMemo(() => {
    if (center && zoomRadiusMeters) {
      const deg = (zoomRadiusMeters * 1.6) / 111_320;
      return { minLat: center.lat - deg, maxLat: center.lat + deg, minLng: center.lng - deg, maxLng: center.lng + deg };
    }
    if (!points.length) return { minLat: -2.2, maxLat: 4.4, minLng: 37.2, maxLng: 42.4 };
    return boundsOf(points, 0.22);
  }, [points, center, zoomRadiusMeters]);

  const { width } = size;
  const innerW = Math.max(1, width - PAD * 2);
  const innerH = Math.max(1, height - PAD * 2);

  // Equirectangular projection, corrected for latitude so distances stay honest.
  const latSpan = Math.max(1e-4, bounds.maxLat - bounds.minLat);
  const lngSpan = Math.max(1e-4, bounds.maxLng - bounds.minLng);

  const project = (p: LatLng) => ({
    x: PAD + ((p.lng - bounds.minLng) / lngSpan) * innerW,
    y: PAD + ((bounds.maxLat - p.lat) / latSpan) * innerH,
  });

  const unproject = (x: number, y: number): LatLng => ({
    lng: bounds.minLng + ((x - PAD) / innerW) * lngSpan,
    lat: bounds.maxLat - ((y - PAD) / innerH) * latSpan,
  });

  const metersToPx = (meters: number) => (meters / 111_320 / latSpan) * innerH;

  const onLayout = (e: LayoutChangeEvent) => {
    const { width: w, height: h } = e.nativeEvent.layout;
    setSize({ width: w, height: h });
  };

  // Memoised alongside its callers so the dependency is the bounds themselves,
  // not a function identity that changes on every render.
  const inView = useCallback(
    (p: LatLng) =>
      p.lat >= bounds.minLat && p.lat <= bounds.maxLat && p.lng >= bounds.minLng && p.lng <= bounds.maxLng,
    [bounds],
  );

  const visiblePlaces = useMemo(() => PLACES.filter((p) => inView(p.point)).slice(0, 14), [inView]);
  const visibleCorridors = useMemo(
    () => CORRIDORS.filter((c) => c.waypoints.some((w) => inView(w))),
    [inView],
  );

  const gridLines = 5;

  return (
    <Pressable
      onLayout={onLayout}
      onPress={
        onMapPress
          ? (e) => {
              const { locationX, locationY } = e.nativeEvent;
              onMapPress(unproject(locationX, locationY));
            }
          : undefined
      }
      accessibilityRole={onMapPress ? 'button' : 'image'}
      accessibilityLabel={
        onMapPress
          ? 'Map. Tap to place a pin at the incident location.'
          : `Map showing ${threats.length} verified threat${threats.length === 1 ? '' : 's'}.`
      }
      style={[
        {
          height,
          borderRadius: tokens.lg,
          overflow: 'hidden',
          borderWidth: 1,
          borderColor: colors.border,
          backgroundColor: colors.mapLand,
        },
        style,
      ]}
    >
      {width > 0 ? (
        <Svg width={width} height={height}>
          <Rect x={0} y={0} width={width} height={height} fill={colors.mapLand} />

          {/* Graticule - gives the eye a sense of scale without tiles. */}
          <G>
            {Array.from({ length: gridLines }).map((_, i) => {
              const y = PAD + (innerH / (gridLines - 1)) * i;
              return <Line key={`h${i}`} x1={0} y1={y} x2={width} y2={y} stroke={colors.mapGrid} strokeWidth={1} />;
            })}
            {Array.from({ length: gridLines }).map((_, i) => {
              const x = PAD + (innerW / (gridLines - 1)) * i;
              return <Line key={`v${i}`} x1={x} y1={0} x2={x} y2={height} stroke={colors.mapGrid} strokeWidth={1} />;
            })}
          </G>

          {/* Road corridors */}
          {visibleCorridors.map((corridor) => {
            const d = corridor.waypoints
              .map((w, i) => {
                const { x, y } = project(w);
                return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(' ');
            return <Path key={corridor.id} d={d} stroke={colors.mapRoad} strokeWidth={2.5} fill="none" strokeLinecap="round" />;
          })}

          {/* Alert radii, drawn under the pins */}
          {showRadii
            ? threats
                .filter((t) => t.radiusMeters)
                .map((threat) => {
                  const { x, y } = project(threat.point);
                  const tint = colors[SEVERITY_META[threat.severity].colorKey];
                  return (
                    <Circle
                      key={`r_${threat.id}`}
                      cx={x}
                      cy={y}
                      r={Math.max(3, metersToPx(threat.radiusMeters!))}
                      fill={`${tint}1A`}
                      stroke={`${tint}55`}
                      strokeWidth={1}
                    />
                  );
                })
            : null}

          {/* Candidate routes */}
          {routes.map((route) => {
            const d = route.path
              .map((p, i) => {
                const { x, y } = project(p);
                return `${i === 0 ? 'M' : 'L'}${x.toFixed(1)},${y.toFixed(1)}`;
              })
              .join(' ');
            return (
              <Path
                key={route.id}
                d={d}
                stroke={route.color}
                strokeWidth={route.active ? 4 : 2.5}
                strokeOpacity={route.active ? 1 : 0.55}
                strokeDasharray={route.dashed ? '7,5' : undefined}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            );
          })}

          {/* Place labels */}
          {visiblePlaces.map((place) => {
            const { x, y } = project(place.point);
            return (
              <G key={place.id}>
                <Circle cx={x} cy={y} r={2} fill={colors.textTertiary} opacity={0.6} />
                <SvgText x={x + 5} y={y + 3} fontSize={8.5} fill={colors.textTertiary} opacity={0.8}>
                  {place.name}
                </SvgText>
              </G>
            );
          })}

          {/* Threat pins - size encodes severity alongside colour */}
          {threats.map((threat) => {
            const { x, y } = project(threat.point);
            const tint = colors[SEVERITY_META[threat.severity].colorKey];
            const selected = selectedId === threat.id;
            const r = 4 + SEVERITY_META[threat.severity].rank * 1.4 + (selected ? 3 : 0);
            return (
              <G key={threat.id} onPress={onSelectThreat ? () => onSelectThreat(threat.id) : undefined}>
                {selected ? <Circle cx={x} cy={y} r={r + 5} fill={`${tint}33`} /> : null}
                <Circle cx={x} cy={y} r={r} fill={tint} stroke={colors.surface} strokeWidth={selected ? 2.5 : 1.5} />
              </G>
            );
          })}

          {/* Endpoint markers */}
          {markers.map((marker) => {
            const { x, y } = project(marker.point);
            return (
              <G key={marker.id}>
                <Circle cx={x} cy={y} r={6} fill={marker.color} stroke={colors.surface} strokeWidth={2} />
                <Rect
                  x={x + 9}
                  y={y - 8}
                  width={marker.label.length * 5.6 + 8}
                  height={15}
                  rx={4}
                  fill={marker.color}
                />
                <SvgText x={x + 13} y={y + 2.5} fontSize={9} fontWeight="700" fill={colors.white}>
                  {marker.label}
                </SvgText>
              </G>
            );
          })}
        </Svg>
      ) : null}

      <View
        style={{
          position: 'absolute',
          right: 8,
          bottom: 8,
          paddingHorizontal: 7,
          paddingVertical: 3,
          borderRadius: tokens.sm,
          backgroundColor: colors.overlay,
        }}
      >
        <Text variant="micro" tone="tertiary">
          Schematic view (web)
        </Text>
      </View>
    </Pressable>
  );
}
