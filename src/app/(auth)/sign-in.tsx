import Feather from '@expo/vector-icons/Feather';
import { Link, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { Banner, Button, Field, Screen, Text } from '@/components/ui';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import { validate, signInSchema } from '@/lib/validation';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';
import { rateLimiter } from '@/api/rateLimit';

export default function SignInScreen() {
  const { colors, spacing } = useTheme();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const { signIn } = useAuth();
  const toast = useToast();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async () => {
    setFormError(null);
    const result = validate(signInSchema, { email, password });
    if (!result.ok) {
      setErrors(result.errors);
      return;
    }
    setErrors({});
    setSubmitting(true);

    try {
      const user = await signIn(result.data.email, result.data.password);
      toast.success(`Welcome back, ${user.profile.fullName.split(' ')[0]}`);
      router.replace('/');
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string>; kind?: string };
      setErrors(error.fieldErrors ?? {});
      setFormError(error.userMessage ?? 'Could not sign in. Try again.');
      // Tell people how many attempts remain before the lockout, not after.
      const remaining = rateLimiter.inspect('auth.signIn', result.data.email).remaining;
      if (error.kind === 'unauthorized' && remaining <= 2 && remaining > 0) {
        toast.warning(`${remaining} attempt${remaining === 1 ? '' : 's'} left`, 'The account locks temporarily after too many failures.');
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen keyboardAvoiding contentStyle={{ paddingTop: insets.top + spacing.huge, gap: spacing.xxl }}>
      {/* Brand */}
      <View style={{ gap: spacing.lg }}>
        <View
          style={{
            width: 52,
            height: 52,
            borderRadius: 16,
            backgroundColor: colors.accentMuted,
            alignItems: 'center',
            justifyContent: 'center',
            borderWidth: 1,
            borderColor: colors.border,
          }}
        >
          <Feather name="shield" size={24} color={colors.accent} />
        </View>
        <View style={{ gap: 6 }}>
          <Text variant="title1">Safe Route AI</Text>
          <Text variant="body" tone="secondary" style={{ maxWidth: 340 }}>
            Verified security reporting and route advisory for humanitarian teams in North Eastern Kenya.
          </Text>
        </View>
      </View>

      <OfflineBanner />

      <View style={{ gap: spacing.lg }}>
        {formError ? <Banner tone="danger" message={formError} /> : null}

        <Field
          label="Work email"
          placeholder="you@organisation.org"
          value={email}
          onChangeText={(v) => {
            setEmail(v);
            if (errors.email) setErrors((e) => ({ ...e, email: '' }));
          }}
          error={errors.email}
          icon="mail"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          textContentType="emailAddress"
          returnKeyType="next"
        />

        <View style={{ gap: 6 }}>
          <Field
            label="Password"
            placeholder="Your password"
            value={password}
            onChangeText={(v) => {
              setPassword(v);
              if (errors.password) setErrors((e) => ({ ...e, password: '' }));
            }}
            error={errors.password}
            icon="lock"
            secure
            autoComplete="current-password"
            textContentType="password"
            returnKeyType="go"
            onSubmitEditing={handleSubmit}
          />
          <Link href="/(auth)/forgot-password" asChild>
            <Pressable hitSlop={8} style={{ alignSelf: 'flex-end' }} accessibilityRole="link">
              <Text variant="footnote" tone="accent" weight="600">
                Forgot password?
              </Text>
            </Pressable>
          </Link>
        </View>

        <Button label="Sign in" size="lg" fullWidth loading={submitting} onPress={handleSubmit} icon="log-in" />
      </View>

      {/* Invite-only note - workers do not self-register into an organisation */}
      <View style={{ gap: spacing.md }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.md }}>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.divider }} />
          <Text variant="caption" tone="tertiary">
            OR
          </Text>
          <View style={{ flex: 1, height: 1, backgroundColor: colors.divider }} />
        </View>

        <Button
          label="I have an invite code"
          variant="secondary"
          size="lg"
          fullWidth
          icon="user-plus"
          onPress={() => router.push('/(auth)/sign-up')}
        />
        <Text variant="caption" tone="tertiary" align="center">
          Accounts are created by your organisation admin. Ask them for an invite code if you do not have one.
        </Text>
      </View>
    </Screen>
  );
}
