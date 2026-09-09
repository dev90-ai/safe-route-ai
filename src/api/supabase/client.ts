import AsyncStorage from '@react-native-async-storage/async-storage';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import Constants from 'expo-constants';
import { Platform } from 'react-native';

// supabase-js needs a complete `URL` implementation. Hermes ships only a
// partial one, so native gets the polyfill - but it is loaded conditionally,
// because the package ships untranspiled syntax that Node cannot parse, which
// silently breaks Expo's static web render into empty shells.
if (Platform.OS !== 'web') {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('react-native-url-polyfill/auto');
}

/**
 * The Supabase client.
 *
 * Only ever constructed with the ANON key. That key ships inside the app bundle
 * and is public by design; what makes it safe is that every table has Row Level
 * Security enabled, so the key is powerless until a user authenticates and the
 * policies decide what their JWT may reach.
 *
 * The service role key must never appear in this project - it bypasses RLS
 * entirely and belongs only in Edge Function secrets.
 */

const extra = (Constants.expoConfig?.extra ?? {}) as {
  supabaseUrl?: string | null;
  supabaseAnonKey?: string | null;
  apiMode?: string;
};

const url = extra.supabaseUrl ?? process.env.EXPO_PUBLIC_SUPABASE_URL ?? '';
const anonKey = extra.supabaseAnonKey ?? process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? '';

/** Whether the app should talk to Supabase at all. */
export const API_MODE: 'mock' | 'supabase' =
  (extra.apiMode ?? process.env.EXPO_PUBLIC_API_MODE ?? 'mock') === 'supabase' && url && anonKey
    ? 'supabase'
    : 'mock';

export const isSupabaseConfigured = Boolean(url && anonKey);

/**
 * Rows are typed as `any` because there is no generated Database type yet.
 * Running `supabase gen types typescript` and swapping this in is the single
 * change that would make every query under api/supabase/ type-checked against
 * the real schema. Until then the mappers are the contract.
 */
type Db = any;

let client: SupabaseClient<Db> | null = null;

export function supabase(): SupabaseClient<Db> {
  if (!client) {
    if (!isSupabaseConfigured) {
      throw new Error(
        'Supabase is not configured. Set EXPO_PUBLIC_SUPABASE_URL and EXPO_PUBLIC_SUPABASE_ANON_KEY in .env, then restart with `npx expo start -c`.',
      );
    }

    client = createClient<Db>(url, anonKey, {
      auth: {
        // Sessions persist in AsyncStorage so a worker who opens the app in the
        // field is not asked to sign in again. The access token is short-lived
        // and refreshed automatically.
        storage: AsyncStorage,
        autoRefreshToken: true,
        persistSession: true,
        // Deep-link session detection is a web concern and breaks on native.
        detectSessionInUrl: Platform.OS === 'web',
      },
      realtime: {
        // Enough for the officer queue and SOS console without hammering a
        // 2G link. Supabase free tier allows 200 concurrent connections.
        params: { eventsPerSecond: 5 },
      },
      global: {
        headers: { 'x-application-name': 'safe-route-ai' },
      },
    });
  }

  return client;
}

/** Clears the cached client. Used when signing out to drop realtime channels. */
export async function resetSupabaseClient(): Promise<void> {
  if (!client) return;
  await client.removeAllChannels();
  client = null;
}
