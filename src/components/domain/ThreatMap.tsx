import { useEffect, useMemo, useRef } from 'react';
import { View } from 'react-native';
import MapView, { Circle, Marker, Polyline, PROVIDER_DEFAULT, type Region } from 'react-native-maps';

import { SEVERITY_META } from '@/constants/threats';
import { boundsOf, centerOf, type LatLng } from '@/lib/geo';
import { useTheme } from '@/theme';
import { Text } from '../ui/Text';
import type { ThreatMapProps } from './map-types';

/**
 * Native map. Renders verified threats, alert radii, candidate routes and
 * endpoint markers over the platform map.
 *
 * Severity is carried by colour AND by pin size, so the map stays readable for
 * colour-blind users and in bright sunlight where hue separation collapses.
 */

const DEG_PER_METER = 1 / 111_320;

function regionFor(points: LatLng[], zoomRadiusMeters?: number, center?: LatLng | null): Region {
  if (center && zoomRadiusMeters) {
    const delta = (zoomRadiusMeters * 2.4) * DEG_PER_METER;
    return { latitude: center.lat, longitude: center.lng, latitudeDelta: delta, longitudeDelta: delta };
  }

  if (!points.length) {
    // Garissa, so an empty map still shows the operating area rather than the sea.
    return { latitude: -0.4569, longitude: 39.6583, latitudeDelta: 2.4, longitudeDelta: 2.4 };
  }

  const bounds = boundsOf(points, 0.25);
  const mid = centerOf(points);
  return {
    latitude: center?.lat ?? mid.lat,
    longitude: center?.lng ?? mid.lng,
    latitudeDelta: Math.max(0.05, bounds.maxLat - bounds.minLat),
    longitudeDelta: Math.max(0.05, bounds.maxLng - bounds.minLng),
  };
}

export function ThreatMap({
  threats = [],
  routes = [],
  markers = [],
  center,
  zoomRadiusMeters,
  selectedId,
  onSelectThreat,
  onMapPress,
  showsUserLocation = true,
  showRadii = false,
  interactive = true,
  height = 280,
  style,
}: ThreatMapProps) {
  const { colors, radius, scheme } = useTheme();
  const mapRef = useRef<MapView>(null);

  const allPoints = useMemo(
    () => [
      ...threats.map((t) => t.point),
      ...markers.map((m) => m.point),
      ...routes.flatMap((r) => r.path),
    ],
    [threats, markers, routes],
  );

  const initialRegion = useMemo(
    () => regionFor(allPoints, zoomRadiusMeters, center),
    [allPoints, zoomRadiusMeters, center],
  );

  // Re-frame when the content changes materially (new route, new filter).
  const signature = `${threats.length}:${routes.length}:${markers.length}:${center?.lat ?? ''}`;
  useEffect(() => {
    if (!mapRef.current) return;
    const region = regionFor(allPoints, zoomRadiusMeters, center);
    mapRef.current.animateToRegion(region, 480);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  return (
    <View style={[{ height, borderRadius: radius.lg, overflow: 'hidden', borderWidth: 1, borderColor: colors.border }, style]}>
      <MapView
        ref={mapRef}
        provider={PROVIDER_DEFAULT}
        style={{ flex: 1 }}
        initialRegion={initialRegion}
        showsUserLocation={showsUserLocation}
        showsMyLocationButton={false}
        showsCompass={interactive}
        toolbarEnabled={false}
        scrollEnabled={interactive}
        zoomEnabled={interactive}
        rotateEnabled={false}
        pitchEnabled={false}
        userInterfaceStyle={scheme}
        onPress={onMapPress ? (e) => onMapPress({ lat: e.nativeEvent.coordinate.latitude, lng: e.nativeEvent.coordinate.longitude }) : undefined}
      >
        {showRadii
          ? threats
              .filter((t) => t.radiusMeters)
              .map((threat) => {
                const tint = colors[SEVERITY_META[threat.severity].colorKey];
                return (
                  <Circle
                    key={`radius_${threat.id}`}
                    center={{ latitude: threat.point.lat, longitude: threat.point.lng }}
                    radius={threat.radiusMeters!}
                    strokeColor={`${tint}66`}
                    fillColor={`${tint}1A`}
                    strokeWidth={1}
                  />
                );
              })
          : null}

        {routes.map((route) => (
          <Polyline
            key={route.id}
            coordinates={route.path.map((p) => ({ latitude: p.lat, longitude: p.lng }))}
            strokeColor={route.color}
            strokeWidth={route.active ? 5 : 3}
            lineDashPattern={route.dashed ? [8, 6] : undefined}
            lineCap="round"
            zIndex={route.active ? 3 : 1}
          />
        ))}

        {threats.map((threat) => {
          const tint = colors[SEVERITY_META[threat.severity].colorKey];
          const selected = selectedId === threat.id;
          const size = 12 + SEVERITY_META[threat.severity].rank * 3 + (selected ? 6 : 0);
          return (
            <Marker
              key={threat.id}
              coordinate={{ latitude: threat.point.lat, longitude: threat.point.lng }}
              onPress={() => onSelectThreat?.(threat.id)}
              tracksViewChanges={false}
              anchor={{ x: 0.5, y: 0.5 }}
              accessibilityLabel={threat.label}
            >
              <View
                style={{
                  width: size,
                  height: size,
                  borderRadius: size / 2,
                  backgroundColor: tint,
                  borderWidth: selected ? 3 : 2,
                  borderColor: colors.surface,
                }}
              />
            </Marker>
          );
        })}

        {markers.map((marker) => (
          <Marker
            key={marker.id}
            coordinate={{ latitude: marker.point.lat, longitude: marker.point.lng }}
            tracksViewChanges={false}
            anchor={{ x: 0.5, y: marker.kind === 'pin' ? 1 : 0.5 }}
            accessibilityLabel={marker.label}
          >
            <View style={{ alignItems: 'center' }}>
              <View
                style={{
                  paddingHorizontal: 7,
                  paddingVertical: 3,
                  borderRadius: radius.sm,
                  backgroundColor: marker.color,
                  borderWidth: 1,
                  borderColor: colors.surface,
                }}
              >
                <Text variant="micro" weight="700" color={colors.white}>
                  {marker.label}
                </Text>
              </View>
              <View
                style={{
                  width: 0,
                  height: 0,
                  borderLeftWidth: 4,
                  borderRightWidth: 4,
                  borderTopWidth: 6,
                  borderLeftColor: 'transparent',
                  borderRightColor: 'transparent',
                  borderTopColor: marker.color,
                }}
              />
            </View>
          </Marker>
        ))}
      </MapView>
    </View>
  );
}
