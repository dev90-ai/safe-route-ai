import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { reportsApi } from '@/api/endpoints/reports';
import { SeverityBadge } from '@/components/domain/Badges';
import { StaleDataNotice } from '@/components/domain/StatusBanners';
import { ThreatMap } from '@/components/domain/ThreatMap';
import type { MapThreat } from '@/components/domain/map-types';
import {
  Badge,
  Banner,
  Card,
  Chip,
  ChipRow,
  EmptyState,
  Header,
  IconButton,
  Screen,
  Sheet,
  Skeleton,
  Text,
  Toggle,
} from '@/components/ui';
import { REGIONS_BY_ID } from '@/constants/regions';
import {
  SEVERITIES,
  SEVERITY_META,
  THREAT_META,
  TIME_WINDOWS,
  type Severity,
  type ThreatType,
  type TimeWindowId,
} from '@/constants/threats';
import { useLocation } from '@/hooks/use-location';
import { useQuery } from '@/hooks/use-query';
import { distanceMeters, formatDistance, formatRadius } from '@/lib/geo';
import { timeAgo } from '@/lib/format';
import { useTheme } from '@/theme';

/**
 * Threat map.
 *
 * Only verified threats appear here. An unverified report on a map is
 * indistinguishable from a confirmed one at a glance, and that is exactly the
 * confusion the verification step exists to prevent.
 */
export default function ThreatMapScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const location = useLocation();

  const [windowId, setWindowId] = useState<TimeWindowId>('14d');
  const [severities, setSeverities] = useState<Severity[]>([]);
  const [types, setTypes] = useState<ThreatType[]>([]);
  const [showRadii, setShowRadii] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [filtersOpen, setFiltersOpen] = useState(false);

  const windowHours = TIME_WINDOWS.find((w) => w.id === windowId)!.hours;

  const threats = useQuery({
    key: `map.threats.${windowId}`,
    fetcher: () => reportsApi.mapThreats(windowHours),
    watch: ['reports'],
  });

  const filtered = useMemo(() => {
    let list = threats.data ?? [];
    if (severities.length) list = list.filter((r) => r.severity && severities.includes(r.severity));
    if (types.length) list = list.filter((r) => r.threatType && types.includes(r.threatType));
    return list;
  }, [threats.data, severities, types]);

  const mapThreats: MapThreat[] = useMemo(
    () =>
      filtered.map((report) => ({
        id: report.id,
        point: report.location,
        severity: report.severity ?? 'low',
        threatType: report.threatType ?? 'other',
        label: `${THREAT_META[report.threatType ?? 'other'].label} - ${SEVERITY_META[report.severity ?? 'low'].label}`,
        radiusMeters: report.alertRadiusMeters,
      })),
    [filtered],
  );

  const selected = useMemo(() => filtered.find((r) => r.id === selectedId) ?? null, [filtered, selectedId]);

  // Which types actually occur in the current window - filtering by a type with
  // zero results just teaches people the filter is broken.
  const availableTypes = useMemo(() => {
    const counts = new Map<ThreatType, number>();
    for (const report of threats.data ?? []) {
      if (!report.threatType) continue;
      counts.set(report.threatType, (counts.get(report.threatType) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  }, [threats.data]);

  const severityCounts = useMemo(() => {
    const counts: Record<Severity, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const report of threats.data ?? []) if (report.severity) counts[report.severity] += 1;
    return counts;
  }, [threats.data]);

  const activeFilters = severities.length + types.length;

  return (
    <>
      <Screen refreshing={threats.isRefreshing} onRefresh={() => void threats.refetch()} extraBottomPadding={40}>
        <Header
          title="Threat map"
          subtitle={`${filtered.length} verified threat${filtered.length === 1 ? '' : 's'} in the last ${TIME_WINDOWS.find((w) => w.id === windowId)!.label}`}
          right={
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <IconButton
                icon="sliders"
                label="Filters"
                onPress={() => setFiltersOpen(true)}
                tone={activeFilters ? colors.accent : undefined}
              />
              <IconButton icon="crosshair" label="Centre on me" onPress={() => void location.refresh()} />
            </View>
          }
        />

        <View style={{ gap: spacing.lg }}>
          <ChipRow>
            {TIME_WINDOWS.map((window) => (
              <Chip
                key={window.id}
                label={window.label}
                selected={windowId === window.id}
                onPress={() => setWindowId(window.id)}
              />
            ))}
          </ChipRow>

          {threats.isLoading && !threats.data ? (
            <Skeleton height={340} radius={14} />
          ) : (
            <ThreatMap
              height={340}
              threats={mapThreats}
              selectedId={selectedId}
              onSelectThreat={setSelectedId}
              showRadii={showRadii}
              center={location.point}
              markers={
                location.point
                  ? [{ id: 'me', point: location.point, label: 'You', color: colors.accent, kind: 'user' }]
                  : []
              }
            />
          )}

          <StaleDataNotice updatedAt={threats.updatedAt} isOffline={threats.isOffline} />

          {/* Legend - severity is encoded by both colour and pin size */}
          <Card level={0} style={{ backgroundColor: colors.surfaceSunken }}>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.md, alignItems: 'center' }}>
              {SEVERITIES.map((severity) => (
                <Pressable
                  key={severity}
                  onPress={() =>
                    setSeverities((current) =>
                      current.includes(severity) ? current.filter((s) => s !== severity) : [...current, severity],
                    )
                  }
                  accessibilityRole="button"
                  accessibilityState={{ selected: severities.includes(severity) }}
                  style={{ flexDirection: 'row', alignItems: 'center', gap: 6, opacity: severities.length && !severities.includes(severity) ? 0.35 : 1 }}
                >
                  <View
                    style={{
                      width: 6 + SEVERITY_META[severity].rank * 2,
                      height: 6 + SEVERITY_META[severity].rank * 2,
                      borderRadius: 10,
                      backgroundColor: colors[SEVERITY_META[severity].colorKey],
                    }}
                  />
                  <Text variant="caption" tone="secondary">
                    {SEVERITY_META[severity].label}
                  </Text>
                  <Text variant="caption" tone="tertiary" tabular>
                    {severityCounts[severity]}
                  </Text>
                </Pressable>
              ))}
            </View>
          </Card>

          {activeFilters ? (
            <Pressable
              onPress={() => {
                setSeverities([]);
                setTypes([]);
              }}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6, alignSelf: 'flex-start' }}
            >
              <Feather name="x-circle" size={13} color={colors.accentText} />
              <Text variant="footnote" tone="accent" weight="600">
                Clear {activeFilters} filter{activeFilters === 1 ? '' : 's'}
              </Text>
            </Pressable>
          ) : null}

          {/* List mirrors the map so the data is reachable without pinching */}
          {filtered.length === 0 ? (
            <EmptyState
              icon="shield"
              tone={threats.data?.length ? 'neutral' : 'positive'}
              title={threats.data?.length ? 'Nothing matches those filters' : 'No verified threats in this window'}
              message={
                threats.data?.length
                  ? 'Widen the time window or clear a filter to see more.'
                  : 'Your organisation has no verified threats in this period. That is not the same as no risk - stay alert and report anything you see.'
              }
              action={
                activeFilters
                  ? {
                      label: 'Clear filters',
                      onPress: () => {
                        setSeverities([]);
                        setTypes([]);
                      },
                    }
                  : undefined
              }
            />
          ) : (
            <View style={{ gap: spacing.md }}>
              <Text variant="label" tone="tertiary">
                {filtered.length} threat{filtered.length === 1 ? '' : 's'}
              </Text>
              {filtered.slice(0, 25).map((report) => {
                const distance = location.point ? distanceMeters(location.point, report.location) : null;
                return (
                  <Pressable
                    key={report.id}
                    onPress={() => setSelectedId(report.id)}
                    accessibilityRole="button"
                    accessibilityLabel={`${THREAT_META[report.threatType ?? 'other'].label}, ${report.severity}`}
                  >
                    <Card
                      accent={colors[SEVERITY_META[report.severity ?? 'low'].colorKey]}
                      style={{ paddingVertical: spacing.md, opacity: selectedId && selectedId !== report.id ? 0.6 : 1 }}
                    >
                      <View style={{ gap: 6 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
                          <SeverityBadge severity={report.severity ?? 'low'} size="sm" />
                          <Badge label={THREAT_META[report.threatType ?? 'other'].label} size="sm" />
                          {distance !== null ? <Badge label={formatDistance(distance)} icon="navigation" size="sm" /> : null}
                        </View>
                        <Text variant="footnote" numberOfLines={2}>
                          {report.aiSuggestions?.summary ?? report.description}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                          {report.placeLabel ?? 'Unknown area'} · {timeAgo(report.occurredAt)}
                        </Text>
                      </View>
                    </Card>
                  </Pressable>
                );
              })}
            </View>
          )}
        </View>
      </Screen>

      {/* Filters */}
      <Sheet visible={filtersOpen} onClose={() => setFiltersOpen(false)} title="Filters" subtitle="Narrow what appears on the map">
        <View style={{ gap: spacing.xl }}>
          <View style={{ gap: spacing.sm }}>
            <Text variant="label" tone="tertiary">
              Severity
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {SEVERITIES.map((severity) => (
                <Chip
                  key={severity}
                  label={SEVERITY_META[severity].label}
                  count={severityCounts[severity]}
                  color={colors[SEVERITY_META[severity].colorKey]}
                  selected={severities.includes(severity)}
                  onPress={() =>
                    setSeverities((current) =>
                      current.includes(severity) ? current.filter((s) => s !== severity) : [...current, severity],
                    )
                  }
                />
              ))}
            </View>
          </View>

          <View style={{ gap: spacing.sm }}>
            <Text variant="label" tone="tertiary">
              Threat type
            </Text>
            {availableTypes.length ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {availableTypes.map(([type, count]) => (
                  <Chip
                    key={type}
                    label={THREAT_META[type].short}
                    count={count}
                    selected={types.includes(type)}
                    onPress={() =>
                      setTypes((current) => (current.includes(type) ? current.filter((t) => t !== type) : [...current, type]))
                    }
                  />
                ))}
              </View>
            ) : (
              <Text variant="footnote" tone="tertiary">
                No threat types recorded in this window.
              </Text>
            )}
          </View>

          <Toggle
            icon="radio"
            label="Show alert radii"
            description="Draws the area each verified threat alerts on."
            value={showRadii}
            onChange={setShowRadii}
          />
        </View>
      </Sheet>

      {/* Selected threat detail */}
      <Sheet
        visible={!!selected}
        onClose={() => setSelectedId(null)}
        title={selected ? THREAT_META[selected.threatType ?? 'other'].label : ''}
        subtitle={selected ? `${selected.placeLabel ?? 'Unknown area'} · ${timeAgo(selected.occurredAt)}` : undefined}
      >
        {selected ? (
          <View style={{ gap: spacing.lg }}>
            <SeverityBadge severity={selected.severity ?? 'low'} showGuidance />

            <Text variant="body">{selected.description}</Text>

            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm }}>
              {selected.alertRadiusMeters ? (
                <Badge label={`${formatRadius(selected.alertRadiusMeters)} alert radius`} icon="radio" size="sm" />
              ) : null}
              {selected.regionId ? <Badge label={REGIONS_BY_ID[selected.regionId]?.name ?? ''} icon="map" size="sm" /> : null}
              {location.point ? (
                <Badge
                  label={`${formatDistance(distanceMeters(location.point, selected.location))} from you`}
                  icon="navigation"
                  size="sm"
                />
              ) : null}
            </View>

            <Banner
              tone="neutral"
              icon="eye-off"
              compact
              message="Reporter identity is hidden and the pin is offset slightly to protect whoever filed this."
            />

            <Pressable
              onPress={() => {
                const id = selected.id;
                setSelectedId(null);
                router.push({ pathname: '/report/[id]', params: { id } });
              }}
              accessibilityRole="button"
              style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}
            >
              <Text variant="footnote" tone="accent" weight="600">
                Open full report
              </Text>
              <Feather name="arrow-right" size={14} color={colors.accentText} />
            </Pressable>
          </View>
        ) : null}
      </Sheet>
    </>
  );
}
