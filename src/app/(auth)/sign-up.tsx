import Feather from '@expo/vector-icons/Feather';
import { useRouter } from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, View } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { RoleBadge } from '@/components/domain/Badges';
import { OfflineBanner } from '@/components/domain/StatusBanners';
import {
  Banner,
  Button,
  Card,
  Field,
  Header,
  PasswordMeter,
  Screen,
  Text,
} from '@/components/ui';
import { ROLE_META } from '@/constants/threats';
import { normalizePhone } from '@/lib/format';
import { signUpSchema, validate } from '@/lib/validation';
import { useAuth } from '@/state/auth';
import { useToast } from '@/state/toast';
import { useTheme } from '@/theme';

/**
 * Sign-up is invite-gated on purpose.
 *
 * An organisation's threat feed is only as trustworthy as the people inside it,
 * so the invite code - not a self-declared employer - is what binds an account
 * to an organisation and a role. The code is validated as it is typed, and the
 * screen shows exactly who it was issued to before anyone fills in a password.
 */
export default function SignUpScreen() {
  const { colors, spacing } = useTheme();
  const router = useRouter();
  const { signUp } = useAuth();
  const toast = useToast();

  const [inviteCode, setInviteCode] = useState('');
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [acceptedTerms, setAcceptedTerms] = useState(false);

  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const [invite, setInvite] = useState<{
    email: string;
    fullName: string;
    role: 'worker' | 'officer' | 'admin';
    organizationName: string;
  } | null>(null);
  const [checkingInvite, setCheckingInvite] = useState(false);

  // Resolve the invite as soon as a plausible code exists, so the rest of the
  // form can prefill and the user is not typing details we already know.
  const lookupInvite = useCallback(async (code: string) => {
    if (code.trim().length < 4) {
      setInvite(null);
      return;
    }
    setCheckingInvite(true);
    try {
      const found = await authApi.peekInvite(code);
      setInvite(found);
      if (found) {
        setEmail((current) => current || found.email);
        setFullName((current) => current || found.fullName);
        setErrors((e) => ({ ...e, inviteCode: '' }));
      }
    } catch {
      setInvite(null);
    } finally {
      setCheckingInvite(false);
    }
  }, []);

  useEffect(() => {
    const timer = setTimeout(() => void lookupInvite(inviteCode), 450);
    return () => clearTimeout(timer);
  }, [inviteCode, lookupInvite]);

  const handleSubmit = async () => {
    setFormError(null);
    const payload = {
      fullName,
      email,
      phone,
      inviteCode,
      password,
      confirmPassword,
      acceptedTerms,
    };

    const result = validate(signUpSchema, payload);
    if (!result.ok) {
      setErrors(result.errors);
      if (result.errors._form) setFormError(result.errors._form);
      if (result.errors.acceptedTerms) setFormError(result.errors.acceptedTerms);
      return;
    }

    setErrors({});
    setSubmitting(true);
    try {
      const user = await signUp(result.data);
      toast.success('Account created', `You joined ${user.organization.name} as a ${user.profile.role}.`);
      router.replace('/');
    } catch (e) {
      const error = e as { userMessage?: string; fieldErrors?: Record<string, string> };
      setErrors(error.fieldErrors ?? {});
      setFormError(error.fieldErrors ? null : error.userMessage ?? 'Could not create the account.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Screen keyboardAvoiding>
      <Header
        title="Create your account"
        subtitle="Your organisation admin issues the invite code that sets your role and region access."
        onBack
      />

      <View style={{ gap: spacing.xl }}>
        <OfflineBanner />
        {formError ? <Banner tone="danger" message={formError} /> : null}

        <Field
          label="Invite code"
          placeholder="NERC-4821"
          value={inviteCode}
          onChangeText={(v) => setInviteCode(v.toUpperCase())}
          error={errors.inviteCode}
          icon="key"
          autoCapitalize="characters"
          autoCorrect={false}
          required
          hint="Ask your organisation admin if you do not have one."
          rightAdornment={
            checkingInvite ? (
              <Feather name="loader" size={15} color={colors.textTertiary} />
            ) : invite ? (
              <Feather name="check-circle" size={16} color={colors.success} />
            ) : null
          }
        />

        {invite ? (
          <Card level={0} style={{ backgroundColor: colors.successMuted, borderColor: colors.success }}>
            <View style={{ gap: spacing.sm }}>
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                <Feather name="check-circle" size={15} color={colors.success} />
                <Text variant="footnote" weight="700" tone="success" style={{ flex: 1 }}>
                  Invite verified
                </Text>
                <RoleBadge role={invite.role} />
              </View>
              <Text variant="footnote" tone="secondary">
                {invite.organizationName} invited {invite.fullName}. You will join as a{' '}
                {ROLE_META[invite.role].label.toLowerCase()}.
              </Text>
              <Text variant="caption" tone="tertiary">
                {ROLE_META[invite.role].description}
              </Text>
            </View>
          </Card>
        ) : null}

        <Field
          label="Full name"
          placeholder="Amina Hassan"
          value={fullName}
          onChangeText={setFullName}
          error={errors.fullName}
          icon="user"
          autoComplete="name"
          textContentType="name"
          required
        />

        <Field
          label="Work email"
          placeholder="you@organisation.org"
          value={email}
          onChangeText={setEmail}
          error={errors.email}
          icon="mail"
          keyboardType="email-address"
          autoCapitalize="none"
          autoComplete="email"
          required
          hint={invite ? 'Must match the address the invite was sent to.' : undefined}
        />

        <Field
          label="Mobile number"
          placeholder="0712 000 000"
          value={phone}
          onChangeText={setPhone}
          onBlur={() => setPhone((v) => (v ? normalizePhone(v) : v))}
          error={errors.phone}
          icon="phone"
          keyboardType="phone-pad"
          autoComplete="tel"
          required
          hint="Used for urgent contact by your security officer."
        />

        <View style={{ gap: spacing.sm }}>
          <Field
            label="Password"
            placeholder="At least 10 characters"
            value={password}
            onChangeText={setPassword}
            error={errors.password}
            icon="lock"
            secure
            autoComplete="new-password"
            textContentType="newPassword"
            required
          />
          <PasswordMeter password={password} />
        </View>

        <Field
          label="Confirm password"
          placeholder="Re-enter your password"
          value={confirmPassword}
          onChangeText={setConfirmPassword}
          error={errors.confirmPassword}
          icon="lock"
          secure
          autoComplete="new-password"
          required
        />

        {/* Consent - this app handles location data about people at risk */}
        <Pressable
          onPress={() => setAcceptedTerms((v) => !v)}
          accessibilityRole="checkbox"
          accessibilityState={{ checked: acceptedTerms }}
          style={{ flexDirection: 'row', gap: spacing.md, alignItems: 'flex-start', paddingVertical: spacing.xs }}
        >
          <View
            style={{
              width: 22,
              height: 22,
              borderRadius: 6,
              borderWidth: acceptedTerms ? 0 : 1.5,
              borderColor: errors.acceptedTerms ? colors.danger : colors.borderStrong,
              backgroundColor: acceptedTerms ? colors.accent : 'transparent',
              alignItems: 'center',
              justifyContent: 'center',
              marginTop: 1,
            }}
          >
            {acceptedTerms ? <Feather name="check" size={14} color={colors.textOnAccent} /> : null}
          </View>
          <Text variant="footnote" tone="secondary" style={{ flex: 1 }}>
            I understand that this app records my location when I file a report or trigger an SOS, that my reports
            are visible to my organisation&apos;s security officers, and that my identity is hidden from other
            workers.
          </Text>
        </Pressable>
        {errors.acceptedTerms ? (
          <Text variant="caption" tone="danger">
            {errors.acceptedTerms}
          </Text>
        ) : null}

        <Button
          label="Create account"
          size="lg"
          fullWidth
          loading={submitting}
          onPress={handleSubmit}
          icon="user-check"
        />

        <Pressable onPress={() => router.back()} hitSlop={8} accessibilityRole="link">
          <Text variant="footnote" tone="secondary" align="center">
            Already have an account? <Text variant="footnote" tone="accent" weight="600">Sign in</Text>
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
