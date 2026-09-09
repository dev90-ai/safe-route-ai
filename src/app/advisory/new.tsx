import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useEffect, useMemo, useState } from 'react';
import { View } from 'react-native';

import { alertsApi } from '@/api/endpoints/alerts';

import {
  ActionBar,
  Banner,
  Button,
  Card,
  Chip,
  Field,
  Header,
  MultiSelect,
  Screen,
  Section,
  Segmented,
  Stepper,
  Text,
  TextArea,
  Toggle,
} from '@/components/ui';
import { REGIONS, REGIONS_BY_ID } from '@/constants/regions';
import { SEVERITIES, SEVERITY_META, THREAT_META, THREAT_TYPES, type Severity, type ThreatType } from '@/constants/threats';
import { formatRadius } from '@/lib/geo';
import { pluralize } from '@/lib/format';
import { advisorySchema, validate } from '@/lib/validation';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Issue a standalone advisory.
 *
 * Distinct from a threat alert: it is not tied to a report, so it carries no
 * verification chain and no incident. It is standing guidance - "this corridor
 * is closed", "convoy only until further notice". Because it interrupts people,
 * the form makes the recipient count visible before the officer sends it.
 */
export default function NewAdvisoryScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();

  const [title, setTitle] = useState('');
  const [message, setMessage] = useState('');
  const [severity, setSeverity] = useState<Severity>('medium');
  const [threatType, setThreatType] = useState<ThreatType | null>(null);
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [useRadius, setUseRadius] = useState(false);
  const [radius, setRadius] = useState(20_000);
  const [expiresInHours, setExpiresInHours] = useState(user?.organization.settings.defaultAdvisoryHours ?? 24);
  const [shareWithPartners, setShareWithPartners] = useState(false);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [preview, setPreview] = useState<{ total: number; sample: { name: string }[] } | null>(null);

  // Centre a radius-based advisory on the mean of the selected regions - an
  // officer picking "Garissa and Dadaab" means the corridor between them.
  const center = useMemo(() => {
    if (!useRadius || !regionIds.length) return null;
    const regions = regionIds.map((id) => REGIONS_BY_ID[id]).filter(Boolean);
    if (!regions.length) return null;
    return {
      lat: regions.reduce((sum, r) => sum + r.center.lat, 0) / regions.length,
      lng: regions.reduce((sum, r) => sum + r.center.lng, 0) / regions.length,
    };
  }, [useRadius, regionIds]);

  useEffect(() => {
    // With no regions there is nothing to preview; `preview` is read through
    // `recipientPreview` below, which already treats that case as empty.
    if (!regionIds.length) return;

    const timer = setTimeout(() => {
      void alertsApi
        .previewRecipients({
          organizationId: user!.organization.id,
          location: center,
          radiusMeters: useRadius ? radius : null,
          regionIds,
          shareWithPartners,
        })
        .then((result) => setPreview({ total: result.total, sample: result.sample }))
        .catch(() => setPreview(null));
    }, 350);
    return () => clearTimeout(timer);
  }, [regionIds, center, radius, useRadius, shareWithPartners, user]);

  /** Derived so a cleared region list shows "no recipients" without a state write. */
  const recipientPreview = regionIds.length ? preview : null;

  const options = useMemo(() => {
    const orgRegions = new Set(user?.organization.regions ?? []);
    return [...REGIONS]
      .sort((a, b) => {
        const aP = orgRegions.has(a.id) ? 0 : 1;
        const bP = orgRegions.has(b.id) ? 0 : 1;
        return aP !== bP ? aP - bP : a.name.localeCompare(b.name);
      })
      .map((region) => ({
        value: region.id,
        label: region.name,
        group: orgRegions.has(region.id) ? `${user?.organization.acronym} operating area` : region.county,
      }));
  }, [user]);

  const handleSubmit = async () => {
    const payload = {
      title,
      message,
      severity,
      threatType,
      regionIds,
      location: center,
      radiusMeters: useRadius ? radius : null,
      expiresInHours,
      shareWithPartners,
    };

    const result = validate(advisorySchema, payload);
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const alert = await alertsApi.createAdvisory(result.data);
      toast.success('Advisory issued', `Delivered to ${pluralize(alert.recipientCount, 'person', 'people')}.`);
      router.replace({ pathname: '/alert/[id]', params: { id: alert.id } });
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not issue', error.userMessage ?? 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  const ready = title.trim().length >= 6 && message.trim().length >= 20 && regionIds.length > 0;

  return (
    <>
      <Screen keyboardAvoiding extraBottomPadding={80}>
        <Header
          title="Issue an advisory"
          subtitle="Standing guidance not tied to a single incident."
          onBack
        />

        <View style={{ gap: spacing.xxl }}>
          <Field
            label="Title"
            placeholder="e.g. Movement curfew: Garissa - Dadaab corridor"
            value={title}
            onChangeText={setTitle}
            error={errors.title}
            icon="type"
            maxLength={90}
            required
          />

          <TextArea
            label="What people should actually do"
            placeholder="Be specific and actionable. State the restriction, who it applies to, what the exception process is, and who to contact."
            value={message}
            onChangeText={setMessage}
            error={errors.message}
            maxLength={1200}
            required
          />

          <View style={{ gap: spacing.sm }}>
            <Text variant="footnote" weight="600" tone="secondary">
              Severity
            </Text>
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
            {severity === 'critical' ? (
              <Banner
                tone="warning"
                compact
                icon="bell"
                message="Critical advisories bypass quiet hours and silent mode on every recipient's device. Use it when the alternative is someone driving into danger."
              />
            ) : null}
          </View>

          <View style={{ gap: spacing.sm }}>
            <Text variant="footnote" weight="600" tone="secondary">
              Related threat type (optional)
            </Text>
            <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
              {THREAT_TYPES.map((type) => (
                <Chip
                  key={type}
                  label={THREAT_META[type].short}
                  selected={threatType === type}
                  onPress={() => setThreatType(threatType === type ? null : type)}
                />
              ))}
            </View>
          </View>

          <Section title="Who receives this" subtitle="Regions are required. A radius narrows it further.">
            {errors.regionIds ? <Banner tone="danger" message={errors.regionIds} compact /> : null}

            <MultiSelect
              options={options}
              selected={regionIds}
              onChange={setRegionIds}
              searchPlaceholder="Search regions"
              groupBy
            />

            <Toggle
              icon="radio"
              label="Also limit by distance"
              description="Only alert people whose last known position is inside a radius of the selected regions."
              value={useRadius}
              onChange={setUseRadius}
            />

            {useRadius ? (
              <Stepper
                value={radius}
                onChange={setRadius}
                min={1000}
                max={80_000}
                step={1000}
                format={formatRadius}
                presets={[
                  { label: '10 km', value: 10_000 },
                  { label: '25 km', value: 25_000 },
                  { label: '50 km', value: 50_000 },
                ]}
              />
            ) : null}

            <Toggle
              icon="link"
              label="Share with partner organisations"
              description="Cross-share partners receive this too. Leave off for internal instructions."
              value={shareWithPartners}
              onChange={setShareWithPartners}
            />

            <Card level={0} style={{ backgroundColor: colors.accentMuted }}>
              <View style={{ gap: spacing.sm }}>
                <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                  <Feather name="users" size={15} color={colors.accentText} />
                  <Text variant="bodyStrong" style={{ flex: 1 }}>
                    {regionIds.length === 0
                      ? 'Select a region to preview recipients'
                      : recipientPreview
                        ? `${pluralize(recipientPreview.total, 'person', 'people')} will be notified`
                        : 'Calculating…'}
                  </Text>
                </View>
                {recipientPreview?.sample.length ? (
                  <Text variant="caption" tone="secondary">
                    Including {recipientPreview.sample.slice(0, 3).map((p) => p.name.split(' ')[0]).join(', ')}
                    {recipientPreview.total > 3 ? ` and ${recipientPreview.total - 3} more` : ''}.
                  </Text>
                ) : null}
              </View>
            </Card>
          </Section>

          <View style={{ gap: spacing.sm }}>
            <Text variant="footnote" weight="600" tone="secondary">
              Expires after
            </Text>
            <Segmented
              options={[
                { value: '6', label: '6 h' },
                { value: '24', label: '24 h' },
                { value: '72', label: '3 days' },
                { value: '168', label: '7 days' },
              ]}
              value={String(expiresInHours)}
              onChange={(v) => setExpiresInHours(Number(v))}
            />
            <Text variant="caption" tone="tertiary">
              An advisory that outlives its situation trains people to ignore advisories. Set the shortest honest
              window - you can always reissue.
            </Text>
          </View>

          <Banner
            tone="neutral"
            icon="info"
            title="This is not a verified threat"
            message="Advisories carry no report and no verification chain. Use a verified report when you are describing a specific incident."
          />
        </View>
      </Screen>

      <ActionBar>
        <Button
          label={recipientPreview ? `Issue to ${pluralize(recipientPreview.total, 'person', 'people')}` : 'Issue advisory'}
          size="lg"
          fullWidth
          icon="send"
          disabled={!ready}
          loading={submitting}
          onPress={handleSubmit}
        />
        {!ready ? (
          <Text variant="caption" tone="tertiary" align="center">
            Add a title, a message, and at least one region.
          </Text>
        ) : null}
      </ActionBar>
    </>
  );
}
