import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { analyticsApi } from '@/api/endpoints/analytics';
import { reportsApi } from '@/api/endpoints/reports';
import { sosApi } from '@/api/endpoints/sos';
import type { ThreatReport } from '@/api/types';
import { VerifySheet } from '@/components/domain/VerifySheet';
import { OfflineBanner, StaleDataNotice } from '@/components/domain/StatusBanners';

import {
  Avatar,
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
  SkeletonCard,
  Stat,
  Text,
} from '@/components/ui';
import { SEVERITY_META, THREAT_META, type Severity } from '@/constants/threats';
import { useQuery } from '@/hooks/use-query';
import { useNow } from '@/hooks/use-now';
import { formatDuration, timeAgo } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';

/**
 * The officer's verification queue - the operational heart of the product.
 *
 * Ordering is by AI-suggested priority, then age. That combination matters: a
 * pure FIFO queue buries a suspected IED behind six checkpoint reports, while
 * pure priority lets low-severity reports rot forever. The screen also shows
 * the oldest waiting time prominently, because a report sitting unverified is
 * the failure mode this whole system exists to prevent.
 */
export default function OfficerQueue() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { user } = useAuth();

  const [filter, setFilter] = useState<'all' | 'high' | 'duplicates' | 'needs-info'>('all');
  const [verifyTarget, setVerifyTarget] = useState<ThreatReport | null>(null);

  const queue = useQuery({
    key: 'officer.queue',
    fetcher: () => reportsApi.pendingQueue(),
    watch: ['reports'],
    pollMs: 30_000,
  });

  const summary = useQuery({
    key: `officer.summary.${user!.profile.id}`,
    fetcher: () => analyticsApi.officerSummary(),
    watch: ['reports', 'sosEvents'],
  });

  const activeSos = useQuery({
    key: 'sos.active',
    fetcher: () => sosApi.active(),
    watch: ['sosEvents'],
    pollMs: 15_000,
  });

  const filtered = useMemo(() => {
    const list = queue.data ?? [];
    if (filter === 'high') {
      return list.filter((r) => {
        const sev = r.aiSuggestions?.severity;
        return sev === 'high' || sev === 'critical';
      });
    }
    if (filter === 'duplicates') return list.filter((r) => r.possibleDuplicateOf ?? r.aiSuggestions?.possibleDuplicateOf);
    if (filter === 'needs-info') return list.filter((r) => r.aiSuggestions?.needsMoreInfo);
    return list;
  }, [queue.data, filter]);

  const counts = useMemo(() => {
    const list = queue.data ?? [];
    return {
      all: list.length,
      high: list.filter((r) => r.aiSuggestions?.severity === 'high' || r.aiSuggestions?.severity === 'critical').length,
      duplicates: list.filter((r) => r.possibleDuplicateOf ?? r.aiSuggestions?.possibleDuplicateOf).length,
      needsInfo: list.filter((r) => r.aiSuggestions?.needsMoreInfo).length,
    };
  }, [queue.data]);

  const oldestMs = summary.data?.oldestPendingMs ?? 0;
  const oldestIsStale = oldestMs > 2 * 3_600_000;

  return (
    <>
      <Screen refreshing={queue.isRefreshing} onRefresh={() => void queue.refetch()} extraBottomPadding={40}>
        <Header
          title="Verification queue"
          subtitle={`${counts.all} report${counts.all === 1 ? '' : 's'} awaiting your decision`}
          right={
            <Pressable onPress={() => router.push('/settings')} accessibilityRole="button" accessibilityLabel="Settings">
              <Avatar name={user!.profile.fullName} color={user!.profile.avatarColor} size={40} />
            </Pressable>
          }
        />

        <View style={{ gap: spacing.xl }}>
          <OfflineBanner />

          {/* Live SOS always outranks the queue */}
          {activeSos.data?.length ? (
            <Pressable onPress={() => router.push('/(officer)/sos')} accessibilityRole="button">
              <Card style={{ backgroundColor: colors.dangerMuted, borderColor: colors.danger }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                  <View
                    style={{
                      width: 38,
                      height: 38,
                      borderRadius: 19,
                      backgroundColor: colors.danger,
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    <Feather name="radio" size={17} color={colors.white} />
                  </View>
                  <View style={{ flex: 1, gap: 2 }}>
                    <Text variant="bodyStrong" tone="danger">
                      {activeSos.data.length} active SOS
                    </Text>
                    <Text variant="caption" tone="secondary">
                      {activeSos.data.filter((e) => e.status === 'active').length} not yet acknowledged · oldest{' '}
                      {timeAgo(activeSos.data[0].createdAt)}
                    </Text>
                  </View>
                  <Feather name="chevron-right" size={18} color={colors.danger} />
                </View>
              </Card>
            </Pressable>
          ) : null}

          {/* Operational counters */}
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Stat label="Pending" value={counts.all} icon="inbox" tone={counts.all ? colors.warning : undefined} />
            <Stat
              label="Oldest waiting"
              value={oldestMs ? formatDuration(oldestMs) : '—'}
              icon="clock"
              tone={oldestIsStale ? colors.danger : undefined}
            />
            <Stat label="Verified today" value={summary.data?.verifiedToday ?? '—'} icon="check-circle" />
          </View>

          {oldestIsStale ? (
            <Banner
              tone="warning"
              icon="clock"
              title="A report has been waiting over two hours"
              message="Until an officer verifies it, nobody in the field is alerted. If you cannot review it now, hand over to another officer."
            />
          ) : null}

          {/* Filters */}
          <ChipRow>
            <Chip label="All" count={counts.all} selected={filter === 'all'} onPress={() => setFilter('all')} />
            <Chip
              label="High / critical"
              count={counts.high}
              color={colors.danger}
              selected={filter === 'high'}
              onPress={() => setFilter('high')}
            />
            <Chip
              label="Possible duplicates"
              count={counts.duplicates}
              color={colors.warning}
              selected={filter === 'duplicates'}
              onPress={() => setFilter('duplicates')}
            />
            <Chip
              label="Needs detail"
              count={counts.needsInfo}
              selected={filter === 'needs-info'}
              onPress={() => setFilter('needs-info')}
            />
          </ChipRow>

          <StaleDataNotice updatedAt={queue.updatedAt} isOffline={queue.isOffline} />

          {/* Queue */}
          {queue.isLoading && !queue.data ? (
            <View style={{ gap: spacing.md }}>
              <SkeletonCard />
              <SkeletonCard />
            </View>
          ) : filtered.length === 0 ? (
            <EmptyState
              icon="check-circle"
              tone="positive"
              title={counts.all ? 'Nothing matches that filter' : 'Queue is clear'}
              message={
                counts.all
                  ? 'Switch back to All to see the rest of the queue.'
                  : 'Every report has been verified or dismissed. New submissions appear here immediately.'
              }
              action={counts.all ? { label: 'Show all', onPress: () => setFilter('all') } : undefined}
            />
          ) : (
            <View style={{ gap: spacing.md }}>
              {filtered.map((report, index) => (
                <QueueItem
                  key={report.id}
                  report={report}
                  position={index + 1}
                  onOpen={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })}
                  onVerify={() => setVerifyTarget(report)}
                />
              ))}
            </View>
          )}

          <Section title="Reference">
            <Banner
              tone="neutral"
              icon="shield"
              title="Nothing reaches the field without you"
              message="An AI suggestion is only a suggestion. No alert is sent, no map pin appears and no route score changes until an officer verifies the report."
            />
          </Section>
        </View>
      </Screen>

      {verifyTarget ? (
        <VerifySheet
          key={verifyTarget.id}
          visible={!!verifyTarget}
          report={verifyTarget}
          onClose={() => setVerifyTarget(null)}
          onDone={async () => {
            setVerifyTarget(null);
            await Promise.all([queue.refetch(), summary.refetch()]);
          }}
        />
      ) : null}
    </>
  );
}

function QueueItem({
  report,
  position,
  onOpen,
  onVerify,
}: {
  report: ThreatReport;
  position: number;
  onOpen: () => void;
  onVerify: () => void;
}) {
  const { colors, spacing } = useTheme();
  const now = useNow(30_000);
  const ai = report.aiSuggestions;
  const severity: Severity = ai?.severity ?? 'low';
  const waitedMs = now - Date.parse(report.createdAt);

  return (
    <Card accent={colors[SEVERITY_META[severity].colorKey]}>
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Badge label={`#${position}`} size="sm" />
          {ai ? (
            <Badge
              label={`Priority ${ai.priority}/10`}
              size="sm"
              icon="trending-up"
              color={ai.priority >= 7 ? colors.danger : colors.textSecondary}
              background={ai.priority >= 7 ? colors.dangerMuted : colors.surfaceSunken}
            />
          ) : null}
          <Badge
            label={`Waiting ${formatDuration(waitedMs)}`}
            size="sm"
            icon="clock"
            color={waitedMs > 2 * 3_600_000 ? colors.danger : colors.textSecondary}
            background={waitedMs > 2 * 3_600_000 ? colors.dangerMuted : colors.surfaceSunken}
          />
          <Badge label={report.reference} size="sm" />
        </View>

        <Text variant="body" numberOfLines={3} style={{ lineHeight: 21 }}>
          {report.description}
        </Text>

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' }}>
          <MetaChip icon="map-pin" text={report.placeLabel ?? 'Unknown area'} />
          <MetaChip icon="clock" text={timeAgo(report.occurredAt)} />
          {report.photoUrl ? <MetaChip icon="image" text="Photo" /> : null}
          {report.locationSource === 'manual-pin' ? <MetaChip icon="map-pin" text="Manual pin" /> : null}
        </View>

        {/* What the model proposes, compactly */}
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: spacing.sm,
            paddingTop: spacing.sm,
            borderTopWidth: 1,
            borderTopColor: colors.divider,
            flexWrap: 'wrap',
          }}
        >
          {report.aiStatus === 'complete' && ai ? (
            <>
              <Feather name="cpu" size={12} color={colors.accentText} />
              <Text variant="caption" tone="secondary">
                {THREAT_META[ai.threatType].label} · {SEVERITY_META[ai.severity].label} ·{' '}
                {Math.round(ai.confidence * 100)}% confidence
              </Text>
              {ai.possibleDuplicateOf ? (
                <Badge label="Duplicate?" icon="copy" size="sm" color={colors.warning} background={colors.warningMuted} />
              ) : null}
              {ai.needsMoreInfo ? (
                <Badge label="Thin detail" icon="help-circle" size="sm" color={colors.warning} background={colors.warningMuted} />
              ) : null}
            </>
          ) : report.aiStatus === 'failed' ? (
            <Text variant="caption" tone="tertiary">
              AI unavailable - verify manually
            </Text>
          ) : (
            <Text variant="caption" tone="accent">
              Analysing…
            </Text>
          )}
        </View>

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          <Button label="Review" icon="check-circle" size="sm" onPress={onVerify} style={{ flex: 1 }} />
          <Button label="Open" icon="external-link" variant="secondary" size="sm" onPress={onOpen} style={{ flex: 1 }} />
        </View>
      </View>
    </Card>
  );
}

function MetaChip({ icon, text }: { icon: keyof typeof Feather.glyphMap; text: string }) {
  const { colors } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}>
      <Feather name={icon} size={11} color={colors.textTertiary} />
      <Text variant="caption" tone="tertiary">
        {text}
      </Text>
    </View>
  );
}
