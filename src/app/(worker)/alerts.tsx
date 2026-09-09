import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { alertsApi } from '@/api/endpoints/alerts';
import type { MatchReason, NotificationRecord, SafetyAlert } from '@/api/types';
import { SeverityBadge } from '@/components/domain/Badges';
import { StaleDataNotice } from '@/components/domain/StatusBanners';
import {
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Header,
  Screen,
  Segmented,
  SkeletonCard,
  Text,
} from '@/components/ui';
import { SEVERITY_META } from '@/constants/threats';
import { useQuery } from '@/hooks/use-query';
import { useNow } from '@/hooks/use-now';
import { formatDistance } from '@/lib/geo';
import { timeAgo, timeUntil } from '@/lib/format';
import { useNotifications } from '@/state/notifications';
import { useTheme } from '@/theme';

/**
 * The persistent alert feed.
 *
 * Push notifications get missed - the phone is in a bag, the battery died, the
 * network was down. This feed is the record, and it is the thing a worker
 * checks when they come back into coverage. It also shows *why* each alert
 * reached them, which is what makes the fan-out rules legible rather than
 * mysterious.
 */

const REASON_LABEL: Record<MatchReason, { label: string; icon: keyof typeof Feather.glyphMap }> = {
  'same-organization': { label: 'Your organisation', icon: 'briefcase' },
  'partner-organization': { label: 'Partner organisation', icon: 'link' },
  'within-alert-radius': { label: 'Inside the alert radius', icon: 'radio' },
  'operating-region': { label: 'One of your regions', icon: 'map' },
  'direct-advisory': { label: 'Sent directly to you', icon: 'send' },
};

export default function AlertsScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const notifications = useNotifications();
  const [filter, setFilter] = useState<'all' | 'unread' | 'advisories'>('all');

  const feed = useQuery({
    key: 'alerts.feed',
    fetcher: () => alertsApi.feed(80),
    watch: ['notifications', 'alerts'],
  });

  const now = useNow(60_000);
  const items = useMemo(() => {
    const list = feed.data ?? [];
    if (filter === 'unread') return list.filter((i) => !i.notification.readAt);
    if (filter === 'advisories') return list.filter((i) => i.alert?.kind === 'advisory');
    return list;
  }, [feed.data, filter]);

  const unreadCount = (feed.data ?? []).filter((i) => !i.notification.readAt).length;

  const open = async (notification: NotificationRecord, alert: SafetyAlert | null) => {
    if (!notification.readAt) await notifications.markRead(notification.id);
    await feed.refetch({ silent: true });
    if (notification.reportId) {
      router.push({ pathname: '/report/[id]', params: { id: notification.reportId } });
    } else if (alert) {
      router.push({ pathname: '/alert/[id]', params: { id: alert.id } });
    }
  };

  return (
    <Screen refreshing={feed.isRefreshing} onRefresh={() => void feed.refetch()} extraBottomPadding={40}>
      <Header
        title="Alerts"
        subtitle={unreadCount ? `${unreadCount} unread` : 'You are up to date'}
        right={
          unreadCount ? (
            <Button
              label="Mark all read"
              variant="ghost"
              size="sm"
              onPress={async () => {
                await notifications.markAllRead();
                await feed.refetch({ silent: true });
              }}
            />
          ) : undefined
        }
      />

      <View style={{ gap: spacing.lg }}>
        <Segmented
          options={[
            { value: 'all', label: 'All' },
            { value: 'unread', label: 'Unread', badge: unreadCount },
            { value: 'advisories', label: 'Advisories' },
          ]}
          value={filter}
          onChange={setFilter}
        />

        {notifications.permission === 'unavailable' ? (
          <Banner
            tone="neutral"
            icon="bell-off"
            title="Notifications are not available in this build"
            message={notifications.unavailableMessage ?? ''}
          />
        ) : notifications.permission !== 'granted' ? (
          <Banner
            tone="warning"
            icon="bell-off"
            title="Push notifications are off"
            message="You will still see alerts here, but not while the app is closed. Critical threats can reach you much faster with push enabled."
            action={{ label: 'Turn on notifications', onPress: () => void notifications.requestPermission() }}
          />
        ) : null}

        <StaleDataNotice updatedAt={feed.updatedAt} isOffline={feed.isOffline} />

        {feed.isLoading && !feed.data ? (
          <View style={{ gap: spacing.md }}>
            <SkeletonCard />
            <SkeletonCard />
          </View>
        ) : items.length === 0 ? (
          <EmptyState
            icon={filter === 'unread' ? 'check-circle' : 'bell'}
            tone={filter === 'unread' ? 'positive' : 'neutral'}
            title={
              filter === 'unread'
                ? 'Nothing unread'
                : filter === 'advisories'
                  ? 'No advisories'
                  : 'No alerts yet'
            }
            message={
              filter === 'unread'
                ? 'You have read everything in your feed.'
                : filter === 'advisories'
                  ? 'Standing instructions from your security officers appear here - curfews, corridor restrictions, movement guidance.'
                  : 'Alerts about verified threats near you, or in the regions you work in, will appear here and stay available offline.'
            }
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            {items.map(({ notification, alert }) => {
              const expired = alert?.expiresAt ? Date.parse(alert.expiresAt) < now : false;
              const cancelled = !!alert?.cancelledAt;
              const unread = !notification.readAt;

              return (
                <Pressable
                  key={notification.id}
                  onPress={() => void open(notification, alert)}
                  accessibilityRole="button"
                  accessibilityLabel={`${unread ? 'Unread. ' : ''}${notification.title}`}
                >
                  <Card
                    accent={colors[SEVERITY_META[notification.severity].colorKey]}
                    style={{
                      opacity: cancelled || expired ? 0.6 : 1,
                      borderColor: unread ? colors.borderStrong : colors.border,
                    }}
                  >
                    <View style={{ gap: spacing.md }}>
                      <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm }}>
                        <View style={{ flex: 1, gap: 6 }}>
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
                            <SeverityBadge severity={notification.severity} size="sm" />
                            {alert?.kind === 'advisory' ? <Badge label="Advisory" icon="volume-2" size="sm" /> : null}
                            {cancelled ? (
                              <Badge label="Withdrawn" size="sm" color={colors.textTertiary} />
                            ) : expired ? (
                              <Badge label="Expired" size="sm" color={colors.textTertiary} />
                            ) : null}
                          </View>
                          <Text variant="bodyStrong" numberOfLines={2}>
                            {notification.title}
                          </Text>
                        </View>
                        {unread ? (
                          <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: colors.accent, marginTop: 4 }} />
                        ) : null}
                      </View>

                      <Text variant="footnote" tone="secondary" numberOfLines={3}>
                        {notification.body}
                      </Text>

                      {/* Why this reached you - the fan-out rules, made visible */}
                      <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                        {notification.matchReasons.map((reason) => (
                          <View
                            key={reason}
                            style={{ flexDirection: 'row', alignItems: 'center', gap: 4 }}
                          >
                            <Feather name={REASON_LABEL[reason].icon} size={10} color={colors.textTertiary} />
                            <Text variant="micro" tone="tertiary">
                              {REASON_LABEL[reason].label}
                              {reason === 'within-alert-radius' && notification.distanceMeters !== null
                                ? ` (${formatDistance(notification.distanceMeters)})`
                                : ''}
                            </Text>
                          </View>
                        ))}
                      </View>

                      <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                        <Text variant="caption" tone="tertiary">
                          {timeAgo(notification.deliveredAt)}
                        </Text>
                        {alert?.expiresAt && !expired && !cancelled ? (
                          <Text variant="caption" tone="tertiary">
                            Expires {timeUntil(alert.expiresAt)}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  </Card>
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </Screen>
  );
}
