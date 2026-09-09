import { reportsApi } from '@/api/endpoints/reports';
import { sosApi } from '@/api/endpoints/sos';
import { toApiError } from '@/api/errors';
import type { ReportDraftInput } from '@/lib/validation';
import { localId } from './ids';
import { logger } from './logger';
import { network } from './network';
import { storage } from './storage';

/**
 * Durable outbox for anything that must survive a dead zone.
 *
 * North Eastern Kenya's coverage gaps are the reason this file exists. A report
 * filed in a village with no signal, or an SOS pressed in one, has to be
 * recorded on the device immediately and sent the instant a bar of signal comes
 * back - hours later, after an app restart, after a battery pull.
 *
 * Design commitments:
 *  - **The id is minted on the device**, before the request is ever attempted,
 *    and doubles as the server's idempotency key. Retrying a submission that
 *    actually succeeded but whose response was lost cannot create a duplicate.
 *  - **SOS always goes first**, regardless of when it was queued.
 *  - **Backoff is capped and per-item**, so one poisoned entry cannot block the
 *    queue behind it.
 *  - **Nothing is dropped silently.** An item that exhausts its retries moves
 *    to a `failed` state that the UI surfaces and the user can retry by hand.
 */

export type QueueItemStatus = 'pending' | 'sending' | 'failed';

export type QueuedReport = {
  kind: 'report';
  id: string;
  payload: ReportDraftInput;
  /** Local file URI for a photo that has not been uploaded yet. */
  localPhotoUri: string | null;
};

export type QueuedSos = {
  kind: 'sos';
  id: string;
  payload: { location: { lat: number; lng: number }; accuracyMeters: number | null; reason: string | null };
};

export type QueuedLocation = {
  kind: 'sos-location';
  id: string;
  sosId: string;
  payload: { location: { lat: number; lng: number }; accuracyMeters: number | null };
};

export type QueuePayload = QueuedReport | QueuedSos | QueuedLocation;

export type QueueItem = QueuePayload & {
  queueId: string;
  status: QueueItemStatus;
  attempts: number;
  createdAt: number;
  lastAttemptAt: number | null;
  nextAttemptAt: number;
  lastError: string | null;
};

const STORAGE_KEY = 'offline.queue';
const MAX_ATTEMPTS = 8;
const BASE_BACKOFF_MS = 4000;
const MAX_BACKOFF_MS = 5 * 60_000;

/** SOS outranks everything. A location ping outranks a report. */
const PRIORITY: Record<QueuePayload['kind'], number> = { sos: 0, 'sos-location': 1, report: 2 };

let items: QueueItem[] = [];
let hydrated = false;
let draining = false;
let drainTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<(items: QueueItem[]) => void>();
const notify = () => listeners.forEach((fn) => fn([...items]));

async function persist() {
  await storage.set(STORAGE_KEY, items);
}

function backoffFor(attempts: number): number {
  const exponential = Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempts);
  // Jitter so a whole convoy regaining signal at once does not stampede.
  return exponential * (0.6 + Math.random() * 0.6);
}

async function send(item: QueueItem): Promise<void> {
  switch (item.kind) {
    case 'report':
      await reportsApi.create(item.payload, { clientId: item.id });
      return;
    case 'sos':
      await sosApi.trigger(item.payload, { clientId: item.id, queuedOffline: true });
      return;
    case 'sos-location':
      await sosApi.pushLocation(item.sosId, item.payload.location, item.payload.accuracyMeters);
      return;
  }
}

export const offlineQueue = {
  async hydrate(): Promise<void> {
    if (hydrated) return;
    hydrated = true;
    const saved = await storage.get<QueueItem[]>(STORAGE_KEY);
    if (saved?.length) {
      // Anything caught mid-flight by a crash is retryable, not lost.
      items = saved.map((i) => (i.status === 'sending' ? { ...i, status: 'pending' as const } : i));
      logger.info('queue', 'restored offline queue', { items: items.length });
      notify();
    }

    network.subscribe((status) => {
      if (status.online && !status.simulatedOffline && items.some((i) => i.status !== 'failed')) {
        logger.info('queue', 'connection restored, draining queue');
        void offlineQueue.drain();
      }
    });
  },

  /**
   * Enqueue work. Returns the id the server will use, so the caller can render
   * an optimistic row that reconciles cleanly when the real one arrives.
   */
  async enqueue(payload: QueuePayload): Promise<string> {
    await offlineQueue.hydrate();

    const item: QueueItem = {
      ...payload,
      queueId: localId('q'),
      status: 'pending',
      attempts: 0,
      createdAt: Date.now(),
      lastAttemptAt: null,
      nextAttemptAt: Date.now(),
      lastError: null,
    };

    items = [...items, item];
    await persist();
    notify();

    logger.info('queue', 'item queued', { kind: payload.kind, id: payload.id });
    void offlineQueue.drain();
    return payload.id;
  },

  /**
   * Attempt everything that is due, highest priority first. Safe to call at any
   * time; overlapping calls collapse into one pass.
   */
  async drain(): Promise<void> {
    await offlineQueue.hydrate();
    if (draining) return;
    if (!network.isOnline()) return;

    draining = true;
    try {
      let progressed = true;

      while (progressed) {
        progressed = false;
        const now = Date.now();

        const due = items
          .filter((i) => i.status === 'pending' && i.nextAttemptAt <= now)
          .sort((a, b) => PRIORITY[a.kind] - PRIORITY[b.kind] || a.createdAt - b.createdAt);

        if (!due.length) break;

        for (const item of due) {
          if (!network.isOnline()) return;

          items = items.map((i) => (i.queueId === item.queueId ? { ...i, status: 'sending' } : i));
          notify();

          try {
            await send(item);
            items = items.filter((i) => i.queueId !== item.queueId);
            await persist();
            notify();
            progressed = true;
            logger.info('queue', 'item sent', { kind: item.kind, id: item.id, attempts: item.attempts + 1 });
          } catch (e) {
            const error = toApiError(e);
            const attempts = item.attempts + 1;

            // A validation or permission failure will never succeed on retry -
            // parking it immediately keeps the queue honest.
            const permanent = !error.retryable || attempts >= MAX_ATTEMPTS;

            items = items.map((i) =>
              i.queueId === item.queueId
                ? {
                    ...i,
                    status: permanent ? ('failed' as const) : ('pending' as const),
                    attempts,
                    lastAttemptAt: Date.now(),
                    nextAttemptAt: Date.now() + backoffFor(attempts),
                    lastError: error.userMessage,
                  }
                : i,
            );
            await persist();
            notify();

            if (permanent) {
              logger.error('queue', 'item permanently failed', {
                kind: item.kind,
                id: item.id,
                attempts,
                reason: error.kind,
              });
            } else if (error.kind === 'network') {
              // Signal is gone again; stop the pass rather than burning attempts.
              return;
            }
          }
        }
      }
    } finally {
      draining = false;
      offlineQueue.scheduleNextDrain();
    }
  },

  /** Wake up when the next backoff expires, so retries do not need the user. */
  scheduleNextDrain() {
    if (drainTimer) clearTimeout(drainTimer);
    const pending = items.filter((i) => i.status === 'pending');
    if (!pending.length) return;

    const soonest = Math.min(...pending.map((i) => i.nextAttemptAt));
    const delay = Math.max(1000, Math.min(MAX_BACKOFF_MS, soonest - Date.now()));
    drainTimer = setTimeout(() => {
      drainTimer = null;
      void offlineQueue.drain();
    }, delay);
  },

  /** Manual retry from the queue UI. */
  async retry(queueId: string): Promise<void> {
    items = items.map((i) =>
      i.queueId === queueId ? { ...i, status: 'pending' as const, attempts: 0, nextAttemptAt: Date.now(), lastError: null } : i,
    );
    await persist();
    notify();
    void offlineQueue.drain();
  },

  async retryAllFailed(): Promise<void> {
    items = items.map((i) =>
      i.status === 'failed' ? { ...i, status: 'pending' as const, attempts: 0, nextAttemptAt: Date.now(), lastError: null } : i,
    );
    await persist();
    notify();
    void offlineQueue.drain();
  },

  /** Discard an item. Only ever user-initiated, and logged. */
  async discard(queueId: string): Promise<void> {
    const item = items.find((i) => i.queueId === queueId);
    items = items.filter((i) => i.queueId !== queueId);
    await persist();
    notify();
    if (item) logger.warn('queue', 'item discarded by user', { kind: item.kind, id: item.id });
  },

  items(): QueueItem[] {
    return [...items];
  },

  counts() {
    return {
      total: items.length,
      pending: items.filter((i) => i.status === 'pending').length,
      sending: items.filter((i) => i.status === 'sending').length,
      failed: items.filter((i) => i.status === 'failed').length,
      reports: items.filter((i) => i.kind === 'report').length,
      sos: items.filter((i) => i.kind === 'sos').length,
    };
  },

  subscribe(fn: (items: QueueItem[]) => void) {
    listeners.add(fn);
    fn([...items]);
    return () => listeners.delete(fn);
  },

  async clear(): Promise<void> {
    items = [];
    await persist();
    notify();
  },
};
