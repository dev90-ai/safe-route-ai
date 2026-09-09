import Feather from '@expo/vector-icons/Feather';
import { View } from 'react-native';

import { OfflineBanner } from '@/components/domain/StatusBanners';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Header,
  Screen,
  Section,
  Text,
} from '@/components/ui';
import { THREAT_META } from '@/constants/threats';
import { formatDateTime, pluralize, timeAgo } from '@/lib/format';
import type { QueueItem } from '@/lib/offlineQueue';
import { useConnectivity } from '@/state/connectivity';
import { useNow } from '@/hooks/use-now';
import { useTheme } from '@/theme';

/**
 * The outbox.
 *
 * Everything the device is holding that has not reached the server. This screen
 * exists so a worker can answer "did my report actually go?" without guessing.
 * It is deliberately blunt about failures - a silently dropped report is worse
 * than a visibly failed one.
 */
export default function QueueScreen() {
  const { colors, spacing } = useTheme();
  const { queue, counts, online, retry, retryAll, discard, drain } = useConnectivity();

  const sorted = [...queue].sort((a, b) => {
    const order = { sos: 0, 'sos-location': 1, report: 2 } as const;
    return order[a.kind] - order[b.kind] || a.createdAt - b.createdAt;
  });

  return (
    <Screen>
      <Header
        title="Outbox"
        subtitle={counts.total ? `${pluralize(counts.total, 'item')} on this device` : 'Everything has been sent'}
        onBack
        right={
          counts.total && online ? (
            <Button label="Send now" icon="upload-cloud" size="sm" onPress={() => void drain()} />
          ) : undefined
        }
      />

      <View style={{ gap: spacing.xl }}>
        <OfflineBanner />

        {counts.total === 0 ? (
          <EmptyState
            icon="check-circle"
            tone="positive"
            title="Nothing waiting"
            message="Every report and SOS you have raised has reached the server. Anything you file without signal will appear here until it sends."
          />
        ) : (
          <>
            <View style={{ flexDirection: 'row', gap: spacing.sm }}>
              <Counter label="Waiting" value={counts.pending} color={colors.warning} />
              <Counter label="Sending" value={counts.sending} color={colors.accent} />
              <Counter label="Failed" value={counts.failed} color={counts.failed ? colors.danger : colors.textTertiary} />
            </View>

            {counts.failed ? (
              <Banner
                tone="danger"
                icon="alert-triangle"
                title={`${pluralize(counts.failed, 'item')} stopped retrying`}
                message="These hit an error that will not resolve by waiting. Review each one - do not assume your officer has seen it."
                action={{ label: 'Retry all', onPress: () => void retryAll() }}
              />
            ) : null}

            <View style={{ gap: spacing.md }}>
              {sorted.map((item) => (
                <QueueCard
                  key={item.queueId}
                  item={item}
                  onRetry={() => void retry(item.queueId)}
                  onDiscard={() => void discard(item.queueId)}
                />
              ))}
            </View>
          </>
        )}

        <Section title="How this works">
          <Banner
            tone="neutral"
            icon="info"
            message="Reports and SOS triggers are saved to this device before any network call is attempted, and each carries an id generated here. If a submission is retried after a timeout the server recognises the id and stores it once - so retrying can never create a duplicate report."
          />
          <Banner
            tone="neutral"
            icon="zap"
            message="An SOS always jumps the queue ahead of reports, and sends the instant a connection returns - even if the app has been closed and reopened since."
          />
        </Section>
      </View>
    </Screen>
  );
}

function Counter({ label, value, color }: { label: string; value: number; color: string }) {
  const { colors, radius, spacing } = useTheme();
  return (
    <View
      style={{
        flex: 1,
        padding: spacing.md,
        borderRadius: radius.md,
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.surface,
        gap: 2,
      }}
    >
      <Text variant="micro" tone="tertiary">
        {label}
      </Text>
      <Text variant="title2" color={value ? color : undefined} tabular>
        {value}
      </Text>
    </View>
  );
}

function QueueCard({ item, onRetry, onDiscard }: { item: QueueItem; onRetry: () => void; onDiscard: () => void }) {
  const { colors, spacing } = useTheme();

  const now = useNow(10_000);
  const meta = {
    sos: { label: 'SOS', icon: 'radio' as const, color: colors.danger },
    'sos-location': { label: 'SOS location update', icon: 'map-pin' as const, color: colors.danger },
    report: { label: 'Threat report', icon: 'file-text' as const, color: colors.accent },
  }[item.kind];

  const statusMeta = {
    pending: { label: 'Waiting for signal', color: colors.warning, background: colors.warningMuted, icon: 'clock' as const },
    sending: { label: 'Sending…', color: colors.accent, background: colors.accentMuted, icon: 'upload-cloud' as const },
    failed: { label: 'Did not send', color: colors.danger, background: colors.dangerMuted, icon: 'alert-triangle' as const },
  }[item.status];

  return (
    <Card accent={meta.color}>
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
          <Badge label={meta.label} icon={meta.icon} size="sm" color={meta.color} background={`${meta.color}1F`} />
          <Badge label={statusMeta.label} icon={statusMeta.icon} size="sm" color={statusMeta.color} background={statusMeta.background} />
          {item.attempts > 0 ? <Badge label={`${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`} size="sm" /> : null}
        </View>

        {item.kind === 'report' ? (
          <>
            <Text variant="footnote" numberOfLines={3}>
              {item.payload.description}
            </Text>
            <Text variant="caption" tone="tertiary">
              {item.payload.reportedType ? `${THREAT_META[item.payload.reportedType].label} · ` : ''}
              {item.payload.location.lat.toFixed(4)}, {item.payload.location.lng.toFixed(4)}
              {item.localPhotoUri ? ' · photo attached' : ''}
            </Text>
          </>
        ) : item.kind === 'sos' ? (
          <Text variant="footnote">
            Emergency at {item.payload.location.lat.toFixed(4)}, {item.payload.location.lng.toFixed(4)}
            {item.payload.reason ? ` - ${item.payload.reason}` : ''}
          </Text>
        ) : (
          <Text variant="footnote" tone="secondary">
            Position update for an active SOS.
          </Text>
        )}

        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md, flexWrap: 'wrap' }}>
          <Text variant="caption" tone="tertiary">
            Queued {timeAgo(item.createdAt)}
          </Text>
          {item.lastAttemptAt ? (
            <Text variant="caption" tone="tertiary">
              Last tried {timeAgo(item.lastAttemptAt)}
            </Text>
          ) : null}
          {item.status === 'pending' && item.nextAttemptAt > now ? (
            <Text variant="caption" tone="tertiary">
              Next try {formatDateTime(item.nextAttemptAt)}
            </Text>
          ) : null}
        </View>

        {item.lastError ? (
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'flex-start',
              gap: 6,
              padding: spacing.sm,
              borderRadius: 8,
              backgroundColor: colors.dangerMuted,
            }}
          >
            <Feather name="alert-circle" size={12} color={colors.danger} style={{ marginTop: 2 }} />
            <Text variant="caption" tone="danger" style={{ flex: 1 }}>
              {item.lastError}
            </Text>
          </View>
        ) : null}

        {item.status === 'failed' ? (
          <View style={{ flexDirection: 'row', gap: spacing.sm }}>
            <Button label="Retry" icon="refresh-cw" size="sm" variant="secondary" onPress={onRetry} style={{ flex: 1 }} />
            <Button label="Discard" icon="trash-2" size="sm" variant="ghost" onPress={onDiscard} style={{ flex: 1 }} />
          </View>
        ) : null}
      </View>
    </Card>
  );
}
