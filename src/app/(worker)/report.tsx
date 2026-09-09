import Feather from '@expo/vector-icons/Feather';
import * as ImagePicker from 'expo-image-picker';
import { Image } from 'expo-image';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { reportsApi } from '@/api/endpoints/reports';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import { ThreatCard } from '@/components/domain/ThreatCard';
import { ThreatMap } from '@/components/domain/ThreatMap';
import {
  ActionBar,
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  Header,
  OptionSheet,
  Screen,
  Section,
  SelectRow,
  Segmented,
  Text,
  TextArea,
} from '@/components/ui';
import { THREAT_META, THREAT_TYPES, type ThreatType } from '@/constants/threats';
import { useLocation } from '@/hooks/use-location';
import { useQuery } from '@/hooks/use-query';
import { useNow } from '@/hooks/use-now';

import { uuid } from '@/lib/ids';
import { offlineQueue } from '@/lib/offlineQueue';
import { reportDraftSchema, validate } from '@/lib/validation';
import { useConnectivity } from '@/state/connectivity';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Threat reporting.
 *
 * Design decisions that come straight from the field constraints:
 *
 *  - **Nothing blocks on the network.** The id is minted on device, the draft
 *    goes into the outbox, and the screen confirms "saved" rather than "sent"
 *    when offline. A worker is never left wondering whether it went.
 *  - **GPS is best-effort, not required.** A fix can take minutes under tree
 *    cover; the manual pin is always available, and the source is recorded so
 *    an officer knows how the position was obtained.
 *  - **The threat type is optional.** Asking someone to categorise an incident
 *    they are still in the middle of is asking the wrong question. The AI
 *    classifies, and an officer confirms.
 */
export default function ReportScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { online, queue } = useConnectivity();
  const location = useLocation();

  const [tab, setTab] = useState<'new' | 'mine'>('new');
  const [description, setDescription] = useState('');
  const [reportedType, setReportedType] = useState<ThreatType | null>(null);
  const [photoUri, setPhotoUri] = useState<string | null>(null);
  const [manualPin, setManualPin] = useState<{ lat: number; lng: number } | null>(null);
  const [occurredOffset, setOccurredOffset] = useState<0 | 1 | 3 | 12>(0);
  const [typeSheet, setTypeSheet] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  const point = manualPin ?? location.point;
  const locationSource: 'gps' | 'manual-pin' = manualPin ? 'manual-pin' : 'gps';
  const queuedReports = queue.filter((item) => item.kind === 'report');

  const now = useNow(60_000);
  const occurredAt = useMemo(
    () => new Date(now - occurredOffset * 3_600_000).toISOString(),
    [now, occurredOffset],
  );

  const pickPhoto = async (mode: 'camera' | 'library') => {
    try {
      const permission =
        mode === 'camera'
          ? await ImagePicker.requestCameraPermissionsAsync()
          : await ImagePicker.requestMediaLibraryPermissionsAsync();

      if (!permission.granted) {
        toast.warning('Permission needed', 'Allow access to attach a photo, or continue without one.');
        return;
      }

      const result =
        mode === 'camera'
          ? await ImagePicker.launchCameraAsync({ quality: 0.6, allowsEditing: false })
          : await ImagePicker.launchImageLibraryAsync({
              quality: 0.6,
              mediaTypes: ['images'],
            });

      if (!result.canceled && result.assets[0]) setPhotoUri(result.assets[0].uri);
    } catch {
      toast.error('Could not open the camera', 'You can still submit the report without a photo.');
    }
  };

  const reset = () => {
    setDescription('');
    setReportedType(null);
    setPhotoUri(null);
    setManualPin(null);
    setOccurredOffset(0);
    setErrors({});
  };

  const handleSubmit = async () => {
    if (!point) {
      toast.error('No location yet', 'Wait for a GPS fix or drop a pin on the map below.');
      return;
    }

    const payload = {
      description,
      reportedType,
      location: point,
      locationAccuracyMeters: manualPin ? null : location.accuracyMeters,
      locationSource,
      photoUrl: photoUri,
      occurredAt,
    };

    const result = validate(reportDraftSchema, payload);
    if (!result.ok) {
      setErrors(result.errors);
      setConfirm(false);
      return;
    }

    setErrors({});
    setSubmitting(true);

    // The client owns the id, so an offline submission and its later retry are
    // the same report as far as the server is concerned.
    const clientId = uuid();

    try {
      if (!online) {
        await offlineQueue.enqueue({
          kind: 'report',
          id: clientId,
          payload: result.data,
          localPhotoUri: photoUri,
        });
        toast.warning('Saved on this device', 'No signal. Your report will send automatically when you reconnect.');
        setConfirm(false);
        reset();
        setTab('mine');
        return;
      }

      const created = await reportsApi.create(result.data, { clientId });
      toast.success('Report submitted', `Reference ${created.reference}. An officer will verify it shortly.`);
      setConfirm(false);
      reset();
      router.push({ pathname: '/report/[id]', params: { id: created.id } });
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string>; kind?: string };

      // A network failure mid-submit is not a failure - it is a queue.
      if (error.kind === 'network' || error.kind === 'timeout') {
        await offlineQueue.enqueue({
          kind: 'report',
          id: clientId,
          payload: result.data,
          localPhotoUri: photoUri,
        });
        toast.warning('Connection lost', 'Your report is saved and will send itself when signal returns.');
        setConfirm(false);
        reset();
        setTab('mine');
        return;
      }

      setErrors(error.fieldErrors ?? {});
      toast.error('Could not submit', error.userMessage ?? 'Try again.');
      setConfirm(false);
    } finally {
      setSubmitting(false);
    }
  };

  const charCount = description.trim().length;
  const canSubmit = charCount >= 20 && !!point;

  return (
    <>
      <Screen keyboardAvoiding extraBottomPadding={80}>
        <Header
          title="Report"
          subtitle="What you file here is verified by a security officer before anyone is alerted."
        />

        <View style={{ gap: spacing.xl }}>
          <Segmented
            options={[
              { value: 'new', label: 'New report' },
              { value: 'mine', label: 'My reports', badge: queuedReports.length },
            ]}
            value={tab}
            onChange={setTab}
          />

          <OfflineBanner />

          {tab === 'mine' ? (
            <MyReportsTab />
          ) : (
            <>
              {/* What happened */}
              <Section
                title="What happened"
                subtitle="Write it as you would say it on the radio. Specifics matter more than grammar."
              >
                <TextArea
                  placeholder="Describe what you saw or heard: what happened, roughly where, who was involved, whether anyone was hurt, and whether it is still going on."
                  value={description}
                  onChangeText={(v) => {
                    setDescription(v);
                    if (errors.description) setErrors((e) => ({ ...e, description: '' }));
                  }}
                  error={errors.description}
                  maxLength={2000}
                  hint={
                    charCount < 20
                      ? `${20 - charCount} more characters needed`
                      : 'Good. More detail helps the classifier and the verifying officer.'
                  }
                />
              </Section>

              {/* Optional classification */}
              <SelectRow
                label="Threat type (optional)"
                value={reportedType ? THREAT_META[reportedType].label : null}
                placeholder="Let the system classify it"
                onPress={() => setTypeSheet(true)}
                icon="tag"
                color={reportedType ? colors.text : undefined}
              />

              {/* When */}
              <View style={{ gap: spacing.sm }}>
                <Text variant="footnote" weight="600" tone="secondary">
                  When did it happen?
                </Text>
                <Segmented
                  options={[
                    { value: '0', label: 'Now' },
                    { value: '1', label: '1 h ago' },
                    { value: '3', label: '3 h ago' },
                    { value: '12', label: '12 h ago' },
                  ]}
                  value={String(occurredOffset)}
                  onChange={(v) => setOccurredOffset(Number(v) as 0 | 1 | 3 | 12)}
                />
              </View>

              {/* Location */}
              <Section
                title="Location"
                subtitle="Captured automatically. Tap the map to move the pin if it is wrong."
              >
                <View style={{ gap: spacing.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
                    {point ? (
                      <>
                        <Badge
                          label={manualPin ? 'Manual pin' : 'GPS'}
                          icon={manualPin ? 'map-pin' : 'crosshair'}
                          size="sm"
                          color={manualPin ? colors.warning : colors.success}
                          background={manualPin ? colors.warningMuted : colors.successMuted}
                        />
                        {!manualPin && location.accuracyMeters ? (
                          <Badge label={`±${Math.round(location.accuracyMeters)} m`} size="sm" />
                        ) : null}
                        <Text variant="caption" tone="tertiary" tabular>
                          {point.lat.toFixed(4)}, {point.lng.toFixed(4)}
                        </Text>
                      </>
                    ) : (
                      <Badge
                        label={location.status === 'locating' ? 'Getting a fix…' : 'No position'}
                        icon="loader"
                        size="sm"
                        color={colors.warning}
                        background={colors.warningMuted}
                      />
                    )}
                  </View>

                  {location.error ? <Banner tone="warning" compact message={location.error} /> : null}

                  <ThreatMap
                    height={220}
                    center={point}
                    zoomRadiusMeters={4000}
                    markers={point ? [{ id: 'pin', point, label: 'Incident', color: colors.danger, kind: 'pin' }] : []}
                    onMapPress={(next) => setManualPin(next)}
                    showsUserLocation
                  />

                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <Button
                      label={location.status === 'locating' ? 'Locating…' : 'Use my GPS'}
                      icon="crosshair"
                      variant="secondary"
                      size="sm"
                      loading={location.status === 'locating'}
                      onPress={() => {
                        setManualPin(null);
                        void location.refresh();
                      }}
                    />
                    {manualPin ? (
                      <Button label="Clear pin" icon="x" variant="ghost" size="sm" onPress={() => setManualPin(null)} />
                    ) : null}
                  </View>
                </View>
              </Section>

              {/* Photo */}
              <Section title="Photo (optional)" subtitle="Only if it is safe to take one. Never photograph armed actors.">
                {photoUri ? (
                  <View style={{ gap: spacing.sm }}>
                    <Image
                      source={{ uri: photoUri }}
                      style={{ width: '100%', height: 190, borderRadius: 14, backgroundColor: colors.surfaceSunken }}
                      contentFit="cover"
                      accessibilityLabel="Attached photo"
                    />
                    <Button label="Remove photo" icon="trash-2" variant="ghost" size="sm" onPress={() => setPhotoUri(null)} />
                  </View>
                ) : (
                  <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                    <Button label="Take photo" icon="camera" variant="secondary" onPress={() => void pickPhoto('camera')} />
                    <Button label="Choose file" icon="image" variant="secondary" onPress={() => void pickPhoto('library')} />
                  </View>
                )}
              </Section>

              <Banner
                tone="neutral"
                icon="eye-off"
                title="Your name is not shown to other workers"
                message="Only your organisation's security officers and admin can see who filed a report. Peers see the threat, never the reporter."
              />
            </>
          )}
        </View>
      </Screen>

      {tab === 'new' ? (
        <ActionBar>
          <Button
            label={online ? 'Submit report' : 'Save and send when online'}
            size="lg"
            fullWidth
            icon={online ? 'send' : 'save'}
            disabled={!canSubmit}
            onPress={() => setConfirm(true)}
          />
          {!canSubmit ? (
            <Text variant="caption" tone="tertiary" align="center">
              {charCount < 20 ? 'Add a description of at least 20 characters' : 'Waiting for a location'}
            </Text>
          ) : null}
        </ActionBar>
      ) : null}

      <OptionSheet
        visible={typeSheet}
        onClose={() => setTypeSheet(false)}
        title="Threat type"
        subtitle="Optional. The system classifies independently and an officer confirms."
        value={reportedType}
        onSelect={(v) => setReportedType(v)}
        options={THREAT_TYPES.map((type) => ({
          value: type,
          label: THREAT_META[type].label,
          description: THREAT_META[type].description,
        }))}
      />

      <ConfirmSheet
        visible={confirm}
        onClose={() => setConfirm(false)}
        onConfirm={handleSubmit}
        loading={submitting}
        tone="primary"
        title={online ? 'Submit this report?' : 'Save this report?'}
        confirmLabel={online ? 'Submit' : 'Save to outbox'}
        message={
          online
            ? 'It will be classified automatically and placed in your security officer’s verification queue. No alert is sent until a person confirms it.'
            : 'It will be stored on this device and sent automatically the moment you have signal. Nothing is lost if you close the app.'
        }
      >
        <View style={{ gap: spacing.sm }}>
          <Card level={0} style={{ backgroundColor: colors.surfaceSunken }}>
            <View style={{ gap: 6 }}>
              <Text variant="footnote" numberOfLines={4}>
                {description}
              </Text>
              <Text variant="caption" tone="tertiary">
                {point ? `${point.lat.toFixed(4)}, ${point.lng.toFixed(4)}` : 'No position'} ·{' '}
                {manualPin ? 'manual pin' : 'GPS'}
                {photoUri ? ' · photo attached' : ''}
              </Text>
            </View>
          </Card>
        </View>
      </ConfirmSheet>
    </>
  );
}

/** Personal report history, including anything still in the outbox. */
function MyReportsTab() {
  const { spacing } = useTheme();
  const router = useRouter();
  const { queue, retry, discard } = useConnectivity();

  const reports = useQuery({
    key: 'reports.mine.list',
    fetcher: () => reportsApi.mine(30),
    watch: ['reports'],
  });

  const queued = queue.filter((item) => item.kind === 'report');

  if (reports.isLoading && !reports.data) {
    return (
      <View style={{ gap: spacing.md }}>
        <Card>
          <Text variant="footnote" tone="tertiary">
            Loading your reports…
          </Text>
        </Card>
      </View>
    );
  }

  const isEmpty = !queued.length && !reports.data?.length;

  if (isEmpty) {
    return (
      <Card>
        <View style={{ alignItems: 'center', gap: spacing.md, paddingVertical: spacing.lg }}>
          <Feather name="file-text" size={26} color="#8494AF" />
          <Text variant="title3" align="center">
            No reports yet
          </Text>
          <Text variant="footnote" tone="secondary" align="center">
            Anything you file appears here, with its verification status, so you always know whether an officer has
            acted on it.
          </Text>
        </View>
      </Card>
    );
  }

  return (
    <View style={{ gap: spacing.md }}>
      {queued.map((item) => (
        <Card key={item.queueId} accent="#F59E0B">
          <View style={{ gap: spacing.sm }}>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
              <Badge
                label={item.status === 'failed' ? 'Did not send' : item.status === 'sending' ? 'Sending…' : 'Waiting for signal'}
                icon={item.status === 'failed' ? 'alert-triangle' : 'upload-cloud'}
                size="sm"
              />
              {item.attempts > 0 ? <Badge label={`${item.attempts} attempt${item.attempts === 1 ? '' : 's'}`} size="sm" /> : null}
            </View>
            <Text variant="footnote" numberOfLines={3}>
              {item.kind === 'report' ? item.payload.description : ''}
            </Text>
            {item.lastError ? (
              <Text variant="caption" tone="danger">
                {item.lastError}
              </Text>
            ) : null}
            {item.status === 'failed' ? (
              <View style={{ flexDirection: 'row', gap: spacing.sm }}>
                <Button label="Retry" icon="refresh-cw" size="sm" variant="secondary" onPress={() => void retry(item.queueId)} />
                <Button label="Discard" icon="trash-2" size="sm" variant="ghost" onPress={() => void discard(item.queueId)} />
              </View>
            ) : null}
          </View>
        </Card>
      ))}

      {reports.data?.map((report) => (
        <ThreatCard
          key={report.id}
          report={report}
          onPress={() => router.push({ pathname: '/report/[id]', params: { id: report.id } })}
        />
      ))}
    </View>
  );
}
