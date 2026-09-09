import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { routesApi, type RouteAnalysis } from '@/api/endpoints/routes';
import type { RouteCandidate } from '@/api/types';
import { SeverityBadge } from '@/components/domain/Badges';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import { ThreatMap } from '@/components/domain/ThreatMap';
import type { MapRoute, MapThreat } from '@/components/domain/map-types';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  ChipRow,
  EmptyState,
  Header,
  Screen,
  Section,
  Sheet,
  Skeleton,
  Text,
} from '@/components/ui';
import { PLACES, type Place } from '@/constants/regions';
import { SEVERITY_META, THREAT_META, TIME_WINDOWS } from '@/constants/threats';
import { useLocation } from '@/hooks/use-location';
import { distanceMeters, formatDistance, type LatLng } from '@/lib/geo';
import { timeAgo } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Safe Route advisory.
 *
 * The output ranks routes and explains why. It never says "take this one" -
 * the app cannot see the checkpoint that opened this morning, the vehicle's
 * condition, or the escort arrangement, and pretending otherwise would invite
 * exactly the kind of misplaced confidence that gets people hurt.
 */

const BAND_META = {
  low: { label: 'Low risk', colorKey: 'success' },
  moderate: { label: 'Moderate risk', colorKey: 'warning' },
  elevated: { label: 'Elevated risk', colorKey: 'sevHigh' },
  high: { label: 'High risk', colorKey: 'danger' },
  severe: { label: 'Severe risk', colorKey: 'danger' },
} as const;

export default function SafeRouteScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const location = useLocation();
  const { user } = useAuth();

  const [origin, setOrigin] = useState<{ label: string; point: LatLng } | null>(null);
  const [destination, setDestination] = useState<{ label: string; point: LatLng } | null>(null);
  const [picker, setPicker] = useState<'origin' | 'destination' | null>(null);
  const [buffer, setBuffer] = useState(2000);
  const [windowHours, setWindowHours] = useState(24 * 30);
  const [analysis, setAnalysis] = useState<RouteAnalysis | null>(null);
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);
  const [detailRoute, setDetailRoute] = useState<RouteCandidate | null>(null);
  const [loading, setLoading] = useState(false);

  const canAnalyze = !!origin && !!destination;

  const analyze = async () => {
    if (!origin || !destination) return;
    setLoading(true);
    setAnalysis(null);
    try {
      const result = await routesApi.analyzeCached(
        {
          origin: origin.point,
          destination: destination.point,
          originLabel: origin.label,
          destinationLabel: destination.label,
          bufferMeters: buffer,
          windowHours,
        },
        user!.profile.id,
      );
      setAnalysis(result);
      setSelectedRouteId(result.recommendedId);

      const worst = result.candidates.find((c) => c.highestSeverity === 'critical');
      if (worst) {
        toast.error('Critical incident on a candidate route', `${worst.label} passes near a critical verified threat.`);
      }
    } catch (e) {
      const error = e as { userMessage?: string };
      toast.error('Could not analyse routes', error.userMessage ?? 'Try again.');
    } finally {
      setLoading(false);
    }
  };

  const useMyLocation = async () => {
    const point = location.point ?? (await location.refresh());
    if (!point) {
      toast.warning('No position yet', 'Enable location or choose a starting place from the list.');
      return;
    }
    setOrigin({ label: 'My location', point });
  };

  const mapRoutes: MapRoute[] = useMemo(() => {
    if (!analysis) return [];
    return analysis.candidates.map((candidate) => ({
      id: candidate.id,
      path: candidate.path,
      color:
        candidate.id === selectedRouteId
          ? colors[BAND_META[candidate.riskBand].colorKey]
          : colors.textTertiary,
      active: candidate.id === selectedRouteId,
      dashed: candidate.corridorId === null,
    }));
  }, [analysis, selectedRouteId, colors]);

  const mapThreats: MapThreat[] = useMemo(() => {
    if (!analysis) return [];
    const selected = analysis.candidates.find((c) => c.id === selectedRouteId) ?? analysis.candidates[0];
    if (!selected) return [];
    // Only threats relevant to the selected route - showing all of them would
    // bury the ones actually on this road.
    return selected.threats.map((threat) => ({
      id: threat.reportId,
      point: threat.location,
      severity: threat.severity,
      threatType: threat.threatType,
      label: threat.reference,
    }));
  }, [analysis, selectedRouteId]);

  return (
    <>
      <Screen extraBottomPadding={40}>
        <Header
          title="Safe route"
          subtitle="Compare routes by verified incidents near the road. Advisory only - your judgement decides."
        />

        <View style={{ gap: spacing.xl }}>
          <OfflineBanner />

          {/* Endpoints */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <EndpointRow
                icon="circle"
                label="From"
                value={origin?.label ?? null}
                placeholder="Choose a starting point"
                onPress={() => setPicker('origin')}
                accent={colors.accent}
              />
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <View style={{ width: 32, alignItems: 'center' }}>
                  <View style={{ width: 1, height: 16, backgroundColor: colors.border }} />
                </View>
                <Pressable
                  onPress={() => {
                    const from = origin;
                    setOrigin(destination);
                    setDestination(from);
                    setAnalysis(null);
                  }}
                  hitSlop={8}
                  accessibilityRole="button"
                  accessibilityLabel="Swap origin and destination"
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}
                >
                  <Feather name="repeat" size={12} color={colors.textTertiary} />
                  <Text variant="caption" tone="tertiary">
                    Swap
                  </Text>
                </Pressable>
              </View>
              <EndpointRow
                icon="map-pin"
                label="To"
                value={destination?.label ?? null}
                placeholder="Choose a destination"
                onPress={() => setPicker('destination')}
                accent={colors.danger}
              />

              {!origin ? (
                <Button label="Use my current location" icon="crosshair" variant="ghost" size="sm" onPress={useMyLocation} />
              ) : null}
            </View>
          </Card>

          {/* Analysis parameters */}
          <View style={{ gap: spacing.md }}>
            <Text variant="label" tone="tertiary">
              Analysis buffer
            </Text>
            <ChipRow>
              {[1000, 2000, 5000].map((value) => (
                <Chip
                  key={value}
                  label={`${value / 1000} km from road`}
                  selected={buffer === value}
                  onPress={() => {
                    setBuffer(value);
                    setAnalysis(null);
                  }}
                />
              ))}
            </ChipRow>

            <Text variant="label" tone="tertiary">
              Incident window
            </Text>
            <ChipRow>
              {TIME_WINDOWS.filter((w) => w.hours >= 24 * 7).map((window) => (
                <Chip
                  key={window.id}
                  label={window.label}
                  selected={windowHours === window.hours}
                  onPress={() => {
                    setWindowHours(window.hours);
                    setAnalysis(null);
                  }}
                />
              ))}
            </ChipRow>
          </View>

          <Button
            label={loading ? 'Analysing routes…' : 'Analyse routes'}
            size="lg"
            fullWidth
            icon="navigation"
            disabled={!canAnalyze}
            loading={loading}
            onPress={analyze}
          />

          {loading ? (
            <View style={{ gap: spacing.md }}>
              <Skeleton height={280} radius={14} />
              <Skeleton height={120} radius={14} />
            </View>
          ) : null}

          {analysis ? (
            <>
              <ThreatMap
                height={300}
                routes={mapRoutes}
                threats={mapThreats}
                markers={[
                  ...(origin ? [{ id: 'origin', point: origin.point, label: 'From', color: colors.accent, kind: 'origin' as const }] : []),
                  ...(destination
                    ? [{ id: 'destination', point: destination.point, label: 'To', color: colors.danger, kind: 'destination' as const }]
                    : []),
                ]}
              />

              <Section
                title="Candidate routes"
                subtitle={`Verified incidents within ${buffer / 1000} km of each line, over the last ${Math.round(windowHours / 24)} days.`}
              >
                <View style={{ gap: spacing.md }}>
                  {analysis.candidates
                    .slice()
                    .sort((a, b) => a.riskScore - b.riskScore)
                    .map((candidate) => (
                      <RouteCard
                        key={candidate.id}
                        candidate={candidate}
                        recommended={candidate.id === analysis.recommendedId}
                        selected={candidate.id === selectedRouteId}
                        onSelect={() => setSelectedRouteId(candidate.id)}
                        onDetails={() => setDetailRoute(candidate)}
                      />
                    ))}
                </View>
              </Section>

              <Banner
                tone="neutral"
                icon="info"
                title="What this does not know"
                message="Only verified reports count. Unreported incidents, checkpoints set up today, road and vehicle conditions, and your escort arrangements are all invisible to this analysis. Treat it as one input, not a decision."
              />
            </>
          ) : !loading && canAnalyze ? (
            <EmptyState
              compact
              icon="navigation"
              title="Ready to analyse"
              message="We will build candidate routes and count verified threats near each one."
            />
          ) : !canAnalyze ? (
            <EmptyState
              compact
              icon="map"
              title="Choose where you are going"
              message="Pick a starting point and a destination to compare routes by recorded risk."
            />
          ) : null}
        </View>
      </Screen>

      {/* Place picker */}
      <PlacePicker
        visible={picker !== null}
        title={picker === 'origin' ? 'Starting point' : 'Destination'}
        onClose={() => setPicker(null)}
        onSelect={(place) => {
          const value = { label: place.name, point: place.point };
          if (picker === 'origin') setOrigin(value);
          else setDestination(value);
          setPicker(null);
          setAnalysis(null);
        }}
        near={location.point}
      />

      {/* Per-route incident breakdown */}
      <Sheet
        visible={!!detailRoute}
        onClose={() => setDetailRoute(null)}
        title={detailRoute?.label}
        subtitle={detailRoute ? `${formatDistance(detailRoute.distanceMeters)} · about ${detailRoute.durationMinutes} min` : undefined}
      >
        {detailRoute ? (
          <View style={{ gap: spacing.lg }}>
            <Text variant="footnote" tone="secondary">
              {detailRoute.advisory}
            </Text>

            {detailRoute.threats.length ? (
              <View style={{ gap: spacing.md }}>
                <Text variant="label" tone="tertiary">
                  Incidents near this route
                </Text>
                {detailRoute.threats.map((threat) => (
                  <Pressable
                    key={threat.reportId}
                    onPress={() => {
                      setDetailRoute(null);
                      router.push({ pathname: '/report/[id]', params: { id: threat.reportId } });
                    }}
                    accessibilityRole="button"
                  >
                    <Card accent={colors[SEVERITY_META[threat.severity].colorKey]} style={{ paddingVertical: spacing.md }}>
                      <View style={{ gap: 6 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
                          <SeverityBadge severity={threat.severity} size="sm" />
                          <Badge label={THREAT_META[threat.threatType].short} size="sm" />
                          <Badge label={`${formatDistance(threat.distanceFromRouteMeters)} off road`} size="sm" icon="git-commit" />
                        </View>
                        <Text variant="footnote" numberOfLines={2}>
                          {threat.summary}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                          {threat.reference} · {timeAgo(threat.occurredAt)}
                        </Text>
                      </View>
                    </Card>
                  </Pressable>
                ))}
              </View>
            ) : (
              <Banner
                tone="success"
                icon="check-circle"
                message="No verified incidents within the analysis buffer of this route in the selected window."
              />
            )}
          </View>
        ) : null}
      </Sheet>
    </>
  );
}

function RouteCard({
  candidate,
  recommended,
  selected,
  onSelect,
  onDetails,
}: {
  candidate: RouteCandidate;
  recommended: boolean;
  selected: boolean;
  onSelect: () => void;
  onDetails: () => void;
}) {
  const { colors, spacing } = useTheme();
  const band = BAND_META[candidate.riskBand];
  const tint = colors[band.colorKey];

  return (
    <Pressable onPress={onSelect} accessibilityRole="button" accessibilityState={{ selected }}>
      <Card
        accent={tint}
        style={{
          borderColor: selected ? tint : colors.border,
          borderWidth: selected ? 1.5 : 1,
        }}
      >
        <View style={{ gap: spacing.md }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
            <Text variant="bodyStrong" style={{ flex: 1 }}>
              {candidate.label}
            </Text>
            {recommended ? (
              <Badge label="Lowest recorded risk" icon="award" size="sm" color={colors.success} background={colors.successMuted} />
            ) : null}
          </View>

          <Text variant="caption" tone="tertiary">
            {candidate.summary}
          </Text>

          <View style={{ flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' }}>
            <Metric label="Risk" value={band.label} tone={tint} />
            <Metric label="Incidents" value={String(candidate.incidentCount)} />
            <Metric label="Distance" value={formatDistance(candidate.distanceMeters)} />
            <Metric label="Time" value={`~${candidate.durationMinutes} min`} />
          </View>

          {candidate.highestSeverity ? (
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Text variant="caption" tone="tertiary">
                Worst nearby:
              </Text>
              <SeverityBadge severity={candidate.highestSeverity} size="sm" />
            </View>
          ) : null}

          <Text variant="footnote" tone="secondary">
            {candidate.advisory}
          </Text>

          <Pressable onPress={onDetails} hitSlop={8} accessibilityRole="button" style={{ flexDirection: 'row', alignItems: 'center', gap: 5 }}>
            <Text variant="footnote" tone="accent" weight="600">
              {candidate.incidentCount ? `See ${candidate.incidentCount} incident${candidate.incidentCount === 1 ? '' : 's'}` : 'Route details'}
            </Text>
            <Feather name="chevron-right" size={14} color={colors.accentText} />
          </Pressable>
        </View>
      </Card>
    </Pressable>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="micro" tone="tertiary">
        {label}
      </Text>
      <Text variant="footnote" weight="700" color={tone}>
        {value}
      </Text>
    </View>
  );
}

function EndpointRow({
  icon,
  label,
  value,
  placeholder,
  onPress,
  accent,
}: {
  icon: keyof typeof Feather.glyphMap;
  label: string;
  value: string | null;
  placeholder: string;
  onPress: () => void;
  accent: string;
}) {
  const { colors, spacing } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={`${label}: ${value ?? placeholder}`}
      style={({ pressed }) => ({ flexDirection: 'row', alignItems: 'center', gap: spacing.md, opacity: pressed ? 0.7 : 1 })}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: `${accent}22`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name={icon} size={14} color={accent} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="micro" tone="tertiary">
          {label}
        </Text>
        <Text variant="body" weight="500" tone={value ? 'default' : 'tertiary'} numberOfLines={1}>
          {value ?? placeholder}
        </Text>
      </View>
      <Feather name="chevron-right" size={16} color={colors.textTertiary} />
    </Pressable>
  );
}

function PlacePicker({
  visible,
  title,
  onClose,
  onSelect,
  near,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  onSelect: (place: Place) => void;
  near: LatLng | null;
}) {
  const { colors, spacing, radius } = useTheme();

  // Nearest first when we know where the user is - that is almost always what
  // they want, and it saves scrolling in a moving vehicle.
  const places = useMemo(() => {
    if (!near) return PLACES;
    return [...PLACES].sort((a, b) => distanceMeters(near, a.point) - distanceMeters(near, b.point));
  }, [near]);

  const kindIcon: Record<Place['kind'], keyof typeof Feather.glyphMap> = {
    town: 'home',
    camp: 'users',
    'field-site': 'briefcase',
    junction: 'git-merge',
  };

  return (
    <Sheet visible={visible} onClose={onClose} title={title} subtitle="Field sites, camps, towns and junctions">
      <View style={{ gap: 6 }}>
        {places.map((place) => (
          <Pressable
            key={place.id}
            onPress={() => onSelect(place)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              flexDirection: 'row',
              alignItems: 'center',
              gap: spacing.md,
              padding: spacing.md,
              borderRadius: radius.md,
              backgroundColor: colors.surfaceSunken,
              opacity: pressed ? 0.75 : 1,
            })}
          >
            <Feather name={kindIcon[place.kind]} size={15} color={colors.textTertiary} />
            <View style={{ flex: 1 }}>
              <Text variant="body">{place.name}</Text>
            </View>
            {near ? (
              <Text variant="caption" tone="tertiary">
                {formatDistance(distanceMeters(near, place.point))}
              </Text>
            ) : null}
          </Pressable>
        ))}
      </View>
    </Sheet>
  );
}
