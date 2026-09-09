import { useState } from 'react';
import { View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { ActionBar, Banner, Button, Field, Header, PasswordMeter, Screen, Section } from '@/components/ui';
import { changePasswordSchema, validate } from '@/lib/validation';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

export default function SecuritySettingsScreen() {
  const { spacing } = useTheme();
  const toast = useToast();

  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);

  const save = async () => {
    const result = validate(changePasswordSchema, { currentPassword, password, confirmPassword });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setSaving(true);
    try {
      await authApi.changePassword(result.data);
      toast.success('Password changed', 'Your other devices stay signed in on this change.');
      setCurrentPassword('');
      setPassword('');
      setConfirmPassword('');
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      toast.error('Could not change password', error.userMessage ?? 'Try again.');
    } finally {
      setSaving(false);
    }
  };

  const ready = currentPassword.length > 0 && password.length >= 10 && confirmPassword.length > 0;

  return (
    <>
      <Screen keyboardAvoiding extraBottomPadding={80}>
        <Header title="Password" onBack />

        <View style={{ gap: spacing.xl }}>
          <Field
            label="Current password"
            value={currentPassword}
            onChangeText={setCurrentPassword}
            error={errors.currentPassword}
            icon="lock"
            secure
            autoComplete="current-password"
            required
          />

          <View style={{ gap: spacing.sm }}>
            <Field
              label="New password"
              value={password}
              onChangeText={setPassword}
              error={errors.password}
              icon="key"
              secure
              autoComplete="new-password"
              required
            />
            <PasswordMeter password={password} />
          </View>

          <Field
            label="Confirm new password"
            value={confirmPassword}
            onChangeText={setConfirmPassword}
            error={errors.confirmPassword}
            icon="key"
            secure
            autoComplete="new-password"
            required
          />

          <Section title="If you lose this device">
            <Banner
              tone="warning"
              icon="alert-triangle"
              title="Tell your admin immediately"
              message="They can deactivate your account, which revokes every active session at once. That is faster and more complete than changing a password from another device."
            />
          </Section>

          <Banner
            tone="neutral"
            icon="shield"
            message="Your session token is stored in this device's secure keychain, and expires after 12 hours or 30 minutes of inactivity."
          />
        </View>
      </Screen>

      <ActionBar>
        <Button
          label="Change password"
          size="lg"
          fullWidth
          icon="check"
          disabled={!ready}
          loading={saving}
          onPress={save}
        />
      </ActionBar>
    </>
  );
}
