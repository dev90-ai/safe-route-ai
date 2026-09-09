import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useState } from 'react';
import { View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import { sosApi } from '@/api/endpoints/sos';

import { ThreatMap } from '@/components/domain/ThreatMap';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import {
  ActionBar,
  Banner,
  Button,
  ButtonRow,
  Card,
  ConfirmSheet,
  DetailRow,
  Field,
  Header,
  Screen,
  Section,
  SkeletonCard,
  Text,
  TextArea,
} from '@/components/ui';
import { useQuery } from '@/hooks/use-query';
import { useSosTracking } from '@/hooks/use-location';
import { elapsedClock, formatDateTime, formatDuration, timeAgo } from '@/lib/format';

import { offlineQueue } from '@/lib/offlineQueue';
import { useAuth } from '@/state/auth';
import { useConnectivity } from '@/state/connectivity';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Live SOS.
 *
 * Two views of the same event. The worker sees confirmation that help knows -
 * which is the thing that actually reduces panic - plus a way to stand down.
 * The officer sees the track, the timeline, and the controls to acknowledge,
 * annotate and resolve.
 *
 * While the event is live and this screen is open, the worker's device pushes a
 * position every 30 seconds. Each push is independent: a failed one is queued
 * and retried, and never invalidates the event.
 */
export default function SosDetailScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { user } = useAuth();
  const { online } = useConnectivity();

  const [now, setNow] = useState(() => Date.now());
  const [noteText, setNoteText] = useState('');
  const [resolveOpen, setResolveOpen] = useState(false);
  const [resolveNote, setResolveNote] = useState('');
  const [cancelOpen, setCancelOpen] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [busy, setBusy] = useState(false);

  const isOfficer = user!.profile.role === 'officer';

  const event = useQuery({
    key: id ? `sos.${id}` : null,
    fetcher: () => sosApi.get(id!),
    watch: ['sosEvents'],
    pollMs: 8000,
  });

  const directory = useQuery({ key: 'org.directory', fetcher: () => orgApi.directory() });

  const data = event.data;
  const isLive = data?.status === 'active' || data?.status === 'acknowledged';
  const isMine = data?.workerId === user!.profile.id;

  useEffect(() => {
    if (!isLive) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [isLive]);

  // Position broadcasting, worker side only.
  useSosTracking(
    !!isLive && !!isMine,
    (point, accuracy) => {
      if (!data) return;
      if (online) {
        void sosApi.pushLocation(data.id, point, accuracy).catch(() => {
          void offlineQueue.enqueue({
            kind: 'sos-location',
            id: `${data.id}_${Date.now()}`,
            sosId: data.id,
            payload: { location: point, accuracyMeters: accuracy },
          });
        });
      } else {
        void offlineQueue.enqueue({
          kind: 'sos-location',
          id: `${data.id}_${Date.now()}`,
          sosId: data.id,
          payload: { location: point, accuracyMeters: accuracy },
        });
      }
    },
    30_000,
  );

  const run = async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    try {
      await action();
      toast.success(success);
      await event.refetch();
    } catch (e) {
      const error = e as { userMessage?: string };
      toast.error('Could not complete that', error.userMessage ?? 'Try again.');
    } finally {
      setBusy(false);
    }
  };

  if (event.isLoading && !data) {
    return (
      <Screen>
        <Header title="SOS" onBack />
        <SkeletonCard lines={4} />
      </Screen>
    );
  }

  if (!data) {
    return (
      <Screen>
        <Header title="SOS" onBack />
        <Banner
          tone="warning"
          title="This SOS is not available yet"
          message={
            online
              ? 'It may belong to another organisation, or it has not synced yet.'
              : 'You are offline. If you just raised this SOS it is queued on this device and will send the moment you reconnect.'
          }
          action={{ label: 'Retry', onPress: () => void event.refetch() }}
        />
      </Screen>
    );
  }

  const workerName = directory.data?.[data.workerId]?.name ?? 'Unknown worker';
  const ackName = data.acknowledgedBy ? directory.data?.[data.acknowledgedBy]?.name : null;

  return (
    <>
      <Screen extraBottomPadding={isLive ? 40 : 0}>
        <Header
          title={isMine ? 'Your SOS' : workerName}
          subtitle={data.status === 'active' ? 'Waiting for an officer to acknowledge' : `Status: ${data.status}`}
          onBack
        />

        <View style={{ gap: spacing.xxl }}>
          <OfflineBanner />

          {/* Live status */}
          <Card
            style={{
              backgroundColor: isLive ? colors.dangerMuted : colors.surface,
              borderColor: isLive ? colors.danger : colors.border,
            }}
          >
            <View style={{ gap: spacing.md }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                <View
                  style={{
                    width: 44,
                    height: 44,
                    borderRadius: 22,
                    backgroundColor: isLive ? colors.danger : colors.surfaceSunken,
                    alignItems: 'center',
                    justifyContent: 'center',
                  }}
                >
                  <Feather
                    name={isLive ? 'radio' : data.status === 'resolved' ? 'check' : 'x'}
                    size={20}
                    color={isLive ? colors.white : colors.textTertiary}
                  />
                </View>
                <View style={{ flex: 1, gap: 3 }}>
                  <Text variant="title3" tone={isLive ? 'danger' : 'default'}>
                    {data.status === 'active'
                      ? 'SOS active'
                      : data.status === 'acknowledged'
                        ? 'Acknowledged - response in progress'
                        : data.status === 'resolved'
                          ? 'Resolved'
                          : 'Stood down'}
                  </Text>
                  <Text variant="footnote" tone="secondary" tabular>
                    {isLive
                      ? `Running for ${elapsedClock(Date.parse(data.createdAt), now)}`
                      : `Raised ${timeAgo(data.createdAt)}`}
                  </Text>
                </View>
              </View>

              {isMine && isLive ? (
                <Banner
                  tone={data.status === 'acknowledged' ? 'success' : 'warning'}
                  compact
                  icon={data.status === 'acknowledged' ? 'check-circle' : 'clock'}
                  message={
                    data.status === 'acknowledged'
                      ? `${ackName ?? 'A security officer'} has seen your SOS and is coordinating a response. Your location keeps updating.`
                      : 'Your SOS has been sent to every security officer in your organisation. Your location updates every 30 seconds.'
                  }
                />
              ) : null}

              {data.reason ? (
                <Text variant="body" tone="secondary">
                  &ldquo;{data.reason}&rdquo;
                </Text>
              ) : null}
            </View>
          </Card>

          {/* Map with track */}
          <Section title="Location">
            <ThreatMap
              height={260}
              center={data.location}
              zoomRadiusMeters={2000}
              markers={[
                { id: 'current', point: data.location, label: isMine ? 'You' : workerName.split(' ')[0], color: colors.danger, kind: 'sos' },
              ]}
              routes={
                data.track.length > 1
                  ? [{ id: 'track', path: data.track.map((t) => t.point), color: colors.danger, dashed: true }]
                  : []
              }
              showsUserLocation={false}
            />
            <Card>
              <View style={{ gap: 2 }}>
                <DetailRow
                  label="Current position"
                  value={`${data.location.lat.toFixed(5)}, ${data.location.lng.toFixed(5)}`}
                  icon="map-pin"
                />
                {data.accuracyMeters ? (
                  <DetailRow label="Accuracy" value={`±${Math.round(data.accuracyMeters)} m`} icon="crosshair" />
                ) : null}
                <DetailRow label="Position updates" value={String(data.track.length)} icon="activity" />
                {data.track.length > 1 ? (
                  <DetailRow
                    label="Last update"
                    value={timeAgo(data.track[data.track.length - 1].ts)}
                    icon="clock"
                  />
                ) : null}
              </View>
            </Card>
          </Section>

          {/* Officer controls */}
          {isOfficer ? (
            <Section title="Response">
              <Card>
                <View style={{ gap: spacing.md }}>
                  <DetailRow label="Worker" value={workerName} icon="user" />
                  {ackName ? <DetailRow label="Acknowledged by" value={ackName} icon="user-check" /> : null}
                  {data.acknowledgedAt ? (
                    <DetailRow
                      label="Time to acknowledge"
                      value={formatDuration(Date.parse(data.acknowledgedAt) - Date.parse(data.createdAt))}
                      icon="clock"
                    />
                  ) : null}

                  {isLive ? (
                    <>
                      <View style={{ height: 1, backgroundColor: colors.divider }} />
                      <Field
                        label="Add a note to the timeline"
                        placeholder="e.g. County security team dispatched, ETA 20 minutes"
                        value={noteText}
                        onChangeText={setNoteText}
                        icon="message-square"
                        maxLength={300}
                        hint="Visible to the worker. Tell them what is happening."
                      />
                      <Button
                        label="Add note"
                        icon="plus"
                        variant="secondary"
                        size="sm"
                        disabled={noteText.trim().length < 3}
                        onPress={() =>
                          run(async () => {
                            await sosApi.addNote(data.id, noteText);
                            setNoteText('');
                          }, 'Note added')
                        }
                      />
                    </>
                  ) : null}
                </View>
              </Card>
            </Section>
          ) : null}

          {/* Timeline */}
          <Section title="Timeline" subtitle="Retained in full for post-incident review.">
            <Card>
              <View style={{ gap: spacing.lg }}>
                {[...data.timeline].reverse().map((entry, index) => (
                  <View key={entry.id} style={{ flexDirection: 'row', gap: spacing.md }}>
                    <View style={{ alignItems: 'center', width: 20 }}>
                      <View
                        style={{
                          width: 8,
                          height: 8,
                          borderRadius: 4,
                          marginTop: 5,
                          backgroundColor:
                            entry.kind === 'triggered'
                              ? colors.danger
                              : entry.kind === 'resolved'
                                ? colors.success
                                : entry.kind === 'queued-offline'
                                  ? colors.warning
                                  : colors.accent,
                        }}
                      />
                      {index < data.timeline.length - 1 ? (
                        <View style={{ flex: 1, width: 1, backgroundColor: colors.divider, marginTop: 3 }} />
                      ) : null}
                    </View>
                    <View style={{ flex: 1, gap: 3, paddingBottom: spacing.sm }}>
                      <Text variant="footnote">{entry.text}</Text>
                      <Text variant="caption" tone="tertiary">
                        {formatDateTime(entry.ts)}
                      </Text>
                    </View>
                  </View>
                ))}
              </View>
            </Card>
          </Section>

          {data.resolutionNote ? (
            <Banner
              tone={data.status === 'resolved' ? 'success' : 'neutral'}
              icon={data.status === 'resolved' ? 'check-circle' : 'x-circle'}
              title={data.status === 'resolved' ? 'Resolution' : 'Stood down'}
              message={data.resolutionNote}
            />
          ) : null}
        </View>
      </Screen>

      {isLive ? (
        <ActionBar>
          {isOfficer ? (
            <ButtonRow>
              {data.status === 'active' ? (
                <View style={{ flex: 1 }}>
                  <Button
                    label="Acknowledge"
                    icon="check"
                    variant="danger"
                    size="lg"
                    fullWidth
                    loading={busy}
                    onPress={() => run(() => sosApi.acknowledge(data.id), 'Acknowledged')}
                  />
                </View>
              ) : null}
              <View style={{ flex: 1 }}>
                <Button
                  label="Mark resolved"
                  icon="check-circle"
                  variant={data.status === 'active' ? 'secondary' : 'success'}
                  size="lg"
                  fullWidth
                  onPress={() => setResolveOpen(true)}
                />
              </View>
            </ButtonRow>
          ) : isMine ? (
            <>
              <Button
                label="Stand down my SOS"
                icon="x-circle"
                variant="secondary"
                size="lg"
                fullWidth
                onPress={() => setCancelOpen(true)}
              />
              <Text variant="caption" tone="tertiary" align="center">
                Only do this if you are safe. Officers are notified either way.
              </Text>
            </>
          ) : null}
        </ActionBar>
      ) : null}

      <ConfirmSheet
        visible={resolveOpen}
        onClose={() => setResolveOpen(false)}
        onConfirm={() =>
          run(async () => {
            await sosApi.resolve({ sosId: data.id, note: resolveNote });
            setResolveOpen(false);
            setResolveNote('');
          }, 'SOS resolved')
        }
        loading={busy}
        tone="success"
        title="Mark this SOS resolved?"
        confirmLabel="Resolve"
        message="The worker is told it is closed and location broadcasting stops. The full timeline is retained."
      >
        <TextArea
          label="Resolution note"
          placeholder="e.g. Worker extracted by county security team. No injuries. Vehicle recovered."
          value={resolveNote}
          onChangeText={setResolveNote}
          maxLength={500}
          required
          hint="Required. This is the record of what happened."
        />
      </ConfirmSheet>

      <ConfirmSheet
        visible={cancelOpen}
        onClose={() => setCancelOpen(false)}
        onConfirm={() =>
          run(async () => {
            await sosApi.cancel(data.id, cancelReason);
            setCancelOpen(false);
            setCancelReason('');
            router.back();
          }, 'SOS stood down')
        }
        loading={busy}
        title="Stand down your SOS?"
        confirmLabel="Yes, I am safe"
        message="Your officers will see that you stood it down. Only do this if you are genuinely safe - if you are unsure, leave it running."
      >
        <Field
          label="What happened? (optional)"
          placeholder="e.g. False alarm, vehicle cleared the checkpoint"
          value={cancelReason}
          onChangeText={setCancelReason}
          icon="message-square"
          maxLength={200}
        />
      </ConfirmSheet>
    </>
  );
}
