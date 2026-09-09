import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import {
  ActionBar,
  Banner,
  Button,
  Card,
  Field,
  Header,
  MultiSelect,
  Screen,
  Text,
  Toggle,
} from '@/components/ui';
import { REGIONS } from '@/constants/regions';
import { useLocation } from '@/hooks/use-location';
import { onboardingSchema, validate } from '@/lib/validation';
import { useAuth } from '@/state/auth';
import { useNotifications } from '@/state/notifications';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Worker onboarding.
 *
 * Only one thing here is genuinely required: the operating regions. They are
 * the second of the four fan-out rules, so a worker who skips this can be
 * missed by an alert about a threat in the district they are standing in. The
 * screen says exactly that rather than treating it as a settings formality.
 */
export default function OnboardingScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { user, completeOnboarding, signOut } = useAuth();
  const notifications = useNotifications();
  const toast = useToast();
  const location = useLocation({ auto: false });

  const org = user?.organization;
  const [regionIds, setRegionIds] = useState<string[]>(user?.profile.operatingRegions ?? []);
  const [jobTitle, setJobTitle] = useState(user?.profile.jobTitle ?? '');
  const [shareLocation, setShareLocation] = useState(true);
  const [allowPush, setAllowPush] = useState(true);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);

  // The org's own regions float to the top - that is where this person works.
  const options = useMemo(() => {
    const orgRegions = new Set(org?.regions ?? []);
    return [...REGIONS]
      .sort((a, b) => {
        const aPriority = orgRegions.has(a.id) ? 0 : 1;
        const bPriority = orgRegions.has(b.id) ? 0 : 1;
        if (aPriority !== bPriority) return aPriority - bPriority;
        return a.name.localeCompare(b.name);
      })
      .map((region) => ({
        value: region.id,
        label: region.name,
        group: orgRegions.has(region.id) ? `${org?.acronym ?? 'Your org'} operating area` : region.county,
      }));
  }, [org]);

  const handleSubmit = async () => {
    const result = validate(onboardingSchema, {
      operatingRegions: regionIds,
      jobTitle: jobTitle.trim() || undefined,
      shareLocation,
    });

    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      if (allowPush && notifications.permission !== 'granted') {
        await notifications.requestPermission();
      }
      if (shareLocation) {
        // Requesting here rather than on first report keeps the permission
        // prompt away from the moment someone is trying to report an incident.
        await location.requestPermission();
        void location.refresh();
      }

      await completeOnboarding(result.data);
      toast.success('You are set up', 'You will now receive alerts for the areas you work in.');
      router.replace('/');
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not save', error.userMessage ?? 'Try again in a moment.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <Screen>
        <Header
          title={`Welcome, ${user?.profile.fullName.split(' ')[0] ?? 'there'}`}
          subtitle={`You joined ${org?.name ?? 'your organisation'}. Two quick things before you start.`}
        />

        <View style={{ gap: spacing.xxl }}>
          {/* Regions */}
          <View style={{ gap: spacing.md }}>
            <View style={{ gap: 4 }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Feather name="map" size={16} color={colors.accent} />
                <Text variant="title3">Where do you work?</Text>
              </View>
              <Text variant="footnote" tone="secondary">
                Select every area you travel to or operate in. You will be alerted about verified threats in these
                areas even when you are somewhere else - so pick the places you go, not just where you are today.
              </Text>
            </View>

            {errors.operatingRegions ? <Banner tone="danger" message={errors.operatingRegions} /> : null}

            <MultiSelect
              options={options}
              selected={regionIds}
              onChange={setRegionIds}
              searchPlaceholder="Search regions"
              max={8}
              groupBy
            />
          </View>

          {/* Role detail */}
          <Field
            label="Your role (optional)"
            placeholder="e.g. Field Coordinator, WASH"
            value={jobTitle}
            onChangeText={setJobTitle}
            icon="briefcase"
            maxLength={80}
            hint="Helps your security officer reach the right person quickly."
          />

          {/* Permissions - explained in terms of consequence, not capability */}
          <Card>
            <View style={{ gap: spacing.md }}>
              <Text variant="label" tone="tertiary">
                Permissions
              </Text>

              <Toggle
                icon="bell"
                label="Threat alerts"
                description="Verified threats near you or in your regions. Critical alerts bypass silent mode."
                value={allowPush}
                onChange={setAllowPush}
              />

              <Toggle
                icon="map-pin"
                label="Share my location"
                description="Used to alert you when a threat is inside its alert radius, and to broadcast your position during an SOS. Never shared with other workers."
                value={shareLocation}
                onChange={setShareLocation}
              />

              {!shareLocation ? (
                <Banner
                  tone="warning"
                  compact
                  message="Without location sharing you will only be alerted about your declared regions - not about threats that appear near wherever you actually are."
                />
              ) : null}
            </View>
          </Card>

          <Banner
            tone="neutral"
            icon="eye-off"
            title="Your identity is protected"
            message="Other workers never see who filed a report. Only your organisation's security officers and admin can see your name against your reports."
          />

          <Button label="Sign out instead" variant="ghost" onPress={() => void signOut()} />
        </View>
      </Screen>

      <ActionBar>
        <Button
          label={regionIds.length ? `Continue with ${regionIds.length} region${regionIds.length === 1 ? '' : 's'}` : 'Select at least one region'}
          size="lg"
          fullWidth
          disabled={!regionIds.length}
          loading={submitting}
          onPress={handleSubmit}
          icon="arrow-right"
        />
      </ActionBar>
    </View>
  );
}
