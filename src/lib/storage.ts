import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

const NAMESPACE = 'sra.v1';

const key = (k: string) => `${NAMESPACE}.${k}`;

/**
 * Plain persisted storage. Everything non-sensitive goes here: cached lists,
 * the offline queue, UI preferences.
 */
export const storage = {
  async get<T>(k: string): Promise<T | null> {
    try {
      const raw = await AsyncStorage.getItem(key(k));
      return raw ? (JSON.parse(raw) as T) : null;
    } catch {
      return null;
    }
  },

  async set<T>(k: string, value: T): Promise<void> {
    try {
      await AsyncStorage.setItem(key(k), JSON.stringify(value));
    } catch {
      // Storage is best-effort; a full disk must never break a report submission.
    }
  },

  async remove(k: string): Promise<void> {
    try {
      await AsyncStorage.removeItem(key(k));
    } catch {
      /* noop */
    }
  },

  async keys(prefix?: string): Promise<string[]> {
    try {
      const all = await AsyncStorage.getAllKeys();
      const scoped = all.filter((k) => k.startsWith(`${NAMESPACE}.`)).map((k) => k.slice(NAMESPACE.length + 1));
      return prefix ? scoped.filter((k) => k.startsWith(prefix)) : scoped;
    } catch {
      return [];
    }
  },

  async clearNamespace(): Promise<void> {
    const all = await AsyncStorage.getAllKeys();
    const mine = all.filter((k) => k.startsWith(`${NAMESPACE}.`));
    if (mine.length) await AsyncStorage.multiRemove(mine);
  },
};

/**
 * Credential storage. Session tokens live in the platform keychain/keystore on
 * device; on web there is no keychain, so we fall back to AsyncStorage and the
 * mock backend keeps token lifetimes short to compensate.
 */
const secureAvailable = Platform.OS !== 'web';

export const secureStorage = {
  async get(k: string): Promise<string | null> {
    try {
      if (!secureAvailable) return AsyncStorage.getItem(key(`secure.${k}`));
      return await SecureStore.getItemAsync(key(k).replace(/\./g, '_'));
    } catch {
      return null;
    }
  },

  async set(k: string, value: string): Promise<void> {
    try {
      if (!secureAvailable) {
        await AsyncStorage.setItem(key(`secure.${k}`), value);
        return;
      }
      await SecureStore.setItemAsync(key(k).replace(/\./g, '_'), value, {
        keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
      });
    } catch {
      /* noop */
    }
  },

  async remove(k: string): Promise<void> {
    try {
      if (!secureAvailable) {
        await AsyncStorage.removeItem(key(`secure.${k}`));
        return;
      }
      await SecureStore.deleteItemAsync(key(k).replace(/\./g, '_'));
    } catch {
      /* noop */
    }
  },
};
