import * as Location from 'expo-location';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';

import { authApi } from '@/api/endpoints/auth';
import { logger } from '@/lib/logger';
import { network } from '@/lib/network';
import { storage } from '@/lib/storage';
import { useNow } from './use-now';
import type { LatLng } from '@/lib/geo';

/**
 * Location acquisition.
 *
 * Two realities shape this: GPS in North Eastern Kenya is often slow to fix
 * under tree cover or inside a vehicle, and a report is worthless without a
 * position. So we cache the last good fix, surface accuracy honestly, and
 * always leave the user a manual pin as a fallback rather than blocking the
 * form on a satellite.
 */

const LAST_FIX_KEY = 'location.lastFix';
/** Garissa town, used only as a starting map region before any fix exists. */
export const FALLBACK_CENTER: LatLng = { lat: -0.4569, lng: 39.6583 };

export type LocationState = {
  point: LatLng | null;
  accuracyMeters: number | null;
  status: 'idle' | 'requesting' | 'locating' | 'ready' | 'denied' | 'error';
  error: string | null;
  isStale: boolean;
  timestamp: number | null;
  refresh: () => Promise<LatLng | null>;
  requestPermission: () => Promise<boolean>;
};

type CachedFix = { point: LatLng; accuracyMeters: number | null; timestamp: number };

export function useLocation(options: { auto?: boolean; maxAgeMs?: number } = {}): LocationState {
  const { auto = true, maxAgeMs = 5 * 60_000 } = options;

  const [point, setPoint] = useState<LatLng | null>(null);
  const [accuracyMeters, setAccuracy] = useState<number | null>(null);
  const [timestamp, setTimestamp] = useState<number | null>(null);
  const [status, setStatus] = useState<LocationState['status']>('idle');
  const [error, setError] = useState<string | null>(null);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  // Show the last known fix instantly while a fresh one is acquired.
  useEffect(() => {
    void storage.get<CachedFix>(LAST_FIX_KEY).then((cached) => {
      if (cached && mounted.current) {
        setPoint(cached.point);
        setAccuracy(cached.accuracyMeters);
        setTimestamp(cached.timestamp);
      }
    });
  }, []);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    setStatus('requesting');
    try {
      const { status: permission } = await Location.requestForegroundPermissionsAsync();
      if (permission !== 'granted') {
        setStatus('denied');
        setError('Location permission is required to attach a position to your report.');
        return false;
      }
      return true;
    } catch (e) {
      logger.capture('location', e, { phase: 'permission' });
      setStatus('error');
      setError('Could not request location permission.');
      return false;
    }
  }, []);

  const refresh = useCallback(async (): Promise<LatLng | null> => {
    try {
      const { status: existing } = await Location.getForegroundPermissionsAsync();
      if (existing !== 'granted') {
        const granted = await requestPermission();
        if (!granted) return null;
      }

      setStatus('locating');
      setError(null);

      const position = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.Balanced,
      });

      const fix: LatLng = { lat: position.coords.latitude, lng: position.coords.longitude };
      const accuracy = position.coords.accuracy ?? null;

      if (mounted.current) {
        setPoint(fix);
        setAccuracy(accuracy);
        setTimestamp(position.timestamp);
        setStatus('ready');
      }

      await storage.set<CachedFix>(LAST_FIX_KEY, {
        point: fix,
        accuracyMeters: accuracy,
        timestamp: position.timestamp,
      });

      // Keep last_known_location current so alert fan-out can reach this user.
      if (network.isOnline()) {
        void authApi.updateLocation(fix).catch(() => {});
      }

      return fix;
    } catch (e) {
      logger.capture('location', e, { phase: 'fix' });
      if (mounted.current) {
        setStatus(point ? 'ready' : 'error');
        setError(
          point
            ? 'Could not get a fresh position. Using your last known location - adjust the pin if it is wrong.'
            : 'Could not get a position. Drop a pin on the map instead.',
        );
      }
      return point;
    }
  }, [point, requestPermission]);

  useEffect(() => {
    if (!auto) return;
    if (Platform.OS === 'web' && typeof navigator !== 'undefined' && !navigator.geolocation) return;
    // Acquire a fix on mount. Every state write inside `refresh` happens after
    // an await, so there is no synchronous render cascade here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh();
    // Intentionally runs once: repeated auto-refresh would drain a field battery.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [auto]);

  // Read the clock as a render input rather than calling Date.now() inline,
  // which React Compiler may memoise into a frozen value.
  const now = useNow(60_000);
  const isStale = timestamp !== null && now - timestamp > maxAgeMs;

  return { point, accuracyMeters, status, error, isStale, timestamp, refresh, requestPermission };
}

/**
 * Continuous tracking while an SOS is live. Deliberately separate from
 * `useLocation`: it runs at a fixed cadence, it must keep running when the
 * screen is not focused, and it tolerates individual failures without stopping.
 */
export function useSosTracking(
  active: boolean,
  onFix: (point: LatLng, accuracyMeters: number | null) => void,
  intervalMs = 30_000,
) {
  // Kept in a ref so a new inline callback does not tear down and restart the
  // position watch mid-emergency. Updated in an effect; the watch only invokes
  // it after a fix arrives, which is always after commit.
  const callbackRef = useRef(onFix);
  useEffect(() => {
    callbackRef.current = onFix;
  });

  useEffect(() => {
    if (!active) return;

    let cancelled = false;
    let subscription: Location.LocationSubscription | null = null;

    (async () => {
      try {
        const { status } = await Location.getForegroundPermissionsAsync();
        if (status !== 'granted') {
          const requested = await Location.requestForegroundPermissionsAsync();
          if (requested.status !== 'granted') {
            logger.warn('sos', 'location permission denied during active SOS');
            return;
          }
        }

        subscription = await Location.watchPositionAsync(
          {
            accuracy: Location.Accuracy.High,
            timeInterval: intervalMs,
            distanceInterval: 40,
          },
          (position) => {
            if (cancelled) return;
            callbackRef.current(
              { lat: position.coords.latitude, lng: position.coords.longitude },
              position.coords.accuracy ?? null,
            );
          },
        );
      } catch (e) {
        logger.capture('sos', e, { phase: 'tracking' });
      }
    })();

    return () => {
      cancelled = true;
      subscription?.remove();
    };
  }, [active, intervalMs]);
}
