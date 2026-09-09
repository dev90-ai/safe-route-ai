import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { analyticsApi } from '@/api/endpoints/analytics';
import { HeroStat, RankedBars, SegmentBar, TrendChart } from '@/components/domain/Charts';
import { OfflineBanner, StaleDataNotice } from '@/components/domain/StatusBanners';
import {
  Avatar,
  Banner,
  Card,
  Chip,
  ChipRow,
  EmptyState,
  Header,
  Meter,
  Screen,
  Section,
  SkeletonCard,
  Stat,
  Text,
} from '@/components/ui';
import { REGIONS_BY_ID } from '@/constants/regions';
import { SEVERITIES, SEVERITY_META, THREAT_META } from '@/constants/threats';
import { useQuery } from '@/hooks/use-query';
import { formatDuration, percent } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';

/**
 * Organisation overview.
 *
 * The metrics chosen here answer "is this system working", not "how busy are
 * we". Report volume alone is vanity - it goes up when reporting culture
 * improves and when the security situation deteriorates, and those are opposite
 * things. Verification latency, AI agreement and SOS acknowledgement time are
 * the numbers that actually say whether the loop is closing.
 */
const WINDOWS = [
  { label: '7 days', hours: 24 * 7 },
  { label: '30 days', hours: 24 * 30 },
  { label: '90 days', hours: 24 * 90 },
];

export default function AdminOverview() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const [windowHours, setWindowHours] = useState(24 * 30);

  const analytics = useQuery({
    key: `analytics.${windowHours}`,
    fetcher: () => analyticsApi.overview(windowHours),
    watch: ['reports', 'alerts', 'sosEvents'],
  });

  const data = analytics.data;

  const severitySegments = useMemo(
    () =>
      SEVERITIES.map((severity) => ({
        label: SEVERITY_META[severity].label,
        count: data?.bySeverity.find((s) => s.severity === severity)?.count ?? 0,
        color: colors[SEVERITY_META[severity].colorKey],
      })),
    [data, colors],
  );

  const typeBars = useMemo(
    () =>
      (data?.byType ?? []).slice(0, 6).map((row) => ({
        label: THREAT_META[row.type].label,
        count: row.count,
        color: colors.accent,
      })),
    [data, colors],
  );

  const regionBars = useMemo(
    () =>
      (data?.byRegion ?? []).slice(0, 6).map((row) => ({
        label: REGIONS_BY_ID[row.regionId]?.name ?? row.regionId,
        count: row.count,
        color: row.highestSeverity ? colors[SEVERITY_META[row.highestSeverity].colorKey] : colors.accent,
      })),
    [data, colors],
  );

  const verificationRate = data && data.totals.reports > 0 ? data.totals.verified / data.totals.reports : 0;
  const slowVerification = (data?.p90VerificationMs ?? 0) > 4 * 3_600_000;

  return (
    <Screen refreshing={analytics.isRefreshing} onRefresh={() => void analytics.refetch()} extraBottomPadding={40}>
      <Header
        title={user!.organization.acronym}
        subtitle={user!.organization.name}
        right={
          <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Settings">
            <Avatar name={user!.profile.fullName} color={user!.profile.avatarColor} size={40} />
          </Pressable>
        }
      />

      <View style={{ gap: spacing.xxl }}>
        <OfflineBanner />

        <ChipRow>
          {WINDOWS.map((window) => (
            <Chip
              key={window.label}
              label={window.label}
              selected={windowHours === window.hours}
              onPress={() => setWindowHours(window.hours)}
            />
          ))}
        </ChipRow>

        <StaleDataNotice updatedAt={analytics.updatedAt} isOffline={analytics.isOffline} />

        {analytics.isLoading && !data ? (
          <View style={{ gap: spacing.md }}>
            <SkeletonCard lines={4} />
            <SkeletonCard lines={3} />
          </View>
        ) : !data ? (
          <EmptyState icon="bar-chart-2" title="No data yet" message="Analytics appear once reports start coming in." />
        ) : (
          <>
            {/* The loop, in four numbers */}
            <View style={{ flexDirection: 'row', gap: spacing.sm, flexWrap: 'wrap' }}>
              <Stat label="Reports" value={data.totals.reports} icon="file-text" />
              <Stat label="Verified" value={data.totals.verified} icon="check-circle" tone={colors.success} />
              <Stat
                label="Pending"
                value={data.totals.pending}
                icon="clock"
                tone={data.totals.pending > 5 ? colors.warning : undefined}
              />
              <Stat label="Dismissed" value={data.totals.dismissed} icon="x-circle" />
            </View>

            {/* Volume trend - single series, no legend needed */}
            <Section title="Report volume" subtitle="Reports filed per day.">
              <Card>
                <View style={{ gap: spacing.lg }}>
                  <TrendChart data={data.reportsByDay} color={colors.accent} height={140} />
                  <Text variant="caption" tone="tertiary">
                    Volume alone is not a safety signal - it rises both when reporting culture improves and when the
                    situation deteriorates. Read it alongside severity and verification time.
                  </Text>
                </View>
              </Card>
            </Section>

            {/* Verification performance - the number that matters most */}
            <Section title="Verification performance" subtitle="How fast a report becomes an alert.">
              <Card>
                <View style={{ gap: spacing.xl }}>
                  <View style={{ flexDirection: 'row', gap: spacing.xxl, flexWrap: 'wrap' }}>
                    <HeroStat
                      label="Median time to verify"
                      value={formatDuration(data.medianVerificationMs)}
                      detail="report filed to officer decision"
                    />
                    <HeroStat
                      label="Slowest 10%"
                      value={formatDuration(data.p90VerificationMs)}
                      tone={slowVerification ? colors.danger : undefined}
                    />
                  </View>

                  {slowVerification ? (
                    <Banner
                      tone="warning"
                      icon="clock"
                      title="The slow tail is long"
                      message="One in ten reports waits over four hours for a decision. During that wait nobody in the field is alerted. Consider extending officer cover or adding a second verifier."
                    />
                  ) : null}

                  <View style={{ gap: 6 }}>
                    <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                      <Text variant="caption" tone="tertiary">
                        Verified share of all reports
                      </Text>
                      <Text variant="caption" weight="700" tabular>
                        {percent(verificationRate)}
                      </Text>
                    </View>
                    <Meter value={verificationRate} color={colors.success} />
                  </View>
                </View>
              </Card>
            </Section>

            {/* AI oversight */}
            <Section title="AI oversight" subtitle="Whether the human step is doing real work.">
              <Card>
                <View style={{ gap: spacing.lg }}>
                  <View style={{ flexDirection: 'row', gap: spacing.xxl, flexWrap: 'wrap' }}>
                    <HeroStat
                      label="AI accepted unchanged"
                      value={percent(data.aiAgreementRate)}
                      tone={data.aiAgreementRate > 0.92 ? colors.warning : colors.success}
                    />
                    <HeroStat
                      label="Duplicates caught"
                      value={String(data.totals.duplicatesCaught)}
                      detail="merged before an alert went out"
                    />
                  </View>
                  <Text variant="footnote" tone="secondary">
                    {data.aiAgreementRate > 0.92
                      ? 'Officers are accepting nearly every suggestion. Worth confirming the review step is a genuine decision rather than a habit - it only adds safety if it can produce a different answer.'
                      : data.aiAgreementRate < 0.5
                        ? 'Officers override the model more often than not. The classifier needs retuning for this operating context.'
                        : 'A healthy mix of acceptance and override. The human step is changing outcomes.'}
                  </Text>
                </View>
              </Card>
            </Section>

            {/* Severity mix */}
            <Section title="Severity mix" subtitle="Verified reports only.">
              <Card>
                <SegmentBar segments={severitySegments} />
              </Card>
            </Section>

            {/* Threat types */}
            <Section title="Threat types" subtitle="Most frequent verified categories.">
              <Card>
                <RankedBars data={typeBars} emptyMessage="No verified reports in this window." />
              </Card>
            </Section>

            {/* Regions - colour carries worst severity, value is direct-labelled */}
            <Section title="Where" subtitle="Bar colour shows the most severe verified threat in that region.">
              <Card>
                <RankedBars data={regionBars} emptyMessage="No verified reports with a region in this window." />
              </Card>
            </Section>

            {/* Emergency response */}
            <Section title="Emergency response">
              <Card>
                <View style={{ gap: spacing.lg }}>
                  <View style={{ flexDirection: 'row', gap: spacing.xxl, flexWrap: 'wrap' }}>
                    <HeroStat label="SOS events" value={String(data.totals.sosEvents)} />
                    <HeroStat
                      label="Median acknowledgement"
                      value={data.medianSosAckMs ? formatDuration(data.medianSosAckMs) : '—'}
                      tone={data.medianSosAckMs > 5 * 60_000 ? colors.danger : colors.success}
                      detail="SOS raised to officer response"
                    />
                  </View>
                  {data.medianSosAckMs > 5 * 60_000 ? (
                    <Banner
                      tone="danger"
                      icon="alert-octagon"
                      title="Acknowledgement is too slow"
                      message="A worker who has raised an SOS is waiting more than five minutes to learn that anyone has seen it. This is the single most time-critical path in the system."
                    />
                  ) : null}
                </View>
              </Card>
            </Section>

            {/* Team */}
            <Section title="Team" action={{ label: 'Manage', onPress: () => router.push('/(admin)/people') }}>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Stat label="Active this week" value={data.totals.activeWorkers} icon="users" />
                <Stat label="Alerts issued" value={data.totals.alerts} icon="bell" />
                <Stat
                  label="Officers"
                  value={data.officerLeaderboard.length}
                  icon="shield"
                  sublabel="verifying reports"
                />
              </View>
            </Section>

            <Banner
              tone="neutral"
              icon="lock"
              title="You can see everything, and verify nothing"
              message="Admins manage people and partnerships; officers verify reports and issue alerts. Keeping those apart is what makes the verification chain auditable."
            />
          </>
        )}
      </View>
    </Screen>
  );
}
