import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import * as Device from 'expo-device';
import { Redirect } from 'expo-router';
import { View } from 'react-native';

import { auth as apiAuth } from '@/api/client';
import { cache } from '@/api/cache';
import { db } from '@/api/db';
import { authApi, mockAuthApi } from '@/api/endpoints/auth';
import { API_MODE } from '@/api/supabase/client';
import { supabaseAuthApi } from '@/api/supabase/auth';
import { ApiError, toApiError } from '@/api/errors';
import type { AuthUser, Session } from '@/api/types';
import { logger } from '@/lib/logger';
import { network } from '@/lib/network';
import { offlineQueue } from '@/lib/offlineQueue';
import { useTheme } from '@/theme';
import { secureStorage } from '@/lib/storage';

/**
 * Session lifecycle.
 *
 * The session token lives in the platform keychain, never in plain storage, and
 * is restored at cold start so a worker who opens the app in the field is not
 * asked to type a password before they can file a report. If restoration fails
 * for any reason the app falls back to signed-out rather than to a half state.
 */

const SESSION_KEY = 'session';

export type AuthStatus = 'loading' | 'signed-out' | 'onboarding' | 'authenticated';

type AuthContextValue = {
  status: AuthStatus;
  user: AuthUser | null;
  bootError: string | null;
  signIn: (email: string, password: string) => Promise<AuthUser>;
  signUp: (input: unknown) => Promise<AuthUser>;
  signOut: () => Promise<void>;
  completeOnboarding: (input: unknown) => Promise<AuthUser>;
  refresh: () => Promise<void>;
  applyUser: (user: AuthUser) => void;
};

const AuthContext = createContext<AuthContextValue | null>(null);

function deviceLabel(): string {
  const name = Device.deviceName || Device.modelName || 'Unknown device';
  return name.slice(0, 48);
}

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [user, setUser] = useState<AuthUser | null>(null);
  const [bootError, setBootError] = useState<string | null>(null);
  const bootedRef = useRef(false);

  const applyUser = useCallback((next: AuthUser) => {
    setUser(next);
    // A worker with no declared regions cannot be alerted correctly, so the
    // app routes them to onboarding rather than to a dashboard that lies.
    const needsOnboarding = next.profile.role === 'worker' && !next.profile.onboardedAt;
    setStatus(needsOnboarding ? 'onboarding' : 'authenticated');
  }, []);

  // --- Cold start -----------------------------------------------------------
  useEffect(() => {
    if (bootedRef.current) return;
    bootedRef.current = true;

    (async () => {
      try {
        network.start();
        await Promise.all([cache.hydrate(), logger.hydrate(), offlineQueue.hydrate()]);

        if (API_MODE === 'supabase') {
          // supabase-js persists and refreshes its own session in AsyncStorage,
          // so there is no token for us to hold. Ask it whether one survived.
          const restored = await supabaseAuthApi.restore();
          applyUser(restored);
          logger.info('auth', 'session restored', { role: restored.profile.role, transport: 'supabase' });
          void offlineQueue.drain();
          return;
        }

        await db.init();

        const raw = await secureStorage.get(SESSION_KEY);
        if (!raw) {
          setStatus('signed-out');
          return;
        }

        const session = JSON.parse(raw) as Session;
        if (Date.parse(session.expiresAt) < Date.now()) {
          await secureStorage.remove(SESSION_KEY);
          setStatus('signed-out');
          return;
        }

        const restored = await mockAuthApi.restore(session);
        applyUser(restored);
        logger.info('auth', 'session restored', { role: restored.profile.role, transport: 'mock' });
        void offlineQueue.drain();
      } catch (e) {
        const error = toApiError(e);
        // A failed restore is not an app failure - it is just a signed-out user.
        if (error.kind !== 'unauthorized') {
          logger.capture('auth', e, { phase: 'boot' });
          setBootError(error.userMessage);
        }
        await secureStorage.remove(SESSION_KEY);
        apiAuth.setSession(null);
        setStatus('signed-out');
      }
    })();
  }, [applyUser]);

  // --- Actions --------------------------------------------------------------

  const signIn = useCallback(
    async (email: string, password: string): Promise<AuthUser> => {
      const { session, user: next } = await authApi.signIn({ email, password }, deviceLabel());
      // supabase-js owns its own session storage; only the mock needs this.
      if (API_MODE !== 'supabase') await secureStorage.set(SESSION_KEY, JSON.stringify(session));
      applyUser(next);
      void offlineQueue.drain();
      return next;
    },
    [applyUser],
  );

  const signUp = useCallback(
    async (input: unknown): Promise<AuthUser> => {
      const { session, user: next } = await authApi.signUp(input);
      if (API_MODE !== 'supabase') await secureStorage.set(SESSION_KEY, JSON.stringify(session));
      applyUser(next);
      return next;
    },
    [applyUser],
  );

  const signOut = useCallback(async () => {
    try {
      await authApi.signOut();
    } catch {
      // Signing out must always succeed locally, even with no connection.
      logger.warn('auth', 'remote sign-out failed, clearing locally');
    }
    await secureStorage.remove(SESSION_KEY);
    apiAuth.setSession(null);
    setUser(null);
    setStatus('signed-out');
  }, []);

  const completeOnboarding = useCallback(
    async (input: unknown): Promise<AuthUser> => {
      const next = await authApi.completeOnboarding(input);
      applyUser(next);
      return next;
    },
    [applyUser],
  );

  const refresh = useCallback(async () => {
    try {
      const next = await authApi.me();
      applyUser(next);
    } catch (e) {
      const error = toApiError(e);
      if (error.kind === 'unauthorized' || error.kind === 'forbidden') await signOut();
    }
  }, [applyUser, signOut]);

  const value = useMemo<AuthContextValue>(
    () => ({ status, user, bootError, signIn, signUp, signOut, completeOnboarding, refresh, applyUser }),
    [status, user, bootError, signIn, signUp, signOut, completeOnboarding, refresh, applyUser],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

/** Convenience for screens that are already behind the auth gate. */
export function useCurrentUser(): AuthUser {
  const { user } = useAuth();
  if (!user) throw new Error('useCurrentUser used outside an authenticated route');
  return user;
}

/**
 * Renders children only once there is a signed-in user.
 *
 * `Stack.Protected` in the root layout is the primary guard, but a layout that
 * is already mounted can still be asked for one more render as the session
 * tears down. This makes that render harmless instead of a crash, so screens
 * can keep reading `user` without defensive checks everywhere.
 */
export function RequireUser({ children }: { children: ReactNode }) {
  const { status, user } = useAuth();
  const { colors } = useTheme();

  if (status === 'signed-out') return <Redirect href="/(auth)/sign-in" />;
  if (status === 'onboarding') return <Redirect href="/onboarding" />;
  if (!user) {
    // Loading, or a frame mid-sign-out. Paint the background, never a crash.
    return <View style={{ flex: 1, backgroundColor: colors.background }} />;
  }

  return <>{children}</>;
}

export function useRole() {
  const { user } = useAuth();
  const role = user?.profile.role ?? null;
  return {
    role,
    isWorker: role === 'worker',
    isOfficer: role === 'officer',
    isAdmin: role === 'admin',
  };
}

export { ApiError };
