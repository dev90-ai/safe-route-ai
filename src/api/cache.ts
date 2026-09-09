import { logger } from '@/lib/logger';
import { storage } from '@/lib/storage';

/**
 * Stale-while-revalidate cache with disk persistence and tag invalidation.
 *
 * Caching is a safety feature here, not a speed optimisation. A worker who
 * opens the threat map in a dead zone must still see the threats that were
 * verified while they had signal - a blank map reads as "all clear", which is
 * the most dangerous thing this app could ever say.
 *
 *   fresh  (< staleAfter)  -> serve, no refetch
 *   stale  (< maxAge)      -> serve immediately, refetch in background
 *   expired(> maxAge)      -> serve only if offline, and flag it as stale
 */

export type CacheEntry<T> = {
  data: T;
  storedAt: number;
  staleAfter: number;
  maxAge: number;
  tags: string[];
};

export type CachePolicy = {
  /** Serve without revalidating for this long. */
  staleAfter: number;
  /** Keep on disk this long for offline fallback. */
  maxAge: number;
  tags?: string[];
  /** Persist to disk. Off for large or sensitive payloads. */
  persist?: boolean;
};

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Named policies keep cache lifetimes reviewable in one place. */
export const POLICY = {
  /** Rarely changes, and being one org-name stale is harmless. */
  reference: { staleAfter: 30 * MINUTE, maxAge: 30 * 24 * HOUR, persist: true },
  /** Threat data: short freshness, long offline retention. */
  threats: { staleAfter: 45 * SECOND, maxAge: 7 * 24 * HOUR, persist: true },
  /** The officer queue must feel live. */
  queue: { staleAfter: 15 * SECOND, maxAge: 6 * HOUR, persist: true },
  /** Alerts feed - the offline copy is the whole point. */
  feed: { staleAfter: 30 * SECOND, maxAge: 14 * 24 * HOUR, persist: true },
  /** Anything with an active SOS in it. Never trust a cached copy for long. */
  live: { staleAfter: 5 * SECOND, maxAge: 2 * MINUTE, persist: false },
  /** Analytics roll-ups are expensive and tolerant of being a minute old. */
  analytics: { staleAfter: 2 * MINUTE, maxAge: 24 * HOUR, persist: true },
  /** Route analysis for a specific origin/destination pair. */
  routes: { staleAfter: 60 * SECOND, maxAge: 24 * HOUR, persist: true },
} as const satisfies Record<string, CachePolicy>;

const memory = new Map<string, CacheEntry<unknown>>();
const inflight = new Map<string, Promise<unknown>>();
const subscribers = new Set<(key: string) => void>();
const DISK_PREFIX = 'cache.';
let hydrated = false;

const notify = (key: string) => subscribers.forEach((fn) => fn(key));

export type CacheState = 'fresh' | 'stale' | 'expired' | 'miss';

function classify(entry: CacheEntry<unknown> | undefined): CacheState {
  if (!entry) return 'miss';
  const age = Date.now() - entry.storedAt;
  if (age < entry.staleAfter) return 'fresh';
  if (age < entry.maxAge) return 'stale';
  return 'expired';
}

export const cache = {
  /** Load persisted entries once at boot so the first paint can be offline. */
  async hydrate() {
    if (hydrated) return;
    hydrated = true;
    try {
      const keys = await storage.keys(DISK_PREFIX);
      await Promise.all(
        keys.map(async (k) => {
          const entry = await storage.get<CacheEntry<unknown>>(k);
          if (!entry) return;
          if (Date.now() - entry.storedAt > entry.maxAge) {
            await storage.remove(k);
            return;
          }
          memory.set(k.slice(DISK_PREFIX.length), entry);
        }),
      );
      logger.info('cache', 'hydrated from disk', { entries: memory.size });
    } catch (e) {
      logger.capture('cache', e);
    }
  },

  peek<T>(key: string): { data: T | null; state: CacheState; storedAt: number | null } {
    const entry = memory.get(key) as CacheEntry<T> | undefined;
    return { data: entry ? entry.data : null, state: classify(entry), storedAt: entry?.storedAt ?? null };
  },

  set<T>(key: string, data: T, policy: CachePolicy) {
    const entry: CacheEntry<T> = {
      data,
      storedAt: Date.now(),
      staleAfter: policy.staleAfter,
      maxAge: policy.maxAge,
      tags: policy.tags ?? [],
    };
    memory.set(key, entry);
    if (policy.persist) void storage.set(`${DISK_PREFIX}${key}`, entry);
    notify(key);
  },

  /**
   * Deduplicated fetch. Concurrent callers for the same key share one request,
   * which matters when three screens mount at once on a 2G link.
   */
  async fetch<T>(key: string, loader: () => Promise<T>, policy: CachePolicy): Promise<T> {
    const existing = inflight.get(key);
    if (existing) return existing as Promise<T>;

    const promise = loader()
      .then((data) => {
        cache.set(key, data, policy);
        return data;
      })
      .finally(() => {
        inflight.delete(key);
      });

    inflight.set(key, promise);
    return promise;
  },

  invalidate(key: string) {
    memory.delete(key);
    void storage.remove(`${DISK_PREFIX}${key}`);
    notify(key);
  },

  /** Drop everything carrying a tag. How mutations keep lists honest. */
  invalidateTags(...tags: string[]) {
    const set = new Set(tags);
    let dropped = 0;
    for (const [key, entry] of memory.entries()) {
      if (entry.tags.some((t) => set.has(t))) {
        memory.delete(key);
        void storage.remove(`${DISK_PREFIX}${key}`);
        notify(key);
        dropped += 1;
      }
    }
    if (dropped) logger.debug('cache', 'invalidated by tag', { tags, dropped });
  },

  /** Invalidate by key prefix - used for "everything about this report". */
  invalidatePrefix(prefix: string) {
    for (const key of [...memory.keys()]) {
      if (key.startsWith(prefix)) cache.invalidate(key);
    }
  },

  subscribe(fn: (key: string) => void) {
    subscribers.add(fn);
    return () => subscribers.delete(fn);
  },

  async clear() {
    memory.clear();
    inflight.clear();
    const keys = await storage.keys(DISK_PREFIX);
    await Promise.all(keys.map((k) => storage.remove(k)));
  },

  stats() {
    let fresh = 0;
    let stale = 0;
    let expired = 0;
    for (const entry of memory.values()) {
      const state = classify(entry);
      if (state === 'fresh') fresh += 1;
      else if (state === 'stale') stale += 1;
      else expired += 1;
    }
    return { entries: memory.size, fresh, stale, expired, inflight: inflight.size };
  },
};

/** Stable cache keys. Object params are sorted so key order never matters. */
export function cacheKey(name: string, params?: Record<string, unknown>): string {
  if (!params) return name;
  const parts = Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${Array.isArray(v) ? [...v].sort().join('|') : String(v)}`);
  return parts.length ? `${name}?${parts.join('&')}` : name;
}
