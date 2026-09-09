import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

import { network, type ConnectionQuality, type NetworkStatus } from '@/lib/network';
import { offlineQueue, type QueueItem } from '@/lib/offlineQueue';

/**
 * Connectivity plus the offline outbox, in one provider.
 *
 * They belong together because the only reason the user cares about the network
 * indicator is to know whether the things they submitted have actually left the
 * device. Every screen that can queue work shows the same banner from here.
 */

type ConnectivityContextValue = {
  online: boolean;
  quality: ConnectionQuality;
  connectionType: string;
  simulatedOffline: boolean;
  setSimulatedOffline: (value: boolean) => void;
  queue: QueueItem[];
  counts: ReturnType<typeof offlineQueue.counts>;
  retry: (queueId: string) => Promise<void>;
  retryAll: () => Promise<void>;
  discard: (queueId: string) => Promise<void>;
  drain: () => Promise<void>;
};

const ConnectivityContext = createContext<ConnectivityContextValue | null>(null);

export function ConnectivityProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<NetworkStatus>(network.get());
  const [queue, setQueue] = useState<QueueItem[]>([]);

  useEffect(() => {
    network.start();
    const unsubNetwork = network.subscribe(setStatus);
    let unsubQueue: (() => void) | undefined;
    void offlineQueue.hydrate().then(() => {
      unsubQueue = offlineQueue.subscribe(setQueue);
    });

    return () => {
      unsubNetwork();
      unsubQueue?.();
    };
  }, []);

  const value = useMemo<ConnectivityContextValue>(() => {
    const online = status.online && !status.simulatedOffline;
    return {
      online,
      quality: status.simulatedOffline ? 'offline' : status.quality,
      connectionType: status.type,
      simulatedOffline: status.simulatedOffline,
      setSimulatedOffline: (value) => network.setSimulatedOffline(value),
      queue,
      counts: {
        total: queue.length,
        pending: queue.filter((i) => i.status === 'pending').length,
        sending: queue.filter((i) => i.status === 'sending').length,
        failed: queue.filter((i) => i.status === 'failed').length,
        reports: queue.filter((i) => i.kind === 'report').length,
        sos: queue.filter((i) => i.kind === 'sos').length,
      },
      retry: (queueId) => offlineQueue.retry(queueId),
      retryAll: () => offlineQueue.retryAllFailed(),
      discard: (queueId) => offlineQueue.discard(queueId),
      drain: () => offlineQueue.drain(),
    };
  }, [status, queue]);

  return <ConnectivityContext.Provider value={value}>{children}</ConnectivityContext.Provider>;
}

export function useConnectivity(): ConnectivityContextValue {
  const ctx = useContext(ConnectivityContext);
  if (!ctx) throw new Error('useConnectivity must be used inside <ConnectivityProvider>');
  return ctx;
}
