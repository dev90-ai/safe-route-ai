import { Redirect } from 'expo-router';
import { ActivityIndicator, View } from 'react-native';

import { Text } from '@/components/ui';
import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';

/**
 * Entry gate.
 *
 * Every route decision for a signed-in user happens here, once, rather than
 * being re-derived by each layout. Roles land on completely different tab sets
 * because their jobs share almost no screens.
 */
export default function Index() {
  const { status, user } = useAuth();
  const { colors, spacing } = useTheme();

  if (status === 'loading') {
    return (
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: colors.background, gap: spacing.lg }}>
        <ActivityIndicator color={colors.accent} />
        <Text variant="footnote" tone="tertiary">
          Restoring your session…
        </Text>
      </View>
    );
  }

  if (status === 'signed-out' || !user) return <Redirect href="/(auth)/sign-in" />;
  if (status === 'onboarding') return <Redirect href="/onboarding" />;

  switch (user.profile.role) {
    case 'officer':
      return <Redirect href="/(officer)" />;
    case 'admin':
      return <Redirect href="/(admin)" />;
    default:
      return <Redirect href="/(worker)" />;
  }
}
