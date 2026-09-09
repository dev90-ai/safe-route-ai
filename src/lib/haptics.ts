import * as Haptics from 'expo-haptics';
import { Platform } from 'react-native';

/**
 * Haptics are a real accessibility feature here, not polish: a worker who taps
 * SOS in a moving vehicle needs confirmation they can feel without looking.
 * Every call is fire-and-forget and silently no-ops on web.
 */
const enabled = Platform.OS !== 'web';

const run = (fn: () => Promise<void>) => {
  if (!enabled) return;
  void fn().catch(() => {});
};

export const haptics = {
  tap: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light)),
  press: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium)),
  heavy: () => run(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Heavy)),
  select: () => run(() => Haptics.selectionAsync()),
  success: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success)),
  warning: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning)),
  error: () => run(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error)),

  /** Distinct triple pulse reserved for SOS activation. */
  sos: () => {
    if (!enabled) return;
    void (async () => {
      try {
        for (let i = 0; i < 3; i += 1) {
          await Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          await new Promise((r) => setTimeout(r, 140));
        }
      } catch {
        /* noop */
      }
    })();
  },
};
