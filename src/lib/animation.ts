import { Platform } from 'react-native';

/**
 * Whether Animated can hand work to the native driver.
 *
 * React Native Web has no native animated module, so `useNativeDriver: true`
 * there logs a warning on every animation and silently falls back to JS. This
 * is the single place that decision is made, so no component has to remember.
 */
export const USE_NATIVE_DRIVER = Platform.OS !== 'web';
