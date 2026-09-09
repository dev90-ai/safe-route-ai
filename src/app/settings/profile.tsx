import { useState } from 'react';
import { View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { ActionBar, Avatar, Banner, Button, Card, Field, Header, Screen, Section, Text } from '@/components/ui';
import { RoleBadge } from '@/components/domain/Badges';
import { normalizePhone } from '@/lib/format';
import { profileUpdateSchema, validate } from '@/lib/validation';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

export default function ProfileSettingsScreen() {
  const { spacing } = useTheme();
  const toast = useToast();
  const { user, applyUser } = useAuth();
  const profile = user!.profile;

  const [fullName, setFullName] = useState(profile.fullName);
  const [phone, setPhone] = useState(profile.phone ?? '');
  const [jobTitle, setJobTitle] = useState(profile.jobTitle ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const dirty = fullName !== profile.fullName || phone !== (profile.phone ?? '') || jobTitle !== (profile.jobTitle ?? '');

  const save = async () => {
    const result = validate(profileUpdateSchema, {
      fullName,
      phone: phone || undefined,
      jobTitle: jobTitle.trim() || null,
    });

    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      const updated = await authApi.updateProfile(result.data);
      applyUser(updated);
      toast.success('Profile updated');
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not save', error.userMessage ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Screen keyboardAvoiding extraBottomPadding={80}>
        <Header title="Profile" onBack />

        <View style={{ gap: spacing.xl }}>
          <Card>
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.lg }}>
              <Avatar name={fullName || profile.fullName} color={profile.avatarColor} size={56} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text variant="bodyStrong">{user!.organization.name}</Text>
                <RoleBadge role={profile.role} size="md" />
              </View>
            </View>
          </Card>

          <Field
            label="Full name"
            value={fullName}
            onChangeText={setFullName}
            error={errors.fullName}
            icon="user"
            maxLength={80}
            required
          />

          <Field
            label="Mobile number"
            value={phone}
            onChangeText={setPhone}
            onBlur={() => setPhone((v) => (v ? normalizePhone(v) : v))}
            error={errors.phone}
            icon="phone"
            keyboardType="phone-pad"
            hint="Your security officer uses this for urgent contact."
          />

          <Field
            label="Role title"
            placeholder="e.g. Field Coordinator, WASH"
            value={jobTitle}
            onChangeText={setJobTitle}
            error={errors.jobTitle}
            icon="briefcase"
            maxLength={80}
          />

          <Section title="Fixed by your organisation">
            <Card>
              <View style={{ gap: spacing.md }}>
                <Row label="Email" value={profile.email} />
                <Row label="Role" value={profile.role} />
                <Row label="Organisation" value={user!.organization.name} />
              </View>
            </Card>
            <Banner
              tone="neutral"
              icon="lock"
              compact
              message="Your email, role and organisation are set by your admin. Ask them if any of these are wrong."
            />
          </Section>
        </View>
      </Screen>

      {dirty ? (
        <ActionBar>
          <Button label="Save changes" size="lg" fullWidth icon="save" loading={saving} onPress={save} />
        </ActionBar>
      ) : null}
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
