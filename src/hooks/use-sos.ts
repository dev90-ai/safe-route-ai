import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';

import { sosApi } from '@/api/endpoints/sos';
import { uuid } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { offlineQueue } from '@/lib/offlineQueue';
import { useConnectivity } from '@/state/connectivity';
import { useToast } from '@/state/toast';
import { useLocation } from './use-location';

/**
 * The single SOS trigger.
 *
 * Lives in one place because it is reachable from several screens and must
 * behave identically everywhere: get the best position available, mint the id
 * on-device, and either send it or queue it - never silently drop it, and never
 * block on a GPS fix that may not arrive.
 */
export function useSosTrigger() {
  const router = useRouter();
  const toast = useToast();
  const { online } = useConnectivity();
  const location = useLocation({ auto: false });
  const [pending, setPending] = useState(false);

  const trigger = useCallback(
    async (reason: string | null = null): Promise<string | null> => {
      setPending(true);
      try {
        // Use the cached fix immediately if we have one; only wait for a fresh
        // fix when we have nothing at all.
        const point = location.point ?? (await location.refresh());

        if (!point) {
          toast.error(
            'No position available',
            'Your officers need a location to reach you. Enable location access and try again.',
          );
          return null;
        }

        const clientId = uuid();
        const payload = { location: point, accuracyMeters: location.accuracyMeters, reason };

        if (!online) {
          await offlineQueue.enqueue({ kind: 'sos', id: clientId, payload });
          toast.warning('SOS saved on this device', 'No signal. It will send the instant you reconnect.');
          logger.warn('sos', 'SOS queued offline', { id: clientId });
        } else {
          try {
            await sosApi.trigger(payload, { clientId });
            toast.error('SOS sent', 'Your security officers are alerted and can see your location.');
          } catch (e) {
            // Losing signal mid-send must not lose the SOS.
            const error = e as { kind?: string; userMessage?: string };
            if (error.kind === 'network' || error.kind === 'timeout' || error.kind === 'server') {
              await offlineQueue.enqueue({ kind: 'sos', id: clientId, payload });
              toast.warning('Connection lost', 'Your SOS is saved and will send as soon as signal returns.');
            } else {
              toast.error('Could not send SOS', error.userMessage ?? 'Try again immediately.');
              return null;
            }
          }
        }

        router.push({ pathname: '/sos/[id]', params: { id: clientId } });
        return clientId;
      } finally {
        setPending(false);
      }
    },
    [location, online, router, toast],
  );

  return { trigger, pending, location };
}
