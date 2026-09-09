import { useRouter } from 'expo-router';
import { useState } from 'react';
import { View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import { Banner, Button, Field, Header, Screen, Text } from '@/components/ui';
import { forgotPasswordSchema, validate } from '@/lib/validation';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Step 1 of 3 in the password reset.
 *
 * The response is identical whether or not the address is registered - it has
 * to be, or this endpoint becomes a way to discover which humanitarian staff
 * use the system. So the confirmation copy says "if an account exists", and the
 * screen advances regardless.
 */
export default function ForgotPasswordScreen() {
  const { spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setFormError(null);
    const result = validate(forgotPasswordSchema, { email });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      const response = await authApi.requestPasswordCode(result.data);
      toast.info('Code sent', `If an account exists for ${response.sentTo}, a 6-digit code is on its way.`);
      router.push({
        pathname: '/(auth)/verify-code',
        params: {
          email: result.data.email,
          // Dev-only: the mock backend has no mail transport, so it hands back
          // the code for the on-screen development banner. A real deployment
          // returns null here and the banner never renders.
          devCode: response.devPreview ?? '',
          expiresIn: String(response.expiresInSeconds),
        },
      });
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      setFormError(error.userMessage ?? 'Could not send the code. Try again.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen keyboardAvoiding>
      <Header
        title="Reset your password"
        subtitle="We will email you a 6-digit code. It expires in 10 minutes."
        onBack
      />

      <View style={{ gap: spacing.xl }}>
        <OfflineBanner />
        {formError ? <Banner tone="danger" message={formError} /> : null}

        <Field
          label="Work email"
          placeholder="you@organisation.org"
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            if (errors.email) setErrors({});
          }}
          error={errors.email}
          icon="mail"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          autoFocus
          returnKeyType="send"
          onSubmitEditing={handleSubmit}
        />

        <Button label="Send code" size="lg" fullWidth loading={submitting} onPress={handleSubmit} icon="send" />

        <Banner
          tone="neutral"
          icon="shield"
          message="For your safety we do not confirm whether an address is registered. If you have an account, the code will arrive."
          compact
        />

        <Text variant="caption" tone="tertiary" align="center">
          Still stuck? Your organisation admin can reset access for you.
        </Text>
      </View>
    </Screen>
  );
}
