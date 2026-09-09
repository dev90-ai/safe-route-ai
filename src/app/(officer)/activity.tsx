import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { analyticsApi } from '@/api/endpoints/analytics';
import { orgApi } from '@/api/endpoints/org';
import type { AuditEntry } from '@/api/types';
import {
  Avatar,
  Badge,
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
import { useQuery } from '@/hooks/use-query';
import { formatDuration, percent, timeAgo } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';

/**
 * Officer activity and accountability.
 *
 * The AI agreement rate is here rather than on the admin dashboard on purpose:
 * it is a mirror for the officer, not a management metric. A rate near 100%
 * means the human step has quietly become a rubber stamp, and the person best
 * placed to notice that is the officer themselves.
 */
export default function ActivityScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { user } = useAuth();
  const [entityFilter, setEntityFilter] = useState<AuditEntry['entity'] | 'all'>('all');

  const analytics = useQuery({
    key: 'officer.analytics',
    fetcher: () => analyticsApi.overview(24 * 30),
    watch: ['reports'],
  });

  const audit = useQuery({
    key: `audit.${entityFilter}`,
    fetcher: () => orgApi.auditLog({ limit: 60, entity: entityFilter === 'all' ? undefined : entityFilter }),
    watch: ['audit'],
  });

  const directory = useQuery({ key: 'org.directory', fetcher: () => orgApi.directory() });

  const me = useMemo(
    () => analytics.data?.officerLeaderboard.find((o) => o.profileId === user!.profile.id) ?? null,
    [analytics.data, user],
  );

  const agreement = analytics.data?.aiAgreementRate ?? 0;
  const agreementTone =
    agreement > 0.92 ? colors.warning : agreement < 0.5 ? colors.warning : colors.success;

  return (
    <Screen refreshing={analytics.isRefreshing} onRefresh={() => void analytics.refetch()} extraBottomPadding={40}>
      <Header title="Activity" subtitle="Your organisation's verification record, last 30 days" />

      <View style={{ gap: spacing.xxl }}>
        {analytics.isLoading && !analytics.data ? (
          <SkeletonCard lines={4} />
        ) : (
          <>
            {/* Personal */}
            <Section title="You">
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Stat label="Verified" value={me?.verified ?? 0} icon="check-circle" />
                <Stat
                  label="Median time"
                  value={me ? formatDuration(me.medianMs) : '—'}
                  icon="clock"
                  sublabel="report to decision"
                />
                <Stat label="Pending now" value={analytics.data?.totals.pending ?? 0} icon="inbox" />
              </View>
            </Section>

            {/* Verification speed */}
            <Section title="Verification speed" subtitle="How long a report waits before a human decides.">
              <Card>
                <View style={{ gap: spacing.lg }}>
                  <View style={{ flexDirection: 'row', gap: spacing.xxl }}>
                    <View style={{ gap: 2 }}>
                      <Text variant="micro" tone="tertiary">
                        Median
                      </Text>
                      <Text variant="title2" tabular>
                        {formatDuration(analytics.data?.medianVerificationMs ?? 0)}
                      </Text>
                    </View>
                    <View style={{ gap: 2 }}>
                      <Text variant="micro" tone="tertiary">
                        Slowest 10%
                      </Text>
                      <Text
                        variant="title2"
                        tabular
                        color={(analytics.data?.p90VerificationMs ?? 0) > 4 * 3_600_000 ? colors.danger : undefined}
                      >
                        {formatDuration(analytics.data?.p90VerificationMs ?? 0)}
                      </Text>
                    </View>
                  </View>
                  <Text variant="caption" tone="tertiary">
                    Every minute here is a minute in which a real threat is known to the system but not to the people in
                    the field.
                  </Text>
                </View>
              </Card>
            </Section>

            {/* AI agreement */}
            <Section title="AI agreement" subtitle="How often officers accepted the model unchanged.">
              <Card>
                <View style={{ gap: spacing.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm }}>
                    <Text variant="display" color={agreementTone} tabular>
                      {percent(agreement)}
                    </Text>
                    <Text variant="footnote" tone="tertiary">
                      accepted as-is
                    </Text>
                  </View>
                  <Meter value={agreement} color={agreementTone} />
                  <Text variant="footnote" tone="secondary">
                    {agreement > 0.92
                      ? 'Very high. Worth checking that the AI suggestion is genuinely being read rather than confirmed by habit - the human step only adds safety if it can produce a different answer.'
                      : agreement < 0.5
                        ? 'Low. The model is disagreeing with officers more often than it agrees, which suggests it needs retuning for this context.'
                        : 'Healthy. Officers are accepting good suggestions and overriding the rest.'}
                  </Text>
                  <Text variant="caption" tone="tertiary">
                    Based on {analytics.data?.totals.verified ?? 0} verified reports.{' '}
                    {analytics.data?.totals.duplicatesCaught ?? 0} duplicate(s) were caught before an alert went out.
                  </Text>
                </View>
              </Card>
            </Section>

            {/* Team */}
            {analytics.data?.officerLeaderboard.length ? (
              <Section title="Officers">
                <Card>
                  <View style={{ gap: spacing.lg }}>
                    {analytics.data.officerLeaderboard.map((officer) => (
                      <View key={officer.profileId} style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                        <Avatar name={officer.name} color={directory.data?.[officer.profileId]?.color} size={34} />
                        <View style={{ flex: 1, gap: 1 }}>
                          <Text variant="footnote" weight="600">
                            {officer.name}
                            {officer.profileId === user!.profile.id ? ' (you)' : ''}
                          </Text>
                          <Text variant="caption" tone="tertiary">
                            median {formatDuration(officer.medianMs)}
                          </Text>
                        </View>
                        <Badge label={`${officer.verified} verified`} size="sm" />
                      </View>
                    ))}
                  </View>
                </Card>
              </Section>
            ) : null}
          </>
        )}

        {/* Audit log */}
        <Section title="Audit log" subtitle="Every state change, with who made it and when.">
          <ChipRow>
            {(['all', 'report', 'alert', 'sos', 'profile'] as const).map((entity) => (
              <Chip
                key={entity}
                label={entity === 'all' ? 'Everything' : entity}
                selected={entityFilter === entity}
                onPress={() => setEntityFilter(entity)}
              />
            ))}
          </ChipRow>

          {audit.isLoading && !audit.data ? (
            <SkeletonCard lines={5} />
          ) : audit.data?.length ? (
            <Card>
              <View style={{ gap: spacing.lg }}>
                {audit.data.slice(0, 40).map((entry, index) => (
                  <Pressable
                    key={entry.id}
                    disabled={entry.entity !== 'report' && entry.entity !== 'sos'}
                    onPress={() =>
                      entry.entity === 'report'
                        ? router.push({ pathname: '/report/[id]', params: { id: entry.entityId } })
                        : entry.entity === 'sos'
                          ? router.push({ pathname: '/sos/[id]', params: { id: entry.entityId } })
                          : undefined
                    }
                    accessibilityRole={entry.entity === 'report' ? 'button' : 'none'}
                    style={{ flexDirection: 'row', gap: spacing.md }}
                  >
                    <View style={{ alignItems: 'center', width: 18 }}>
                      <View
                        style={{
                          width: 7,
                          height: 7,
                          borderRadius: 4,
                          marginTop: 5,
                          backgroundColor:
                            entry.actorRole === 'system'
                              ? colors.textTertiary
                              : entry.action.includes('dismiss')
                                ? colors.warning
                                : entry.action.includes('sos')
                                  ? colors.danger
                                  : colors.accent,
                        }}
                      />
                      {index < Math.min(audit.data!.length, 40) - 1 ? (
                        <View style={{ flex: 1, width: 1, backgroundColor: colors.divider, marginTop: 3 }} />
                      ) : null}
                    </View>
                    <View style={{ flex: 1, gap: 3, paddingBottom: spacing.sm }}>
                      <Text variant="footnote">{entry.summary}</Text>
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                        <Text variant="caption" tone="tertiary">
                          {timeAgo(entry.ts)}
                        </Text>
                        <Text variant="caption" tone="tertiary">
                          ·
                        </Text>
                        <Text variant="caption" tone="tertiary">
                          {entry.action}
                        </Text>
                      </View>
                    </View>
                  </Pressable>
                ))}
              </View>
            </Card>
          ) : (
            <EmptyState compact icon="list" title="Nothing recorded yet" message="Actions appear here as they happen." />
          )}
        </Section>

        <Banner
          tone="neutral"
          icon="lock"
          title="The log is append-only"
          message="Entries cannot be edited or deleted from the app. This is what makes the verification chain defensible after an incident."
        />
      </View>
    </Screen>
  );
}
