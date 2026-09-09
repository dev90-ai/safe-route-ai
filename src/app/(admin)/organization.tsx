import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import type { Organization } from '@/api/types';
import {
  Badge,
  Banner,
  Button,
  Card,
  ConfirmSheet,
  Field,
  Header,
  MultiSelect,
  Screen,
  Section,
  Sheet,
  SkeletonCard,
  Stepper,
  Text,
  Toggle,
} from '@/components/ui';
import { REGIONS, regionNames } from '@/constants/regions';
import { useQuery } from '@/hooks/use-query';
import { formatDate } from '@/lib/format';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Organisation profile, operating regions, and cross-share partnerships.
 *
 * Cross-share is the consequential control on this screen: enabling it means
 * another organisation's officers can see your verified threat reports, and
 * your workers start receiving theirs. The copy states that plainly, and the
 * partnership is reciprocal by construction - a one-way arrangement would let
 * an organisation consume intelligence without contributing any.
 */
export default function OrganizationScreen() {
  const { colors, spacing } = useTheme();
  const toast = useToast();
  const { refresh } = useAuth();

  const org = useQuery({
    key: 'org.get',
    fetcher: () => orgApi.get(),
    watch: ['organizations'],
  });

  const others = useQuery({
    key: 'org.others',
    fetcher: () => orgApi.listOrganizations(),
  });

  const [name, setName] = useState('');
  const [contactEmail, setContactEmail] = useState('');
  const [regionIds, setRegionIds] = useState<string[]>([]);
  const [partners, setPartners] = useState<string[]>([]);
  const [advisoryHours, setAdvisoryHours] = useState(24);
  const [dualControl, setDualControl] = useState(false);
  const [anonymise, setAnonymise] = useState(false);

  const [regionSheet, setRegionSheet] = useState(false);
  const [partnerTarget, setPartnerTarget] = useState<Organization | null>(null);
  const [saving, setSaving] = useState(false);

  // Seed the form from the loaded organisation.
  //
  // Adjusted during render rather than in an effect: React re-runs the render
  // immediately without committing the intermediate state, so the form never
  // paints empty and there is no cascading second render. `seededFor` makes it
  // fire once per record, leaving the admin's in-progress edits alone when a
  // background refetch returns.
  const [seededFor, setSeededFor] = useState<string | null>(null);
  if (org.data && seededFor !== org.data.id) {
    setSeededFor(org.data.id);
    setName(org.data.name);
    setContactEmail(org.data.contactEmail);
    setRegionIds(org.data.regions);
    setPartners(org.data.crossSharePartners);
    setAdvisoryHours(org.data.settings.defaultAdvisoryHours);
    setDualControl(org.data.settings.dualControlForCritical);
    setAnonymise(org.data.settings.anonymiseReportersToOfficers);
  }

  const dirty = useMemo(() => {
    if (!org.data) return false;
    return (
      name !== org.data.name ||
      contactEmail !== org.data.contactEmail ||
      regionIds.join() !== org.data.regions.join() ||
      advisoryHours !== org.data.settings.defaultAdvisoryHours ||
      dualControl !== org.data.settings.dualControlForCritical ||
      anonymise !== org.data.settings.anonymiseReportersToOfficers
    );
  }, [org.data, name, contactEmail, regionIds, advisoryHours, dualControl, anonymise]);

  const save = async () => {
    setSaving(true);
    try {
      await orgApi.update({
        name,
        contactEmail,
        regions: regionIds,
        settings: {
          defaultAdvisoryHours: advisoryHours,
          dualControlForCritical: dualControl,
          anonymiseReportersToOfficers: anonymise,
        },
      });
      toast.success('Organisation updated');
      await Promise.all([org.refetch(), refresh()]);
    } catch (e) {
      const error = e as { userMessage?: string };
      toast.error('Could not save', error.userMessage ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const togglePartner = async (partner: Organization, enable: boolean) => {
    const next = enable ? [...partners, partner.id] : partners.filter((p) => p !== partner.id);
    setPartners(next);
    try {
      await orgApi.update({ crossSharePartners: next });
      toast.success(
        enable ? `Now sharing with ${partner.acronym}` : `Stopped sharing with ${partner.acronym}`,
        enable
          ? 'Verified threats flow both ways from now on.'
          : 'Their threats will no longer reach your workers, and vice versa.',
      );
      await Promise.all([org.refetch(), others.refetch(), refresh()]);
    } catch (e) {
      setPartners(partners);
      const error = e as { userMessage?: string };
      toast.error('Could not update partnership', error.userMessage ?? 'Try again.');
    } finally {
      setPartnerTarget(null);
    }
  };

  if (org.isLoading && !org.data) {
    return (
      <Screen>
        <Header title="Organisation" />
        <SkeletonCard lines={4} />
      </Screen>
    );
  }

  return (
    <>
      <Screen refreshing={org.isRefreshing} onRefresh={() => void org.refetch()} extraBottomPadding={40}>
        <Header title="Organisation" subtitle={org.data?.acronym} />

        <View style={{ gap: spacing.xxl }}>
          {/* Profile */}
          <Section title="Profile">
            <View style={{ gap: spacing.lg }}>
              <Field label="Organisation name" value={name} onChangeText={setName} icon="briefcase" maxLength={120} />
              <Field
                label="Security contact email"
                value={contactEmail}
                onChangeText={setContactEmail}
                icon="mail"
                keyboardType="email-address"
                autoCapitalize="none"
                hint="Shown to partner organisations for escalation."
              />
              {org.data ? (
                <Text variant="caption" tone="tertiary">
                  Created {formatDate(org.data.createdAt)}
                </Text>
              ) : null}
            </View>
          </Section>

          {/* Regions */}
          <Section
            title="Operating regions"
            subtitle="Where your organisation works. Sets the default region list for new invites."
            action={{ label: 'Edit', onPress: () => setRegionSheet(true) }}
          >
            <Card>
              <View style={{ gap: spacing.sm }}>
                {regionIds.length ? (
                  <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 6 }}>
                    {regionIds.map((id) => (
                      <Badge key={id} label={REGIONS.find((r) => r.id === id)?.name ?? id} size="sm" />
                    ))}
                  </View>
                ) : (
                  <Text variant="footnote" tone="warning">
                    No regions set.
                  </Text>
                )}
              </View>
            </Card>
          </Section>

          {/* Cross-share */}
          <Section
            title="Cross-share partnerships"
            subtitle="Share verified threats with another organisation. Always reciprocal."
          >
            {others.isLoading && !others.data ? (
              <SkeletonCard lines={2} />
            ) : (
              <View style={{ gap: spacing.md }}>
                {(others.data ?? []).map((partner) => {
                  const enabled = partners.includes(partner.id);
                  return (
                    <Card key={partner.id} style={{ borderColor: enabled ? colors.accent : colors.border }}>
                      <View style={{ gap: spacing.md }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
                          <View
                            style={{
                              width: 38,
                              height: 38,
                              borderRadius: 10,
                              backgroundColor: enabled ? colors.accentMuted : colors.surfaceSunken,
                              alignItems: 'center',
                              justifyContent: 'center',
                            }}
                          >
                            <Text variant="caption" weight="800" tone={enabled ? 'accent' : 'tertiary'}>
                              {partner.acronym}
                            </Text>
                          </View>
                          <View style={{ flex: 1, gap: 2 }}>
                            <Text variant="bodyStrong">{partner.name}</Text>
                            <Text variant="caption" tone="tertiary" numberOfLines={1}>
                              {regionNames(partner.regions)}
                            </Text>
                          </View>
                          {enabled ? <Badge label="Sharing" size="sm" color={colors.success} background={colors.successMuted} dot /> : null}
                        </View>

                        <Button
                          label={enabled ? 'Stop sharing' : 'Start sharing'}
                          icon={enabled ? 'link-2' : 'link'}
                          variant={enabled ? 'ghost' : 'secondary'}
                          size="sm"
                          onPress={() => setPartnerTarget(partner)}
                        />
                      </View>
                    </Card>
                  );
                })}
              </View>
            )}

            <Banner
              tone="neutral"
              icon="info"
              title="What is and is not shared"
              message="Verified threat reports and advisories flow both ways. Live SOS locations never do - a worker's position stays inside their own organisation."
            />
          </Section>

          {/* Policy */}
          <Section title="Verification policy">
            <Card>
              <View style={{ gap: spacing.md }}>
                <Toggle
                  icon="users"
                  label="Require two officers for Critical"
                  description="A Critical verification must be countersigned by a second officer before the alert goes out."
                  value={dualControl}
                  onChange={setDualControl}
                />
                <View style={{ height: 1, backgroundColor: colors.divider }} />
                <Toggle
                  icon="eye-off"
                  label="Hide reporter identity from officers"
                  description="For extra-sensitive contexts. Officers verify blind; only the audit log retains who reported what."
                  value={anonymise}
                  onChange={setAnonymise}
                />
                {anonymise ? (
                  <Banner
                    tone="warning"
                    compact
                    message="This makes it harder for officers to follow up with a reporter for detail. Only enable it where retaliation risk outweighs that cost."
                  />
                ) : null}
              </View>
            </Card>
          </Section>

          <Section title="Advisory defaults">
            <Card>
              <Stepper
                label="Default advisory expiry"
                value={advisoryHours}
                onChange={setAdvisoryHours}
                min={1}
                max={168}
                step={1}
                format={(v) => (v >= 24 && v % 24 === 0 ? `${v / 24} day${v === 24 ? '' : 's'}` : `${v} hours`)}
                presets={[
                  { label: '12 h', value: 12 },
                  { label: '24 h', value: 24 },
                  { label: '3 days', value: 72 },
                ]}
                hint="Officers can override this per advisory."
              />
            </Card>
          </Section>

          {dirty ? (
            <Button label="Save changes" size="lg" fullWidth icon="save" loading={saving} onPress={save} />
          ) : null}

          <Banner
            tone="neutral"
            icon="lock"
            title="Separation of duties"
            message="As an admin you manage the organisation and its people. You cannot verify reports or issue alerts - those belong to security officers, so no single account can both create the authority and exercise it."
          />
        </View>
      </Screen>

      <Sheet
        visible={regionSheet}
        onClose={() => setRegionSheet(false)}
        title="Operating regions"
        subtitle="Where this organisation works"
        footer={<Button label="Done" fullWidth size="lg" onPress={() => setRegionSheet(false)} />}
      >
        <MultiSelect
          options={REGIONS.map((r) => ({ value: r.id, label: r.name, group: r.county }))}
          selected={regionIds}
          onChange={setRegionIds}
          searchPlaceholder="Search regions"
          groupBy
        />
      </Sheet>

      <ConfirmSheet
        visible={!!partnerTarget}
        onClose={() => setPartnerTarget(null)}
        onConfirm={() => {
          if (!partnerTarget) return;
          void togglePartner(partnerTarget, !partners.includes(partnerTarget.id));
        }}
        tone={partnerTarget && partners.includes(partnerTarget.id) ? 'danger' : 'primary'}
        title={
          partnerTarget && partners.includes(partnerTarget.id)
            ? `Stop sharing with ${partnerTarget.acronym}?`
            : `Share threats with ${partnerTarget?.acronym}?`
        }
        confirmLabel={partnerTarget && partners.includes(partnerTarget.id) ? 'Stop sharing' : 'Start sharing'}
        message={
          partnerTarget && partners.includes(partnerTarget.id)
            ? `Your workers will stop receiving ${partnerTarget.name}'s verified threats, and theirs will stop receiving yours. Existing alerts are unaffected.`
            : `${partnerTarget?.name}'s officers will see your verified threat reports, and your workers will start receiving their alerts. This applies in both directions immediately.`
        }
      />
    </>
  );
}
