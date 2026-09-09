import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { analyticsApi } from '@/api/endpoints/analytics';
import { reportsApi } from '@/api/endpoints/reports';
import { sosApi } from '@/api/endpoints/sos';
import type { ThreatReport } from '@/api/types';
import { SeverityBadge } from '@/components/domain/Badges';
import { SosButton } from '@/components/domain/SosButton';
import { ActiveSosBar, OfflineBanner, StaleDataNotice } from '@/components/domain/StatusBanners';
import { ThreatCard } from '@/components/domain/ThreatCard';
import {
  Avatar,
  Badge,
  Banner,
  Card,
  ConfirmSheet,
  EmptyState,
  Header,
  Screen,
  Section,
  Skeleton,
  Stat,
  Text,
} from '@/components/ui';
import { regionNames } from '@/constants/regions';
import { SEVERITY_META } from '@/constants/threats';
import { useLocation } from '@/hooks/use-location';
import { useSosTrigger } from '@/hooks/use-sos';
import { useQuery } from '@/hooks/use-query';
import { formatDistance } from '@/lib/geo';
import { timeAgo } from '@/lib/format';

import { useAuth } from '@/state/auth';
import { useConnectivity } from '@/state/connectivity';
import { useTheme } from '@/theme';

/**
 * Worker home.
 *
 * Ordered by urgency, not by feature list: anything live (an SOS, a critical
 * alert near you) comes first, then the situation around you, then your own
 * activity. A worker glancing at this in a vehicle should get the answer to
 * "is anything wrong near me right now" in the first screenful.
 */
export default function WorkerHome() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const { online } = useConnectivity();
  const location = useLocation();
  const [confirmSos, setConfirmSos] = useState(false);
  const sos = useSosTrigger();

  const profile = user!.profile;

  const summary = useQuery({
    key: `worker.summary.${profile.id}`,
    fetcher: () => analyticsApi.workerSummary(),
    watch: ['reports', 'notifications'],
  });

  const activeSos = useQuery({
    key: `sos.mine.${profile.id}`,
    fetcher: () => sosApi.mine(),
    watch: ['sosEvents'],
    pollMs: 20_000,
  });

  const nearby = useQuery({
    key: location.point ? `reports.nearby.${location.point.lat.toFixed(2)},${location.point.lng.toFixed(2)}` : null,
    fetcher: () => reportsApi.nearby(location.point!, 60_000, 24 * 14),
    watch: ['reports'],
  });

  const myReports = useQuery({
    key: `reports.mine.${profile.id}`,
    fetcher: () => reportsApi.mine(4),
    watch: ['reports'],
  });

  const refreshAll = useCallback(async () => {
    await Promise.all([summary.refetch(), nearby.refetch(), myReports.refetch(), activeSos.refetch()]);
  }, [summary, nearby, myReports, activeSos]);

  const highest = useMemo(() => {
    const list = nearby.data ?? [];
    if (!list.length) return null;
    return list.reduce((worst, current) => {
      const worstRank = SEVERITY_META[worst.report.severity ?? 'low'].rank;
      const currentRank = SEVERITY_META[current.report.severity ?? 'low'].rank;
      return currentRank > worstRank ? current : worst;
    });
  }, [nearby.data]);

  const triggerSos = async () => {
    setConfirmSos(false);
    await sos.trigger(null);
    await activeSos.refetch();
  };

  const greeting = new Date().getHours() < 12 ? 'Good morning' : new Date().getHours() < 17 ? 'Good afternoon' : 'Good evening';

  return (
    <>
      <Screen refreshing={summary.isRefreshing} onRefresh={refreshAll} extraBottomPadding={40}>
        <Header
          title={`${greeting}, ${profile.fullName.split(' ')[0]}`}
          subtitle={regionNames(profile.operatingRegions)}
          right={
            <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Open settings">
              <Avatar name={profile.fullName} color={profile.avatarColor} size={40} />
            </Pressable>
          }
        />

        <View style={{ gap: spacing.xxl }}>
          <OfflineBanner />

          {/* Live SOS takes precedence over everything else on this screen */}
          {activeSos.data ? (
            <ActiveSosBar sosId={activeSos.data.id} startedAt={activeSos.data.createdAt} />
          ) : null}

          {/* Situation near you */}
          <Section title="Around you">
            {nearby.isLoading && !nearby.data ? (
              <Card>
                <View style={{ gap: spacing.md }}>
                  <Skeleton width="45%" height={16} />
                  <Skeleton width="80%" height={12} />
                </View>
              </Card>
            ) : highest ? (
              <Card
                accent={colors[SEVERITY_META[highest.report.severity ?? 'low'].colorKey]}
                onPress={() => router.push({ pathname: '/report/[id]', params: { id: highest.report.id } })}
                accessibilityLabel="Nearest verified threat"
              >
                <View style={{ gap: spacing.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                    <Text variant="label" tone="tertiary">
                      Nearest verified threat
                    </Text>
                    <Badge label={formatDistance(highest.distance)} icon="navigation" size="sm" />
                  </View>
                  <SeverityBadge severity={highest.report.severity ?? 'low'} showGuidance />
                  <Text variant="body" numberOfLines={2}>
                    {highest.report.aiSuggestions?.summary ?? highest.report.description}
                  </Text>
                  <Text variant="caption" tone="tertiary">
                    {highest.report.placeLabel ?? 'Unknown area'} · {timeAgo(highest.report.occurredAt)}
                  </Text>
                </View>
              </Card>
            ) : (
              <Card>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 12,
                      backgroundColor: colors.successMuted,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Feather name="check" size={18} color={colors.success} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="bodyStrong">No verified threats within 60 km</Text>
                    <Text variant="caption" tone="tertiary">
                      Based on the last 14 days. Stay alert - not every incident gets reported.
                    </Text>
                  </View>
                </View>
              </Card>
            )}
            <StaleDataNotice updatedAt={nearby.updatedAt} isOffline={nearby.isOffline} />
          </Section>

          {/* Personal counters */}
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Stat
              label="In your regions"
              value={summary.data?.activeThreatsNearby ?? '—'}
              sublabel="last 14 days"
              icon="alert-triangle"
              tone={summary.data?.highestNearbySeverity ? colors[SEVERITY_META[summary.data.highestNearbySeverity].colorKey] : undefined}
              onPress={() => router.push('/(worker)/map')}
            />
            <Stat
              label="Unread alerts"
              value={summary.data?.unreadAlerts ?? '—'}
              icon="bell"
              tone={summary.data?.unreadAlerts ? colors.warning : undefined}
              onPress={() => router.push('/(worker)/alerts')}
            />
            <Stat
              label="Your reports"
              value={summary.data?.myReports ?? '—'}
              sublabel={summary.data ? `${summary.data.myPending} pending` : undefined}
              icon="file-text"
            />
          </View>

          {/* Primary actions */}
          <Section title="Act">
            <View style={{ gap: spacing.sm }}>
              <ActionTile
                icon="plus-circle"
                title="Report a threat"
                description="Text, photo and GPS. Works offline - it sends itself when you reconnect."
                onPress={() => router.push('/(worker)/report')}
                tint={colors.accent}
              />
              <ActionTile
                icon="navigation"
                title="Check a route"
                description="Compare routes by verified incidents near the road before you travel."
                onPress={() => router.push('/(worker)/route')}
                tint={colors.roleWorker}
              />
              <ActionTile
                icon="map"
                title="Threat map"
                description="Verified threats in your organisation and partner areas."
                onPress={() => router.push('/(worker)/map')}
                tint={colors.roleOfficer}
              />
            </View>
          </Section>

          {/* Recent personal reports */}
          <Section
            title="Your recent reports"
            action={myReports.data?.length ? { label: 'See all', onPress: () => router.push('/(worker)/report') } : undefined}
          >
            {myReports.isLoading && !myReports.data ? (
              <Skeleton height={90} radius={14} />
            ) : myReports.data?.length ? (
              <View style={{ gap: spacing.md }}>
                {myReports.data.map((report: ThreatReport) => (
                  <ThreatCard
                    key={report.id}
                    report={report}
                    compact
                    onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })}
                  />
                ))}
              </View>
            ) : (
              <EmptyState
                compact
                icon="file-plus"
                title="You have not filed a report yet"
                message="If you see something that could affect other teams - a roadblock, gunfire, an ambush - report it. An officer verifies it before anyone is alerted."
                action={{ label: 'File a report', onPress: () => router.push('/(worker)/report'), icon: 'plus' }}
              />
            )}
          </Section>

          {/* Emergency */}
          <Card style={{ borderColor: colors.danger, backgroundColor: colors.dangerMuted }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
              <View style={{ flex: 1, gap: spacing.sm }}>
                <Text variant="title3" tone="danger">
                  Emergency
                </Text>
                <Text variant="footnote" tone="secondary">
                  Broadcasts your live location to your organisation&apos;s security officers until they mark it
                  resolved. Works offline - it queues and sends the moment you have signal.
                </Text>
              </View>
              <SosButton onActivate={() => setConfirmSos(true)} active={!!activeSos.data} size={64} />
            </View>
          </Card>

          {profile.operatingRegions.length === 0 ? (
            <Banner
              tone="warning"
              title="No operating regions set"
              message="You will miss alerts for areas you work in. Set them in your profile."
              action={{ label: 'Set regions', onPress: () => router.push('/settings/regions') }}
            />
          ) : null}
        </View>
      </Screen>

      <ConfirmSheet
        visible={confirmSos}
        onClose={() => setConfirmSos(false)}
        onConfirm={triggerSos}
        loading={sos.pending}
        title="Send an SOS?"
        confirmLabel="Yes, send SOS now"
        cancelLabel="Cancel"
        message={
          online
            ? 'Your security officers will be alerted immediately and will see your live location until they resolve it.'
            : 'You have no signal. The SOS will be saved on this device and sent automatically the moment you reconnect.'
        }
      >
        <View style={{ gap: spacing.sm }}>
          <Banner
            tone="neutral"
            compact
            icon="map-pin"
            message={
              location.point
                ? `Position: ${location.point.lat.toFixed(4)}, ${location.point.lng.toFixed(4)}${
                    location.accuracyMeters ? ` (±${Math.round(location.accuracyMeters)} m)` : ''
                  }`
                : 'No position yet - we will try to get one when you confirm.'
            }
          />
          <Text variant="caption" tone="tertiary">
            You can stand down your own SOS at any time if it was raised by mistake.
          </Text>
        </View>
      </ConfirmSheet>
    </>
  );
}

function ActionTile({
  icon,
  title,
  description,
  onPress,
  tint,
}: {
  icon: keyof typeof Feather.glyphMap;
  title: string;
  description: string;
  onPress: () => void;
  tint: string;
}) {
  const { colors, radius, spacing } = useTheme();

  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={title}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.lg,
        borderRadius: radius.lg,
        backgroundColor: colors.surface,
        borderWidth: 1,
        borderColor: colors.border,
        opacity: pressed ? 0.8 : 1,
      })}
    >
      <View
        style={{
          width: 40,
          height: 40,
          borderRadius: radius.md,
          backgroundColor: `${tint}1F`,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name={icon} size={18} color={tint} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="bodyStrong">{title}</Text>
        <Text variant="caption" tone="tertiary">
          {description}
        </Text>
      </View>
      <Feather name="chevron-right" size={18} color={colors.textTertiary} />
    </Pressable>
  );
}
