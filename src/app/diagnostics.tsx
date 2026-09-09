import Constants from 'expo-constants';
import * as Device from 'expo-device';
import { useEffect, useState } from 'react';
import { Platform, ScrollView, View } from 'react-native';

import { apiStats } from '@/api/client';
import { cache } from '@/api/cache';
import { db } from '@/api/db';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  DetailRow,
  Header,
  Meter,
  Screen,
  Section,
  Segmented,
  Text,
  Toggle,
} from '@/components/ui';
import { logger, type LogEntry } from '@/lib/logger';
import { percent, timeAgo } from '@/lib/format';
import { useConnectivity } from '@/state/connectivity';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Diagnostics.
 *
 * Two jobs. In the field it answers "is it me or is it the network" without
 * anyone needing to plug the phone into a laptop. In development it is where
 * the offline paths get exercised - the simulated-offline switch is the only
 * practical way to test a coverage gap from a desk, and every queue, cache and
 * retry path in the app treats it exactly like real loss of signal.
 */
export default function DiagnosticsScreen() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const { online, quality, connectionType, simulatedOffline, setSimulatedOffline, counts } = useConnectivity();

  const [tab, setTab] = useState<'health' | 'logs'>('health');
  const [, forceRender] = useState(0);
  const [resetOpen, setResetOpen] = useState(false);
  const [resetting, setResetting] = useState(false);

  // Logs stream in continuously; re-render on change rather than polling.
  useEffect(() => {
    const unsubscribe = logger.subscribe(() => forceRender((n) => n + 1));
    return () => {
      unsubscribe();
    };
  }, []);

  const stats = apiStats();
  const cacheStats = cache.stats();
  const logSummary = logger.summary();
  const entries = logger.entries();

  const healthy = stats.errorRate < 0.1 && online;

  return (
    <>
      <Screen>
        <Header
          title="Diagnostics"
          subtitle="Connection, performance and logs from this device"
          onBack
          right={
            <Badge
              label={healthy ? 'Healthy' : online ? 'Degraded' : 'Offline'}
              size="sm"
              dot
              color={healthy ? colors.success : colors.warning}
              background={healthy ? colors.successMuted : colors.warningMuted}
            />
          }
        />

        <View style={{ gap: spacing.xl }}>
          <Segmented
            options={[
              { value: 'health', label: 'Health' },
              { value: 'logs', label: 'Logs', badge: logSummary.errors },
            ]}
            value={tab}
            onChange={setTab}
          />

          {tab === 'health' ? (
            <>
              {/* Connection */}
              <Section title="Connection">
                <Card>
                  <View style={{ gap: 2 }}>
                    <DetailRow
                      label="Status"
                      value={online ? 'Online' : 'Offline'}
                      icon={online ? 'wifi' : 'wifi-off'}
                      tone={online ? colors.success : colors.warning}
                    />
                    <DetailRow label="Quality" value={quality} icon="activity" />
                    <DetailRow label="Transport" value={connectionType} icon="radio" />
                    <DetailRow label="Outbox" value={`${counts.total} item(s)`} icon="upload-cloud" />
                  </View>
                </Card>
              </Section>

              {/* Offline simulation */}
              <Section title="Testing">
                <Card>
                  <View style={{ gap: spacing.md }}>
                    <Toggle
                      icon="wifi-off"
                      label="Simulate no signal"
                      description="Treats the device as being out of coverage. Reports and SOS queue locally, caches serve stale data, and every retry path runs for real."
                      value={simulatedOffline}
                      onChange={(v) => {
                        setSimulatedOffline(v);
                        toast.info(
                          v ? 'Simulating offline' : 'Back online',
                          v ? 'File a report or trigger an SOS to see the outbox work.' : 'Queued items will now send.',
                        );
                      }}
                    />
                    {simulatedOffline ? (
                      <Banner
                        tone="warning"
                        compact
                        message="The app believes it has no connection. Turn this off to resume syncing."
                      />
                    ) : null}
                  </View>
                </Card>
              </Section>

              {/* Request performance */}
              <Section title="Request performance" subtitle={`Last ${stats.total} request(s) from this session.`}>
                <Card>
                  <View style={{ gap: spacing.lg }}>
                    <View style={{ flexDirection: 'row', gap: spacing.xxl, flexWrap: 'wrap' }}>
                      <Metric label="Median" value={`${stats.p50} ms`} />
                      <Metric label="p95" value={`${stats.p95} ms`} tone={stats.p95 > 2500 ? colors.warning : undefined} />
                      <Metric
                        label="Error rate"
                        value={percent(stats.errorRate, 1)}
                        tone={stats.errorRate > 0.1 ? colors.danger : colors.success}
                      />
                    </View>

                    <Meter
                      value={Math.min(1, stats.errorRate * 5)}
                      color={stats.errorRate > 0.1 ? colors.danger : colors.success}
                      label="Failure share (scaled)"
                    />

                    {stats.endpoints.length ? (
                      <View style={{ gap: spacing.sm }}>
                        <Text variant="label" tone="tertiary">
                          Busiest endpoints
                        </Text>
                        {stats.endpoints.map((endpoint) => (
                          <View
                            key={endpoint.name}
                            style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: spacing.md }}
                          >
                            <Text variant="caption" tone="secondary" numberOfLines={1} style={{ flex: 1 }}>
                              {endpoint.name}
                            </Text>
                            <Text variant="caption" tone="tertiary" tabular>
                              {endpoint.count}× · {endpoint.avgMs} ms
                            </Text>
                            {endpoint.failures ? (
                              <Badge label={`${endpoint.failures} failed`} size="sm" color={colors.danger} background={colors.dangerMuted} />
                            ) : null}
                          </View>
                        ))}
                      </View>
                    ) : (
                      <Text variant="footnote" tone="tertiary">
                        No requests recorded yet in this session.
                      </Text>
                    )}
                  </View>
                </Card>
              </Section>

              {/* Cache */}
              <Section title="Cache" subtitle="What is available if you lose signal right now.">
                <Card>
                  <View style={{ gap: 2 }}>
                    <DetailRow label="Entries" value={String(cacheStats.entries)} icon="database" />
                    <DetailRow label="Fresh" value={String(cacheStats.fresh)} icon="check-circle" tone={colors.success} />
                    <DetailRow label="Stale but usable" value={String(cacheStats.stale)} icon="clock" tone={colors.warning} />
                    <DetailRow label="Expired" value={String(cacheStats.expired)} icon="x-circle" />
                    <DetailRow label="In flight" value={String(cacheStats.inflight)} icon="loader" />
                  </View>
                </Card>
              </Section>

              {/* Device */}
              <Section title="Device">
                <Card>
                  <View style={{ gap: 2 }}>
                    <DetailRow label="App version" value={Constants.expoConfig?.version ?? '1.0.0'} icon="package" />
                    <DetailRow label="Platform" value={`${Platform.OS} ${Platform.Version}`} icon="smartphone" />
                    <DetailRow label="Model" value={Device.modelName ?? 'Unknown'} icon="cpu" />
                    <DetailRow label="Backend" value="Mock API (in-app)" icon="server" tone={colors.warning} />
                  </View>
                </Card>
              </Section>

              <Banner
                tone="warning"
                icon="database"
                title="This build uses a mock backend"
                message="All data lives on this device and is seeded deterministically. Resetting restores the original dataset and clears anything you have created."
              />

              <Button label="Reset demo data" variant="secondary" icon="refresh-cw" fullWidth onPress={() => setResetOpen(true)} />
            </>
          ) : (
            <>
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Metric label="Errors" value={String(logSummary.errors)} tone={logSummary.errors ? colors.danger : undefined} />
                <Metric label="Warnings" value={String(logSummary.warnings)} tone={logSummary.warnings ? colors.warning : undefined} />
                <Metric label="Entries" value={String(entries.length)} />
              </View>

              <Button
                label="Clear logs"
                variant="ghost"
                icon="trash-2"
                size="sm"
                onPress={() => {
                  logger.clear();
                  toast.info('Logs cleared');
                }}
              />

              {entries.length === 0 ? (
                <Banner tone="neutral" icon="check-circle" message="Nothing logged yet in this session." />
              ) : (
                <View style={{ gap: spacing.sm }}>
                  {entries.slice(0, 80).map((entry) => (
                    <LogRow key={entry.id} entry={entry} />
                  ))}
                </View>
              )}

              <Banner
                tone="neutral"
                icon="eye-off"
                title="Logs are redacted"
                message="Passwords, tokens and verification codes are never written to a log, and coordinates are rounded to roughly a kilometre so a log cannot re-identify a reporter."
              />
            </>
          )}
        </View>
      </Screen>

      <ConfirmSheet
        visible={resetOpen}
        onClose={() => setResetOpen(false)}
        onConfirm={async () => {
          setResetting(true);
          try {
            await db.reset();
            await cache.clear();
            toast.success('Demo data reset', 'Sign out and back in to see the fresh dataset.');
            setResetOpen(false);
          } finally {
            setResetting(false);
          }
        }}
        loading={resetting}
        title="Reset the demo dataset?"
        confirmLabel="Reset"
        message="Every report, alert and SOS you have created is discarded and the seeded dataset is restored. Your account stays signed in."
      />
    </>
  );
}

function Metric({ label, value, tone }: { label: string; value: string; tone?: string }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        gap: 2,
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
      }}
    >
      <Text variant="micro" tone="tertiary">
        {label}
      </Text>
      <Text variant="title3" color={tone} tabular>
        {value}
      </Text>
    </View>
  );
}

function LogRow({ entry }: { entry: LogEntry }) {
  const { colors, radius, spacing } = useTheme();

  const tone = {
    error: colors.danger,
    warn: colors.warning,
    info: colors.accentText,
    debug: colors.textTertiary,
  }[entry.level];

  return (
    <View
      style={{
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        gap: 4,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
        <View style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: tone }} />
        <Text variant="micro" weight="700" color={tone}>
          {entry.level.toUpperCase()}
        </Text>
        <Text variant="micro" tone="tertiary">
          {entry.scope}
        </Text>
        <View style={{ flex: 1 }} />
        <Text variant="micro" tone="tertiary">
          {timeAgo(entry.ts)}
        </Text>
      </View>

      <Text variant="caption" tone="secondary">
        {entry.message}
      </Text>

      {entry.data ? (
        <ScrollView horizontal showsHorizontalScrollIndicator={false}>
          <Text variant="micro" tone="tertiary" style={{ fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace' }}>
            {JSON.stringify(entry.data)}
          </Text>
        </ScrollView>
      ) : null}
    </View>
  );
}
