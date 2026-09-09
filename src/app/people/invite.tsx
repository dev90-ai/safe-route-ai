import Feather from '@expo/vector-icons/Feather';
import * as Clipboard from 'expo-clipboard';
import { useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { View } from 'react-native';

import { orgApi } from '@/api/endpoints/org';
import type { Invite, Role } from '@/api/types';
import { RoleBadge } from '@/components/domain/Badges';
import {
  ActionBar,
  Banner,
  Button,
  Card,
  Field,
  Header,
  MultiSelect,
  Screen,
  Section,
  Text,
} from '@/components/ui';
import { REGIONS, regionNames } from '@/constants/regions';
import { ROLE_META } from '@/constants/threats';
import { inviteSchema, validate } from '@/lib/validation';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Invite a new member.
 *
 * The role picker carries its full description rather than a bare label,
 * because choosing "officer" here is what grants someone the power to publish
 * alerts to the whole organisation. That should not be a one-word decision.
 */
export default function InviteScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const { user } = useAuth();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('worker');
  const [regionIds, setRegionIds] = useState<string[]>(user?.organization.regions.slice(0, 3) ?? []);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState(false);
  const [created, setCreated] = useState<Invite | null>(null);

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
    const result = validate(inviteSchema, { fullName, email, role, operatingRegions: regionIds });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const invite = await orgApi.createInvite(result.data);
      setCreated(invite);
      toast.success('Invite created', `Send the code ${invite.code} to ${invite.fullName}.`);
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not create the invite', error.userMessage ?? 'Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  // --- Success state --------------------------------------------------------
  if (created) {
    return (
      <Screen>
        <Header title="Invite created" subtitle={`For ${created.fullName}`} onBack={() => router.back()} />

        <View style={{ gap: spacing.xl }}>
          <Card style={{ borderColor: colors.success, backgroundColor: colors.successMuted }}>
            <View style={{ gap: spacing.lg, alignItems: 'center', paddingVertical: spacing.md }}>
              <Feather name="check-circle" size={28} color={colors.success} />
              <Text variant="footnote" tone="secondary" align="center">
                Give this code to {created.fullName}. They enter it on the sign-up screen to join{' '}
                {user!.organization.name} as a {ROLE_META[created.role].label.toLowerCase()}.
              </Text>
              <Text variant="display" tabular weight="800" color={colors.success} style={{ letterSpacing: 3 }}>
                {created.code}
              </Text>
              <Button
                label="Copy code"
                icon="copy"
                variant="secondary"
                onPress={async () => {
                  await Clipboard.setStringAsync(created.code);
                  toast.success('Copied');
                }}
              />
            </View>
          </Card>

          <Card>
            <View style={{ gap: spacing.md }}>
              <Row label="Name" value={created.fullName} />
              <Row label="Email" value={created.email} />
              <Row label="Role" value={ROLE_META[created.role].label} />
              <Row label="Regions" value={regionNames(created.operatingRegions)} />
              <Row label="Expires" value={new Date(created.expiresAt).toLocaleDateString()} />
            </View>
          </Card>

          <Banner
            tone="warning"
            icon="shield"
            title="Treat the code as a credential"
            message="Anyone holding it can create an account in your organisation with this role. Send it to the named person directly, not to a group channel."
          />

          <View style={{ gap: spacing.sm }}>
            <Button
              label="Invite someone else"
              icon="user-plus"
              variant="secondary"
              fullWidth
              onPress={() => {
                setCreated(null);
                setFullName('');
                setEmail('');
                setRole('worker');
              }}
            />
            <Button label="Done" fullWidth onPress={() => router.back()} />
          </View>
        </View>
      </Screen>
    );
  }

  // --- Form -----------------------------------------------------------------
  return (
    <>
      <Screen keyboardAvoiding extraBottomPadding={80}>
        <Header title="Invite someone" subtitle={`They will join ${user!.organization.name}`} onBack />

        <View style={{ gap: spacing.xl }}>
          <Field
            label="Full name"
            placeholder="Nasra Yusuf"
            value={fullName}
            onChangeText={setFullName}
            error={errors.fullName}
            icon="user"
            required
          />

          <Field
            label="Work email"
            placeholder="nasra@organisation.org"
            value={email}
            onChangeText={setEmail}
            error={errors.email}
            icon="mail"
            keyboardType="email-address"
            autoCapitalize="none"
            required
            hint="They must sign up with this exact address."
          />

          <Section title="Role" subtitle="This decides what they can do. It can be changed later.">
            <View style={{ gap: spacing.sm }}>
              {(['worker', 'officer', 'admin'] as Role[]).map((option) => {
                const selected = role === option;
                const tint = colors[ROLE_META[option].colorKey];
                return (
                  <Card
                    key={option}
                    onPress={() => setRole(option)}
                    accessibilityLabel={ROLE_META[option].label}
                    style={{
                      borderColor: selected ? tint : colors.border,
                      borderWidth: selected ? 1.5 : 1,
                      backgroundColor: selected ? `${tint}14` : colors.surface,
                    }}
                  >
                    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: spacing.md }}>
                      <View
                        style={{
                          width: 20,
                          height: 20,
                          borderRadius: 10,
                          borderWidth: selected ? 6 : 1.5,
                          borderColor: selected ? tint : colors.borderStrong,
                          marginTop: 2,
                        }}
                      />
                      <View style={{ flex: 1, gap: 3 }}>
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                          <Text variant="bodyStrong">{ROLE_META[option].label}</Text>
                          <RoleBadge role={option} />
                        </View>
                        <Text variant="caption" tone="tertiary">
                          {ROLE_META[option].description}
                        </Text>
                      </View>
                    </View>
                  </Card>
                );
              })}
            </View>

            {role === 'officer' ? (
              <Banner
                tone="warning"
                compact
                icon="shield"
                message="Officers can publish alerts to everyone in your organisation and partner organisations, and can see reporter identities. Invite carefully."
              />
            ) : role === 'admin' ? (
              <Banner
                tone="warning"
                compact
                icon="settings"
                message="Admins can manage people and partnerships. They cannot verify reports or issue alerts - that separation is deliberate."
              />
            ) : null}
          </Section>

          <Section title="Starting regions" subtitle="Workers can adjust these themselves during onboarding.">
            <MultiSelect
              options={options}
              selected={regionIds}
              onChange={setRegionIds}
              searchPlaceholder="Search regions"
              groupBy
            />
          </Section>
        </View>
      </Screen>

      <ActionBar>
        <Button
          label="Create invite"
          size="lg"
          fullWidth
          icon="user-plus"
          loading={submitting}
          disabled={!fullName.trim() || !email.trim()}
          onPress={handleSubmit}
        />
      </ActionBar>
    </>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', gap: 16 }}>
      <Text variant="footnote" tone="tertiary">
        {label}
      </Text>
      <Text variant="footnote" weight="500" style={{ flex: 1, textAlign: 'right' }}>
        {value}
      </Text>
    </View>
  );
}
