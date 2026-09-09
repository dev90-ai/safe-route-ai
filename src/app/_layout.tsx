import { Stack } from 'expo-router';
import * as SplashScreen from 'expo-splash-screen';
import { StatusBar } from 'expo-status-bar';
import { useEffect } from 'react';
import { View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { logger } from '@/lib/logger';
import { AuthProvider, useAuth } from '@/state/auth';
import { ConnectivityProvider } from '@/state/connectivity';
import { NotificationsProvider } from '@/state/notifications';
import { ToastProvider } from '@/state/toast';
import { ThemeProvider, useTheme } from '@/theme';

void SplashScreen.preventAutoHideAsync().catch(() => {});

/**
 * Provider order matters:
 *   Theme -> Toast -> Connectivity -> Auth -> Notifications
 *
 * Auth needs to raise toasts during boot, Notifications needs a signed-in
 * profile before it can subscribe to that person's alert channel, and
 * Connectivity has to be watching before the first request goes out so an
 * offline cold start queues rather than fails.
 */
export default function RootLayout() {
  useEffect(() => {
    const handler = (error: unknown) => logger.capture('app', error, { boundary: 'global' });
    // Surfaces unhandled promise rejections in the Diagnostics screen instead
    // of letting them vanish into the console.
    const globalScope = globalThis as unknown as {
      onunhandledrejection?: ((e: { reason: unknown }) => void) | null;
    };
    const previous = globalScope.onunhandledrejection;
    globalScope.onunhandledrejection = (event) => {
      handler(event.reason);
      previous?.(event);
    };
    return () => {
      globalScope.onunhandledrejection = previous;
    };
  }, []);

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider>
          <ToastProvider>
            <ConnectivityProvider>
              <AuthProvider>
                <NotificationsProvider>
                  <ThemedShell />
                </NotificationsProvider>
              </AuthProvider>
            </ConnectivityProvider>
          </ToastProvider>
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}

function ThemedShell() {
  const { colors, scheme } = useTheme();
  const { status } = useAuth();

  useEffect(() => {
    if (status !== 'loading') {
      // Hold the splash until we know where to send the user, so nobody sees a
      // flash of the sign-in screen before their session restores.
      void SplashScreen.hideAsync().catch(() => {});
    }
  }, [status]);

  return (
    <View style={{ flex: 1, backgroundColor: colors.background }}>
      <StatusBar style={scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerShown: false,
          contentStyle: { backgroundColor: colors.background },
          animation: 'slide_from_right',
        }}
      >
        <Stack.Screen name="index" options={{ animation: 'fade' }} />

        {/*
          Route guards, not just redirects.

          On sign-out `user` becomes null in the same commit that `status`
          flips. A mounted screen would otherwise render once more against a
          null user before any redirect could run - which is exactly how
          `user!.profile` blows up. `Stack.Protected` unmounts these routes as
          the guard flips, so that render never happens.
        */}
        <Stack.Protected guard={status === 'signed-out'}>
          <Stack.Screen name="(auth)" options={{ animation: 'fade' }} />
        </Stack.Protected>

        <Stack.Protected guard={status === 'onboarding'}>
          <Stack.Screen name="onboarding" options={{ animation: 'fade', gestureEnabled: false }} />
        </Stack.Protected>

        <Stack.Protected guard={status === 'authenticated'}>
          <Stack.Screen name="(worker)" options={{ animation: 'fade' }} />
          <Stack.Screen name="(officer)" options={{ animation: 'fade' }} />
          <Stack.Screen name="(admin)" options={{ animation: 'fade' }} />
          <Stack.Screen name="report/[id]" />
          <Stack.Screen name="sos/[id]" />
          <Stack.Screen name="alert/[id]" />
          <Stack.Screen name="advisory/new" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="people/invite" options={{ presentation: 'modal', animation: 'slide_from_bottom' }} />
          <Stack.Screen name="settings" />
          <Stack.Screen name="queue" />
          <Stack.Screen name="diagnostics" />
        </Stack.Protected>
      </Stack>
    </View>
  );
}
