import { Stack } from 'expo-router';

import { RequireUser } from '@/state/auth';
import { useTheme } from '@/theme';

export default function SettingsLayout() {
  const { colors } = useTheme();

  return (
    <RequireUser>
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      />
    </RequireUser>
  );
}
