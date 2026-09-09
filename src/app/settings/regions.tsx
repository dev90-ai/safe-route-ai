import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { ActionBar, Banner, Button, Header, MultiSelect, Screen, Text } from '@/components/ui';
import { REGIONS } from '@/constants/regions';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Operating regions.
 *
 * These are one of the four conditions that decide whether an alert reaches
 * someone, so the screen explains the consequence rather than presenting it as
 * a preference.
 */
export default function RegionsSettingsScreen() {
  const { spacing } = useTheme();
  const toast = useToast();
  const { user, applyUser } = useAuth();

  const [selected, setSelected] = useState<string[]>(user!.profile.operatingRegions);
  const [saving, setSaving] = useState(false);

  const dirty = selected.join() !== user!.profile.operatingRegions.join();

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

  const save = async () => {
    setSaving(true);
    try {
      const updated = await authApi.updateProfile({ operatingRegions: selected });
      applyUser(updated);
      toast.success('Regions updated', `You will be alerted about ${selected.length} region(s).`);
    } catch (e) {
      const error = e as { userMessage?: string };
      toast.error('Could not save', error.userMessage ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Screen extraBottomPadding={80}>
        <Header
          title="Operating regions"
          subtitle="Where you travel to or work in"
          onBack
        />

        <View style={{ gap: spacing.xl }}>
          <Banner
            tone="info"
            icon="bell"
            title="This decides which alerts reach you"
            message="You are alerted about a verified threat if it is in one of these regions, if it is within its alert radius of your last known position, or if it was reported by your organisation or a partner. Regions are the one you control."
          />

          {selected.length === 0 ? (
            <Banner
              tone="warning"
              icon="alert-triangle"
              message="With no regions selected you will only be alerted when a threat happens close to where your phone last reported being."
            />
          ) : null}

          <MultiSelect
            options={options}
            selected={selected}
            onChange={setSelected}
            searchPlaceholder="Search regions"
            max={8}
            groupBy
          />

          <Text variant="caption" tone="tertiary">
            Pick the places you actually go, not only where you are today. Region granularity is sub-county, which is
            coarse enough that declaring one does not disclose where you sleep.
          </Text>
        </View>
      </Screen>

      {dirty ? (
        <ActionBar>
          <Button
            label={`Save ${selected.length} region${selected.length === 1 ? '' : 's'}`}
            size="lg"
            fullWidth
            icon="save"
            loading={saving}
            onPress={save}
          />
        </ActionBar>
      ) : null}
    </>
  );
}
