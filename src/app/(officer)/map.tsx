import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { reportsApi } from '@/api/endpoints/reports';
import { StaleDataNotice } from '@/components/domain/StatusBanners';
import { ThreatCard } from '@/components/domain/ThreatCard';
import { ThreatMap } from '@/components/domain/ThreatMap';
import type { MapThreat } from '@/components/domain/map-types';
import {
  Banner,
  Card,
  Chip,
  ChipRow,
  EmptyState,
  Header,
  Screen,
  Segmented,
  Skeleton,
  Text,
  Toggle,
} from '@/components/ui';
import { TIME_WINDOWS, type TimeWindowId } from '@/constants/threats';
import { useQuery } from '@/hooks/use-query';
import { useTheme } from '@/theme';

/**
 * Officer map.
 *
 * Unlike the worker map, this can show pending reports too - an officer needs
 * to see where unverified submissions are clustering, because three pending
 * reports on one stretch of road is itself a signal. Pending pins are drawn
 * hollow and are explicitly labelled so they are never mistaken for verified
 * threats.
 */
export default function OfficerMap() {
  const { colors, spacing } = useTheme();
  const router = useRouter();

  const [windowId, setWindowId] = useState<TimeWindowId>('14d');
  const [scope, setScope] = useState<'verified' | 'all'>('verified');
  const [showRadii, setShowRadii] = useState(true);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const windowHours = TIME_WINDOWS.find((w) => w.id === windowId)!.hours;

  const reports = useQuery({
    key: `officer.map.${windowId}.${scope}`,
    fetcher: () =>
      reportsApi.list({
        windowHours,
        status: scope === 'verified' ? 'verified' : undefined,
        limit: 200,
      }),
    watch: ['reports'],
  });

  const items = useMemo(() => {
    const list = reports.data?.items ?? [];
    return scope === 'verified' ? list.filter((r) => r.status === 'verified') : list.filter((r) => r.status !== 'dismissed');
  }, [reports.data, scope]);

  const mapThreats: MapThreat[] = useMemo(
    () =>
      items.map((report) => ({
        id: report.id,
        point: report.location,
        severity: report.severity ?? report.aiSuggestions?.severity ?? 'low',
        threatType: report.threatType ?? report.aiSuggestions?.threatType ?? 'other',
        label: `${report.reference} - ${report.status}`,
        radiusMeters: report.status === 'verified' ? report.alertRadiusMeters : null,
      })),
    [items],
  );

  const pendingCount = items.filter((r) => r.status === 'pending').length;
  const selected = items.find((r) => r.id === selectedId) ?? null;

  return (
    <Screen refreshing={reports.isRefreshing} onRefresh={() => void reports.refetch()} extraBottomPadding={40}>
      <Header
        title="Operational map"
        subtitle={`${items.length} report${items.length === 1 ? '' : 's'} in the last ${TIME_WINDOWS.find((w) => w.id === windowId)!.label}`}
      />

      <View style={{ gap: spacing.lg }}>
        <Segmented
          options={[
            { value: 'verified', label: 'Verified only' },
            { value: 'all', label: 'Include pending', badge: pendingCount },
          ]}
          value={scope}
          onChange={setScope}
        />

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

        {reports.isLoading && !reports.data ? (
          <Skeleton height={340} radius={14} />
        ) : (
          <ThreatMap
            height={340}
            threats={mapThreats}
            selectedId={selectedId}
            onSelectThreat={setSelectedId}
            showRadii={showRadii}
          />
        )}

        <StaleDataNotice updatedAt={reports.updatedAt} isOffline={reports.isOffline} />

        <Card level={0} style={{ backgroundColor: colors.surfaceSunken }}>
          <Toggle
            icon="radio"
            label="Show alert radii"
            description="Draws the area each verified threat alerted on."
            value={showRadii}
            onChange={setShowRadii}
          />
        </Card>

        {scope === 'all' && pendingCount ? (
          <Banner
            tone="warning"
            icon="clock"
            title={`${pendingCount} pending report${pendingCount === 1 ? '' : 's'} on this map`}
            message="Pending reports have not been verified. Nobody in the field has been alerted about them yet."
          />
        ) : null}

        {selected ? (
          <View style={{ gap: spacing.sm }}>
            <Text variant="label" tone="tertiary">
              Selected
            </Text>
            <ThreatCard
              report={selected}
              onPress={() => router.push({ pathname: '/report/[id]', params: { id: selected.id } })}
            />
          </View>
        ) : null}

        {items.length === 0 ? (
          <EmptyState
            icon="map"
            title="No reports in this window"
            message="Widen the time window, or include pending reports, to see more."
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            <Text variant="label" tone="tertiary">
              All {items.length}
            </Text>
            {items.slice(0, 30).map((report) => (
              <ThreatCard
                key={report.id}
                report={report}
                compact
                onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })}
              />
            ))}
          </View>
        )}
      </View>
    </Screen>
  );
}
