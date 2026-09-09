import { useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import { sosApi } from '@/api/endpoints/sos';
import type { SosEvent } from '@/api/types';
import { ThreatMap } from '@/components/domain/ThreatMap';
import {
  Avatar,
  Badge,
  Banner,
  Button,
  Card,
  EmptyState,
  Header,
  Screen,
  Section,
  Segmented,
  SkeletonCard,
  Text,
} from '@/components/ui';
import { useQuery } from '@/hooks/use-query';
import { elapsedClock, formatDuration, timeAgo } from '@/lib/format';
import { formatDistance } from '@/lib/geo';
import { useTheme } from '@/theme';

/**
 * SOS console.
 *
 * The only screen in the app that polls aggressively. A live SOS is the one
 * case where a stale view is genuinely dangerous, so the freshness cost is
 * worth paying here and nowhere else.
 */
export default function SosConsole() {
  const { spacing } = useTheme();
  const router = useRouter();
  const [tab, setTab] = useState<'active' | 'history'>('active');

  const active = useQuery({
    key: 'sos.active',
    fetcher: () => sosApi.active(),
    watch: ['sosEvents'],
    pollMs: 10_000,
  });

  const history = useQuery({
    key: 'sos.history',
    fetcher: () => sosApi.history(40),
    watch: ['sosEvents'],
    enabled: tab === 'history',
  });

  const directory = useQuery({ key: 'org.directory', fetcher: () => orgApi.directory() });

  const events = tab === 'active' ? active.data ?? [] : history.data ?? [];
  const unacknowledged = (active.data ?? []).filter((e) => e.status === 'active').length;

  return (
    <Screen
      refreshing={active.isRefreshing}
      onRefresh={() => void (tab === 'active' ? active.refetch() : history.refetch())}
      extraBottomPadding={40}
    >
      <Header
        title="SOS"
        subtitle={
          unacknowledged
            ? `${unacknowledged} awaiting acknowledgement`
            : active.data?.length
              ? `${active.data.length} in progress, all acknowledged`
              : 'No active emergencies'
        }
      />

      <View style={{ gap: spacing.lg }}>
        <Segmented
          options={[
            { value: 'active', label: 'Active', badge: active.data?.length ?? 0 },
            { value: 'history', label: 'History' },
          ]}
          value={tab}
          onChange={setTab}
        />

        {unacknowledged ? (
          <Banner
            tone="danger"
            icon="alert-octagon"
            title={`${unacknowledged} SOS not yet acknowledged`}
            message="Acknowledging tells the worker that a human has seen it. Do that first, then coordinate the response."
          />
        ) : null}

        {(tab === 'active' ? active.isLoading && !active.data : history.isLoading && !history.data) ? (
          <View style={{ gap: spacing.md }}>
            <SkeletonCard lines={4} />
          </View>
        ) : events.length === 0 ? (
          <EmptyState
            icon={tab === 'active' ? 'check-circle' : 'archive'}
            tone={tab === 'active' ? 'positive' : 'neutral'}
            title={tab === 'active' ? 'No active SOS' : 'No SOS history'}
            message={
              tab === 'active'
                ? 'Nobody in your organisation has an emergency open. Live events appear here within seconds of being raised.'
                : 'Resolved and cancelled events are retained here for post-incident review.'
            }
          />
        ) : (
          <View style={{ gap: spacing.md }}>
            {events.map((event) => (
              <SosCard
                key={event.id}
                event={event}
                workerName={directory.data?.[event.workerId]?.name ?? 'Unknown worker'}
                workerColor={directory.data?.[event.workerId]?.color}
                onOpen={() => router.push({ pathname: '/sos/[id]', params: { id: event.id } })}
                onAcknowledge={async () => {
                  await sosApi.acknowledge(event.id);
                  await active.refetch();
                }}
              />
            ))}
          </View>
        )}

        {tab === 'active' ? (
          <Section title="Reference">
            <Banner
              tone="neutral"
              icon="info"
              title="SOS is not cross-shared"
              message="Live worker locations stay inside their own organisation, even between cross-share partners. A partner's threat reports are shared; their people's positions are not."
            />
          </Section>
        ) : null}
      </View>
    </Screen>
  );
}

function SosCard({
  event,
  workerName,
  workerColor,
  onOpen,
  onAcknowledge,
}: {
  event: SosEvent;
  workerName: string;
  workerColor?: string;
  onOpen: () => void;
  onAcknowledge: () => void | Promise<void>;
}) {
  const { colors, spacing } = useTheme();
  const [now, setNow] = useState(() => Date.now());
  const [acknowledging, setAcknowledging] = useState(false);

  const isLive = event.status === 'active' || event.status === 'acknowledged';

  // A ticking clock is the clearest possible signal that this is happening now.
  useEffect(() => {
    if (!isLive) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [isLive]);

  const statusMeta = {
    active: { label: 'UNACKNOWLEDGED', color: colors.danger, background: colors.dangerMuted },
    acknowledged: { label: 'Acknowledged', color: colors.warning, background: colors.warningMuted },
    resolved: { label: 'Resolved', color: colors.success, background: colors.successMuted },
    cancelled: { label: 'Stood down', color: colors.textTertiary, background: colors.surfaceSunken },
  }[event.status];

  const trackDistance =
    event.track.length > 1
      ? event.track.slice(1).reduce((total, point, i) => {
          const previous = event.track[i];
          const dLat = (point.point.lat - previous.point.lat) * 111_320;
          const dLng = (point.point.lng - previous.point.lng) * 111_320 * Math.cos((point.point.lat * Math.PI) / 180);
          return total + Math.hypot(dLat, dLng);
        }, 0)
      : 0;

  return (
    <Card
      accent={statusMeta.color}
      style={event.status === 'active' ? { borderColor: colors.danger, borderWidth: 1.5 } : undefined}
    >
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <Avatar
            name={workerName}
            color={workerColor}
            size={42}
            badge={isLive ? { icon: 'radio', color: colors.danger } : undefined}
          />
          <View style={{ flex: 1, gap: 3 }}>
            <Text variant="bodyStrong">{workerName}</Text>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
              <Badge label={statusMeta.label} size="sm" color={statusMeta.color} background={statusMeta.background} dot />
              {isLive ? (
                <Text variant="caption" tone="danger" weight="700" tabular>
                  {elapsedClock(Date.parse(event.createdAt), now)}
                </Text>
              ) : (
                <Text variant="caption" tone="tertiary">
                  {timeAgo(event.createdAt)}
                </Text>
              )}
            </View>
          </View>
        </View>

        {event.reason ? (
          <Text variant="footnote" tone="secondary">
            &ldquo;{event.reason}&rdquo;
          </Text>
        ) : null}

        {isLive ? (
          <ThreatMap
            height={160}
            center={event.location}
            zoomRadiusMeters={2500}
            interactive={false}
            showsUserLocation={false}
            markers={[{ id: event.id, point: event.location, label: workerName.split(' ')[0], color: colors.danger, kind: 'sos' }]}
            routes={
              event.track.length > 1
                ? [{ id: 'track', path: event.track.map((t) => t.point), color: colors.danger, dashed: true }]
                : []
            }
          />
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.lg, flexWrap: 'wrap' }}>
          <Metric label="Position" value={`${event.location.lat.toFixed(4)}, ${event.location.lng.toFixed(4)}`} />
          {event.accuracyMeters ? <Metric label="Accuracy" value={`±${Math.round(event.accuracyMeters)} m`} /> : null}
          <Metric label="Updates" value={String(event.track.length)} />
          {trackDistance > 50 ? <Metric label="Moved" value={formatDistance(trackDistance)} /> : null}
        </View>

        {event.acknowledgedAt ? (
          <Text variant="caption" tone="tertiary">
            Acknowledged {formatDuration(Date.parse(event.acknowledgedAt) - Date.parse(event.createdAt))} after it was
            raised.
          </Text>
        ) : null}

        {event.resolutionNote ? (
          <View
            style={{
              padding: spacing.md,
              borderRadius: 10,
              backgroundColor: colors.surfaceSunken,
            }}
          >
            <Text variant="caption" tone="secondary">
              {event.resolutionNote}
            </Text>
          </View>
        ) : null}

        <View style={{ flexDirection: 'row', gap: spacing.sm }}>
          {event.status === 'active' ? (
            <Button
              label="Acknowledge"
              icon="check"
              variant="danger"
              size="sm"
              loading={acknowledging}
              style={{ flex: 1 }}
              onPress={async () => {
                setAcknowledging(true);
                try {
                  await onAcknowledge();
                } finally {
                  setAcknowledging(false);
                }
              }}
            />
          ) : null}
          <Button
            label={isLive ? 'Open console' : 'Review timeline'}
            icon="arrow-right"
            variant={event.status === 'active' ? 'secondary' : 'primary'}
            size="sm"
            style={{ flex: 1 }}
            onPress={onOpen}
          />
        </View>
      </View>
    </Card>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ gap: 2 }}>
      <Text variant="micro" tone="tertiary">
        {label}
      </Text>
      <Text variant="caption" weight="600" tabular>
        {value}
      </Text>
    </View>
  );
}
