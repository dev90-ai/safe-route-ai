import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { View } from 'react-native';

import { pluralize, timeAgo } from '@/lib/format';
import { useConnectivity } from '@/state/connectivity';
import { useTheme } from '@/theme';
import { Text } from '../ui/Text';
import { Banner } from '../ui/Surface';

/**
 * Connectivity and outbox status.
 *
 * Shown on every screen that can create work. The rule it follows: never claim
 * something was sent when it is still on the device. A worker who believes a
 * report reached their officer, when it did not, is worse off than one who
 * knows it is queued.
 */
export function OfflineBanner({ compact }: { compact?: boolean }) {
  const { online, quality, counts, retryAll } = useConnectivity();
  const { colors, radius, spacing } = useTheme();

  const queued = counts.pending + counts.sending;

  if (online && quality === 'good' && !queued && !counts.failed) return null;

  if (!online) {
    return (
      <Banner
        tone="warning"
        icon="wifi-off"
        title="No connection"
        compact={compact}
        message={
          queued
            ? `${pluralize(queued, 'item')} waiting to send. They will go automatically the moment you have signal - you can keep working.`
            : 'You can still file reports and trigger SOS. Everything queues on this device and sends itself when signal returns.'
        }
      />
    );
  }

  if (counts.failed) {
    return (
      <Banner
        tone="danger"
        icon="alert-triangle"
        title={`${pluralize(counts.failed, 'item')} did not send`}
        compact={compact}
        message="These stopped after repeated failures. Review them before assuming your officer has seen them."
        action={{ label: 'Retry all', onPress: () => void retryAll() }}
      />
    );
  }

  if (queued) {
    return (
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          gap: spacing.sm,
          padding: spacing.md,
          borderRadius: radius.md,
          backgroundColor: colors.accentMuted,
          borderWidth: 1,
          borderColor: colors.border,
        }}
      >
        <Feather name="upload-cloud" size={14} color={colors.accentText} />
        <Text variant="footnote" tone="secondary" style={{ flex: 1 }}>
          Sending {pluralize(queued, 'item')}…
        </Text>
      </View>
    );
  }

  return (
    <Banner
      tone="warning"
      icon="wifi"
      title="Weak signal"
      compact={compact}
      message="Requests may be slow. Anything you submit is saved locally first, so nothing will be lost."
    />
  );
}

/** Stale-data marker. Paired with any cached list shown while offline. */
export function StaleDataNotice({ updatedAt, isOffline }: { updatedAt: number | null; isOffline: boolean }) {
  const { colors, spacing } = useTheme();
  if (!isOffline || !updatedAt) return null;

  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6, paddingVertical: spacing.xs }}>
      <Feather name="clock" size={11} color={colors.warning} />
      <Text variant="caption" tone="warning">
        Showing saved data from {timeAgo(updatedAt)}. New threats may not appear until you reconnect.
      </Text>
    </View>
  );
}

/** Persistent bar shown to a worker whose SOS is live. */
export function ActiveSosBar({ sosId, startedAt }: { sosId: string; startedAt: string }) {
  const { colors, radius, spacing } = useTheme();
  const router = useRouter();

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: spacing.md,
        padding: spacing.md,
        borderRadius: radius.md,
        backgroundColor: colors.dangerMuted,
        borderWidth: 1,
        borderColor: colors.danger,
      }}
    >
      <View
        style={{
          width: 32,
          height: 32,
          borderRadius: 16,
          backgroundColor: colors.danger,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <Feather name="radio" size={15} color={colors.white} />
      </View>
      <View style={{ flex: 1, gap: 2 }}>
        <Text variant="footnote" weight="700" tone="danger">
          SOS active
        </Text>
        <Text variant="caption" tone="secondary">
          Broadcasting your location since {timeAgo(startedAt)}
        </Text>
      </View>
      <Feather
        name="chevron-right"
        size={18}
        color={colors.danger}
        onPress={() => router.push({ pathname: '/sos/[id]', params: { id: sosId } })}
      />
    </View>
  );
}
