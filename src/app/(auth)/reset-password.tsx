import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import { Banner, Button, Field, Header, PasswordMeter, Screen, Text } from '@/components/ui';
import { maskEmail } from '@/lib/format';
import { resetPasswordSchema, validate } from '@/lib/validation';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Step 3 of 3: set the new password.
 *
 * Completing this revokes every existing session for the account. That is the
 * behaviour you want when a device has been lost or taken - resetting the
 * password should evict whoever else is holding it.
 */
export default function ResetPasswordScreen() {
  const { spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ email: string; resetToken: string }>();

  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setFormError(null);
    const result = validate(resetPasswordSchema, {
      email: params.email,
      resetToken: params.resetToken,
      password,
      confirmPassword,
    });

    if (!result.ok) {
      setErrors(result.errors);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      await authApi.resetPassword(result.data);
      toast.success('Password updated', 'All other sessions were signed out. Sign in with your new password.');
      router.replace('/(auth)/sign-in');
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      setFormError(error.fieldErrors ? null : error.userMessage ?? 'Could not update the password.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen keyboardAvoiding>
      <Header title="Set a new password" subtitle={`For ${maskEmail(params.email ?? '')}`} />

      <View style={{ gap: spacing.xl }}>
        <OfflineBanner />
        {formError ? <Banner tone="danger" message={formError} /> : null}

        <View style={{ gap: spacing.sm }}>
          <Field
            label="New password"
            placeholder="At least 10 characters"
            value={password}
            onChangeText={setPassword}
            error={errors.password}
            icon="lock"
            secure
            autoComplete="new-password"
            textContentType="newPassword"
            autoFocus
            required
          />
          <PasswordMeter password={password} />
        </View>

        <Field
          label="Confirm new password"
          placeholder="Re-enter the password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          error={errors.confirmPassword}
          icon="lock"
          secure
          autoComplete="new-password"
          required
          returnKeyType="go"
          onSubmitEditing={handleSubmit}
        />

        <Banner
          tone="info"
          icon="log-out"
          title="This signs out your other devices"
          message="Every active session for this account is revoked when the password changes."
        />

        <Button
          label="Update password"
          size="lg"
          fullWidth
          loading={submitting}
          onPress={handleSubmit}
          icon="check-circle"
        />

        <Text variant="caption" tone="tertiary" align="center">
          Choose something you have not used on this account before.
        </Text>
      </View>
    </Screen>
  );
}
