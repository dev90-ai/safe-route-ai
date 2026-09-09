import { Redirect, Stack } from 'expo-router';

import { useAuth } from '@/state/auth';
import { useTheme } from '@/theme';

export default function AuthLayout() {
  const { status } = useAuth();
  const { colors } = useTheme();

  // Someone who is already signed in has no business on these screens.
  if (status === 'authenticated') return <Redirect href="/" />;
  if (status === 'onboarding') return <Redirect href="/onboarding" />;

  return (
    <Stack
      screenOptions={{
        headerShown: false,
        contentStyle: { backgroundColor: colors.background },
        animation: 'slide_from_right',
      }}
    />
  );
}
