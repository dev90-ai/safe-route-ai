import Constants, { ExecutionEnvironment } from 'expo-constants';
import { Platform } from 'react-native';

import { logger } from './logger';

/**
 * Guarded wrapper around expo-notifications.
 *
 * `expo-notifications` throws at *import time* on Android inside Expo Go
 * (remote push was removed from the Go client in SDK 53). A bare top-level
 * import therefore takes the whole app down before the first screen renders,
 * so nothing in this project imports it directly - everything goes through here.
 *
 * The rule this enforces: **push is an optimisation, never the record.** Alerts
 * always land in the persistent feed and always raise an in-app toast over the
 * realtime channel. If the OS-level notification cannot be delivered, the user
 * loses the buzz in their pocket, not the alert.
 */

type NotificationsModule = typeof import('expo-notifications');

const isExpoGo = Constants.executionEnvironment === ExecutionEnvironment.StoreClient;

/** Why push is unavailable, phrased for a person rather than a stack trace. */
export type PushUnavailableReason = 'expo-go' | 'web' | 'load-failed' | null;

let mod: NotificationsModule | null = null;
let reason: PushUnavailableReason = null;
let attempted = false;

function load(): NotificationsModule | null {
  if (attempted) return mod;
  attempted = true;

  if (Platform.OS === 'web') {
    reason = 'web';
    return null;
  }

  // Importing the module at all is what throws in Expo Go on Android.
  if (isExpoGo && Platform.OS === 'android') {
    reason = 'expo-go';
    logger.warn('push', 'expo-notifications unavailable in Expo Go on Android; using in-app alerts only');
    return null;
  }

  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require('expo-notifications') as NotificationsModule;
    return mod;
  } catch (e) {
    reason = 'load-failed';
    logger.capture('push', e, { phase: 'load' });
    return null;
  }
}

export type PushPermission = 'granted' | 'denied' | 'undetermined' | 'unavailable';

export const push = {
  /** True when OS-level notifications can actually be delivered. */
  get available(): boolean {
    return load() !== null;
  },

  get unavailableReason(): PushUnavailableReason {
    load();
    return reason;
  },

  /** Human-readable explanation for the UI. Null when push works. */
  get unavailableMessage(): string | null {
    load();
    if (reason === 'expo-go') {
      return 'Expo Go cannot deliver notifications on Android. Alerts still arrive in this feed and as in-app banners while the app is open. Use a development build for real push.';
    }
    if (reason === 'web') {
      return 'The web build does not deliver OS notifications. Alerts appear in this feed and as in-app banners.';
    }
    if (reason === 'load-failed') {
      return 'Notifications are unavailable on this device. Alerts still appear in this feed.';
    }
    return null;
  },

  /** Called once at startup. Safe to call when push is unavailable. */
  configure() {
    const notifications = load();
    if (!notifications) return;

    notifications.setNotificationHandler({
      handleNotification: async (notification) => {
        const severity = (notification.request.content.data as { severity?: string } | undefined)?.severity;
        const critical = severity === 'critical' || severity === 'high';
        return {
          shouldShowBanner: true,
          shouldShowList: true,
          shouldPlaySound: critical,
          shouldSetBadge: true,
        };
      },
    });
  },

  async ensureAndroidChannels(): Promise<void> {
    const notifications = load();
    if (!notifications || Platform.OS !== 'android') return;

    try {
      await notifications.setNotificationChannelAsync('threat-alerts', {
        name: 'Verified threat alerts',
        importance: notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
        lightColor: '#E11D48',
        lockscreenVisibility: notifications.AndroidNotificationVisibility.PUBLIC,
      });
      await notifications.setNotificationChannelAsync('sos', {
        name: 'SOS events',
        importance: notifications.AndroidImportance.MAX,
        vibrationPattern: [0, 400, 200, 400, 200, 400],
        lightColor: '#E11D48',
        bypassDnd: true,
      });
      await notifications.setNotificationChannelAsync('advisories', {
        name: 'Safety advisories',
        importance: notifications.AndroidImportance.DEFAULT,
      });
    } catch (e) {
      logger.capture('push', e, { phase: 'channels' });
    }
  },

  async getPermission(): Promise<PushPermission> {
    const notifications = load();
    if (!notifications) return 'unavailable';

    try {
      const settings = await notifications.getPermissionsAsync();
      if (settings.granted) return 'granted';
      return settings.canAskAgain ? 'undetermined' : 'denied';
    } catch (e) {
      logger.capture('push', e, { phase: 'permission-check' });
      return 'unavailable';
    }
  },

  async requestPermission(): Promise<boolean> {
    const notifications = load();
    if (!notifications) return false;

    try {
      const result = await notifications.requestPermissionsAsync({
        ios: { allowAlert: true, allowSound: true, allowBadge: true, allowCriticalAlerts: true },
      });
      return result.granted;
    } catch (e) {
      logger.capture('push', e, { phase: 'permission-request' });
      return false;
    }
  },

  /** Present a notification now. Silently does nothing when unavailable. */
  async present(input: {
    title: string;
    body: string;
    data?: Record<string, unknown>;
    critical?: boolean;
    channelId?: string;
  }): Promise<void> {
    const notifications = load();
    if (!notifications) return;

    try {
      await notifications.scheduleNotificationAsync({
        content: {
          title: input.title,
          body: input.body,
          data: input.data ?? {},
          sound: !!input.critical,
          ...(Platform.OS === 'android' ? { channelId: input.channelId ?? 'threat-alerts' } : {}),
        },
        trigger: null,
      });
    } catch (e) {
      logger.capture('push', e, { phase: 'present' });
    }
  },

  async setBadgeCount(count: number): Promise<void> {
    const notifications = load();
    if (!notifications) return;
    try {
      await notifications.setBadgeCountAsync(count);
    } catch {
      // Badge support is patchy across launchers; never worth surfacing.
    }
  },
};
