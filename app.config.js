/**
 * Dynamic Expo config.
 *
 * app.json is static, so it cannot read the Google Maps key from .env - and the
 * key must not be committed. This wraps the JSON and injects the values that
 * come from the environment at build time.
 *
 * Everything else still lives in app.json; this only overlays what has to be
 * environment-specific.
 */
const base = require('./app.json');

module.exports = ({ config }) => {
  const mapsKey = process.env.EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY;

  // A blank grey map is a confusing way to discover a missing key, so say so
  // at build time instead. Not fatal: everything except the Android map works.
  if (!mapsKey && process.env.EXPO_PUBLIC_API_MODE !== 'mock') {
    console.warn(
      '[app.config] EXPO_PUBLIC_GOOGLE_MAPS_ANDROID_KEY is not set - the Android map will render blank.',
    );
  }

  return {
    ...config,
    ...base.expo,
    android: {
      ...base.expo.android,
      ...(mapsKey ? { config: { googleMaps: { apiKey: mapsKey } } } : {}),
    },
    extra: {
      ...(base.expo.extra ?? {}),
      supabaseUrl: process.env.EXPO_PUBLIC_SUPABASE_URL ?? null,
      supabaseAnonKey: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY ?? null,
      apiMode: process.env.EXPO_PUBLIC_API_MODE ?? 'mock',
      directionsProvider: process.env.EXPO_PUBLIC_DIRECTIONS_PROVIDER ?? null,
      mapboxToken: process.env.EXPO_PUBLIC_MAPBOX_TOKEN ?? null,
      sentryDsn: process.env.EXPO_PUBLIC_SENTRY_DSN ?? null,
    },
  };
};
