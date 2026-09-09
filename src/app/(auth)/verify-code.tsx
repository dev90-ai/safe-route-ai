import Feather from '@expo/vector-icons/Feather';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Pressable, View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import { Badge, Banner, Button, Card, CodeInput, Header, Screen, Text } from '@/components/ui';
import { maskEmail } from '@/lib/format';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Step 2 of 3: enter the 6-digit code.
 *
 * The code is single-use, expires in ten minutes, and allows five wrong
 * attempts before it is burned. All three limits are enforced server-side; this
 * screen just makes them legible - a countdown the user can see, a resend that
 * is disabled until it would actually work, and attempts remaining shown in the
 * error rather than left to guesswork.
 */
export default function VerifyCodeScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const toast = useToast();
  const params = useLocalSearchParams<{ email: string; devCode?: string; expiresIn?: string }>();

  const email = params.email ?? '';
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [devCode, setDevCode] = useState(params.devCode ?? '');
  const [secondsLeft, setSecondsLeft] = useState(Number(params.expiresIn ?? 600));
  const [resending, setResending] = useState(false);
  const autoSubmitted = useRef(false);

  useEffect(() => {
    if (secondsLeft <= 0) return;
    const id = setInterval(() => setSecondsLeft((s) => Math.max(0, s - 1)), 1000);
    return () => clearInterval(id);
  }, [secondsLeft]);

  const submit = useCallback(
    async (value: string) => {
      if (value.length !== 6 || submitting) return;
      setError(null);
      setSubmitting(true);

      try {
        const { resetToken } = await authApi.verifyCode({ email, code: value, purpose: 'password-reset' });
        router.replace({ pathname: '/(auth)/reset-password', params: { email, resetToken } });
      } catch (e) {
        const err = e as { userMessage?: string; fieldErrors?: Record<string, string> };
        setError(err.fieldErrors?.code ?? err.userMessage ?? 'That code is not correct.');
        setCode('');
        autoSubmitted.current = false;
      } finally {
        setSubmitting(false);
      }
    },
    [email, router, submitting],
  );

  const handleChange = (next: string) => {
    setCode(next);
    if (error) setError(null);
    if (next.length === 6 && !autoSubmitted.current) {
      autoSubmitted.current = true;
      void submit(next);
    }
  };

  const resend = async () => {
    setResending(true);
    setError(null);
    try {
      const response = await authApi.requestPasswordCode({ email });
      setDevCode(response.devPreview ?? '');
      setSecondsLeft(response.expiresInSeconds);
      setCode('');
      autoSubmitted.current = false;
      toast.info('New code sent', `Check ${maskEmail(email)}.`);
    } catch (e) {
      const err = e as { userMessage?: string };
      setError(err.userMessage ?? 'Could not resend the code.');
    } finally {
      setResending(false);
    }
  };

  const minutes = Math.floor(secondsLeft / 60);
  const seconds = secondsLeft % 60;
  const expired = secondsLeft <= 0;

  return (
    <Screen keyboardAvoiding>
      <Header title="Enter the code" subtitle={`We sent a 6-digit code to ${maskEmail(email)}.`} onBack />

      <View style={{ gap: spacing.xl }}>
        <OfflineBanner />

        {/* Development-only affordance. There is no mail transport in this build. */}
        {devCode ? (
          <Card level={0} style={{ backgroundColor: colors.warningMuted, borderColor: colors.warning }}>
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Feather name="terminal" size={14} color={colors.warning} />
                <Text variant="footnote" weight="700" tone="warning" style={{ flex: 1 }}>
                  Development preview
                </Text>
                <Badge label="Mock API" size="sm" color={colors.warning} background={colors.warningMuted} />
              </View>
              <Text variant="caption" tone="secondary">
                No email is actually sent in this build. The code that would have been delivered is:
              </Text>
              <Pressable
                onPress={() => handleChange(devCode)}
                accessibilityRole="button"
                accessibilityLabel={`Use code ${devCode.split('').join(' ')}`}
                style={{ alignSelf: 'flex-start' }}
              >
                <Text variant="title2" tabular weight="800" color={colors.warning} style={{ letterSpacing: 6 }}>
                  {devCode}
                </Text>
                <Text variant="micro" tone="tertiary">
                  Tap to fill
                </Text>
              </Pressable>
            </View>
          </Card>
        ) : null}

        <CodeInput value={code} onChange={handleChange} error={error ?? undefined} autoFocus={!devCode} />

        <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
            <Feather name="clock" size={12} color={expired ? colors.danger : colors.textTertiary} />
            <Text variant="caption" tone={expired ? 'danger' : 'tertiary'} tabular>
              {expired ? 'Code expired' : `Expires in ${minutes}:${String(seconds).padStart(2, '0')}`}
            </Text>
          </View>

          <Pressable
            onPress={resend}
            disabled={resending || (!expired && secondsLeft > 540)}
            hitSlop={8}
            accessibilityRole="button"
          >
            <Text
              variant="footnote"
              weight="600"
              tone={resending || (!expired && secondsLeft > 540) ? 'tertiary' : 'accent'}
            >
              {resending ? 'Sending…' : !expired && secondsLeft > 540 ? `Resend in ${secondsLeft - 540}s` : 'Resend code'}
            </Text>
          </Pressable>
        </View>

        <Button
          label="Verify code"
          size="lg"
          fullWidth
          loading={submitting}
          disabled={code.length !== 6 || expired}
          onPress={() => void submit(code)}
          icon="check"
        />

        {expired ? (
          <Banner tone="warning" message="That code is no longer valid. Request a new one to continue." icon="clock" />
        ) : null}

        <Text variant="caption" tone="tertiary" align="center">
          The code can be used once and allows five attempts. Do not share it with anyone, including your admin.
        </Text>
      </View>
    </Screen>
  );
}
