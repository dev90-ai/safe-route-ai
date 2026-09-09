import Feather from '@expo/vector-icons/Feather';
import { useEffect, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { alertsApi } from '@/api/endpoints/alerts';
import { reportsApi } from '@/api/endpoints/reports';
import type { ThreatReport } from '@/api/types';
import {
  Badge,
  Banner,
  Button,
  Card,
  Chip,
  Field,
  Segmented,
  Sheet,
  Stepper,
  Text,
  TextArea,
} from '@/components/ui';
import { SEVERITIES, SEVERITY_META, THREAT_META, THREAT_TYPES, type Severity, type ThreatType } from '@/constants/threats';
import { formatRadius } from '@/lib/geo';
import { timeAgo, pluralize } from '@/lib/format';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * The verification step - the moment a human takes responsibility.
 *
 * Three things this deliberately does:
 *
 *  1. **Pre-fills from the AI, and says so.** Every field starts at the model's
 *     suggestion with a visible marker, and the marker disappears the moment an
 *     officer changes it. The audit log records which fields were overridden.
 *  2. **Shows the blast radius before it fires.** The recipient preview is live:
 *     an officer widening a radius from 6 km to 20 km sees the count change from
 *     4 people to 31 before they commit.
 *  3. **Makes dismissal as easy as approval.** Rejecting a report is a normal,
 *     first-class outcome, not a hidden destructive action - if it is harder
 *     than approving, officers will approve things they should not.
 */
export function VerifySheet({
  visible,
  report,
  onClose,
  onDone,
}: {
  visible: boolean;
  report: ThreatReport;
  onClose: () => void;
  onDone: () => void | Promise<void>;
}) {
  const { colors, spacing } = useTheme();
  const toast = useToast();

  const ai = report.aiSuggestions;

  const [mode, setMode] = useState<'verify' | 'dismiss'>('verify');
  const [threatType, setThreatType] = useState<ThreatType>(ai?.threatType ?? report.reportedType ?? 'other');
  const [severity, setSeverity] = useState<Severity>(ai?.severity ?? 'medium');
  const [priority, setPriority] = useState<number>(ai?.priority ?? 5);
  // Radius is derived, not stored: it follows the category default for the
  // currently selected type and severity, starting from the AI's suggestion,
  // until the officer sets one by hand - at which point theirs wins.
  const [radiusOverride, setRadiusOverride] = useState<number | null>(null);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [note, setNote] = useState('');
  const [dismissReason, setDismissReason] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<{ total: number; sample: { name: string; distanceMeters: number | null }[] } | null>(null);

  // While the officer has not touched type or severity, the AI's own radius
  // stands. Once either changes, the category default for the new combination
  // takes over - which is what an officer expects when they escalate a report.
  const followsAi = !!ai && threatType === ai.threatType && severity === ai.severity;
  const radius =
    radiusOverride ??
    (followsAi ? ai!.alertRadiusMeters : THREAT_META[threatType].radiusBySeverity[severity]);
  const setRadius = setRadiusOverride;

  // Live recipient preview. Debounced because the radius stepper fires fast.
  useEffect(() => {
    if (!visible || mode !== 'verify') return;
    const timer = setTimeout(() => {
      void alertsApi
        .previewRecipients({
          organizationId: report.organizationId,
          location: report.location,
          radiusMeters: radius,
          regionIds: report.regionId ? [report.regionId] : [],
          shareWithPartners: true,
        })
        .then((result) => setPreview({ total: result.total, sample: result.sample }))
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [visible, mode, radius, report.organizationId, report.location, report.regionId]);

  const overrides = useMemo(() => {
    if (!ai) return [];
    const list: string[] = [];
    if (ai.threatType !== threatType) list.push('type');
    if (ai.severity !== severity) list.push('severity');
    if (ai.alertRadiusMeters !== radius) list.push('radius');
    if (ai.priority !== priority) list.push('priority');
    return list;
  }, [ai, threatType, severity, radius, priority]);

  const submitVerify = async () => {
    setSubmitting(true);
    setErrors({});
    try {
      await reportsApi.verify({
        reportId: report.id,
        threatType,
        severity,
        priority,
        alertRadiusMeters: Math.round(radius),
        confirmDuplicate,
        duplicateOf: confirmDuplicate ? report.possibleDuplicateOf ?? ai?.possibleDuplicateOf ?? null : null,
        note: note.trim() || undefined,
      });

      if (confirmDuplicate) {
        toast.success('Merged as duplicate', 'No alert was sent - the original already covered this.');
      } else {
        toast.success('Report verified', `Alert issued to ${pluralize(preview?.total ?? 0, 'recipient')}.`);
      }
      await onDone();
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not verify', error.userMessage ?? 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const submitDismiss = async () => {
    setSubmitting(true);
    setErrors({});
    try {
      await reportsApi.dismiss({ reportId: report.id, reason: dismissReason });
      toast.info('Report dismissed', 'No alert was sent. The reason is recorded in the audit log.');
      await onDone();
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not dismiss', error.userMessage ?? 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const duplicateId = report.possibleDuplicateOf ?? ai?.possibleDuplicateOf ?? null;

  return (
    <Sheet
      visible={visible}
      onClose={onClose}
      title={`Verify ${report.reference}`}
      subtitle={`Filed ${timeAgo(report.createdAt)}`}
      dismissable={!submitting}
      footer={
        mode === 'verify' ? (
          <Button
            label={confirmDuplicate ? 'Merge as duplicate' : `Verify and alert ${preview ? pluralize(preview.total, 'person', 'people') : '…'}`}
            variant={confirmDuplicate ? 'secondary' : 'success'}
            size="lg"
            fullWidth
            loading={submitting}
            icon="check-circle"
            onPress={submitVerify}
          />
        ) : (
          <Button
            label="Dismiss report"
            variant="danger"
            size="lg"
            fullWidth
            loading={submitting}
            icon="x-circle"
            disabled={dismissReason.trim().length < 10}
            onPress={submitDismiss}
          />
        )
      }
    >
      <View style={{ gap: spacing.xl }}>
        <Segmented
          options={[
            { value: 'verify', label: 'Verify' },
            { value: 'dismiss', label: 'Dismiss' },
          ]}
          value={mode}
          onChange={(v) => setMode(v)}
        />

        {/* The original text stays visible throughout - the officer should never
            have to remember what they are deciding about. */}
        <Card level={0} style={{ backgroundColor: colors.surfaceSunken }}>
          <Text variant="footnote" tone="secondary" numberOfLines={6}>
            {report.description}
          </Text>
        </Card>

        {mode === 'dismiss' ? (
          <View style={{ gap: spacing.lg }}>
            <Banner
              tone="neutral"
              icon="info"
              title="Dismissing is a normal outcome"
              message="Rumours, resolved situations and non-security events all belong here. No alert is sent, and the reason is kept permanently against the report."
            />

            <TextArea
              label="Why are you dismissing this?"
              placeholder="e.g. Confirmed with the county security team as a generator backfiring, not gunfire. Reporter informed."
              value={dismissReason}
              onChangeText={setDismissReason}
              error={errors.reason}
              maxLength={500}
              required
              hint="Recorded in the audit log against your name."
            />

            <View style={{ gap: spacing.sm }}>
              <Text variant="label" tone="tertiary">
                Common reasons
              </Text>
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                {[
                  'Unsubstantiated rumour, no corroboration found.',
                  'Confirmed as a non-security event.',
                  'Duplicate of an already verified report.',
                  'Situation resolved without incident.',
                ].map((reason) => (
                  <Chip key={reason} label={reason.slice(0, 28) + '…'} onPress={() => setDismissReason(reason)} />
                ))}
              </View>
            </View>
          </View>
        ) : (
          <View style={{ gap: spacing.xl }}>
            {/* Duplicate decision comes first - if it is a duplicate, nothing
                else on this form matters. */}
            {duplicateId ? (
              <Card accent={colors.warning}>
                <View style={{ gap: spacing.md }}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                    <Feather name="copy" size={15} color={colors.warning} />
                    <Text variant="bodyStrong" style={{ flex: 1 }}>
                      Possible duplicate
                    </Text>
                  </View>
                  <Text variant="footnote" tone="secondary">
                    {ai?.duplicateRationale ?? 'A nearby report may describe the same event.'}
                  </Text>
                  <Pressable
                    onPress={() => setConfirmDuplicate((v) => !v)}
                    accessibilityRole="checkbox"
                    accessibilityState={{ checked: confirmDuplicate }}
                    style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}
                  >
                    <View
                      style={{
                        width: 22,
                        height: 22,
                        borderRadius: 6,
                        borderWidth: confirmDuplicate ? 0 : 1.5,
                        borderColor: colors.borderStrong,
                        backgroundColor: confirmDuplicate ? colors.warning : 'transparent',
                        alignItems: 'center',
                        justifyContent: 'center',
                      }}
                    >
                      {confirmDuplicate ? <Feather name="check" size={14} color={colors.white} /> : null}
                    </View>
                    <Text variant="footnote" style={{ flex: 1 }}>
                      Yes, this is the same event. Merge it and do not send a second alert.
                    </Text>
                  </Pressable>
                </View>
              </Card>
            ) : null}

            {!confirmDuplicate ? (
              <>
                {/* Threat type */}
                <View style={{ gap: spacing.sm }}>
                  <FieldHeading
                    label="Threat type"
                    suggested={ai ? THREAT_META[ai.threatType].label : null}
                    overridden={!!ai && ai.threatType !== threatType}
                  />
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
                    {THREAT_TYPES.map((type) => (
                      <Chip
                        key={type}
                        label={THREAT_META[type].short}
                        selected={threatType === type}
                        onPress={() => setThreatType(type)}
                      />
                    ))}
                  </View>
                </View>

                {/* Severity */}
                <View style={{ gap: spacing.sm }}>
                  <FieldHeading
                    label="Severity"
                    suggested={ai ? SEVERITY_META[ai.severity].label : null}
                    overridden={!!ai && ai.severity !== severity}
                  />
                  <View style={{ flexDirection: 'row', gap: 8 }}>
                    {SEVERITIES.map((option) => (
                      <Chip
                        key={option}
                        label={SEVERITY_META[option].label}
                        color={colors[SEVERITY_META[option].colorKey]}
                        selected={severity === option}
                        onPress={() => setSeverity(option)}
                      />
                    ))}
                  </View>
                  <Text variant="caption" tone="secondary">
                    {SEVERITY_META[severity].guidance}
                  </Text>
                </View>

                {/* Alert radius */}
                <View style={{ gap: spacing.sm }}>
                  <FieldHeading
                    label="Alert radius"
                    suggested={ai ? formatRadius(ai.alertRadiusMeters) : null}
                    overridden={!!ai && ai.alertRadiusMeters !== radius}
                  />
                  <Stepper
                    value={radius}
                    onChange={(v) => {
                      setRadius(v);
                    }}
                    min={500}
                    max={60_000}
                    step={500}
                    format={formatRadius}
                    presets={[
                      { label: '2 km', value: 2000 },
                      { label: '5 km', value: 5000 },
                      { label: '10 km', value: 10_000 },
                      { label: '20 km', value: 20_000 },
                    ]}
                    hint="Everyone whose last known position falls inside this circle is alerted, on top of region and organisation matches."
                  />
                </View>

                {/* Priority */}
                <View style={{ gap: spacing.sm }}>
                  <FieldHeading
                    label="Priority"
                    suggested={ai ? `${ai.priority}/10` : null}
                    overridden={!!ai && ai.priority !== priority}
                  />
                  <Stepper
                    value={priority}
                    onChange={setPriority}
                    min={1}
                    max={10}
                    step={1}
                    format={(v) => `${v} / 10`}
                    hint="Orders the queue for other officers. Does not affect who is alerted."
                  />
                </View>

                {/* Who this will reach */}
                <Card level={0} style={{ backgroundColor: colors.accentMuted }}>
                  <View style={{ gap: spacing.sm }}>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <Feather name="users" size={15} color={colors.accentText} />
                      <Text variant="bodyStrong" style={{ flex: 1 }}>
                        {preview ? pluralize(preview.total, 'person', 'people') : 'Calculating…'} will be alerted
                      </Text>
                    </View>
                    {preview?.sample.length ? (
                      <Text variant="caption" tone="secondary">
                        Including {preview.sample.slice(0, 3).map((p) => p.name.split(' ')[0]).join(', ')}
                        {preview.total > 3 ? ` and ${preview.total - 3} more` : ''}.
                      </Text>
                    ) : null}
                    <Text variant="caption" tone="tertiary">
                      Same organisation, cross-share partners, anyone inside the radius, and anyone whose declared
                      regions cover this location.
                    </Text>
                  </View>
                </Card>

                <Field
                  label="Note (optional)"
                  placeholder="Anything the audit log should record about this decision"
                  value={note}
                  onChangeText={setNote}
                  maxLength={500}
                  icon="message-square"
                />

                {overrides.length ? (
                  <Banner
                    tone="info"
                    compact
                    icon="edit-3"
                    message={`You are overriding the AI on ${overrides.join(', ')}. Both values are kept, so the difference is auditable.`}
                  />
                ) : ai ? (
                  <Banner tone="neutral" compact icon="check" message="You are accepting the AI's suggestion unchanged." />
                ) : null}
              </>
            ) : null}
          </View>
        )}
      </View>
    </Sheet>
  );
}

function FieldHeading({
  label,
  suggested,
  overridden,
}: {
  label: string;
  suggested: string | null;
  overridden: boolean;
}) {
  const { colors, spacing } = useTheme();
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flexWrap: 'wrap' }}>
      <Text variant="footnote" weight="600" tone="secondary">
        {label}
      </Text>
      {suggested ? (
        overridden ? (
          <Badge label={`AI said ${suggested}`} size="sm" icon="edit-3" color={colors.warning} background={colors.warningMuted} />
        ) : (
          <Badge label="AI suggestion" size="sm" icon="cpu" color={colors.accentText} background={colors.accentMuted} />
        )
      ) : null}
    </View>
  );
}
