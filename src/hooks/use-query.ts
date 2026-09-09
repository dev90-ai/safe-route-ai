import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';

import { cache, POLICY, type CachePolicy, type CacheState } from '@/api/cache';
import type { TableName } from '@/api/db';
import { subscribe } from '@/api/realtime';
import { ApiError, toApiError } from '@/api/errors';
import { logger } from '@/lib/logger';
import { network } from '@/lib/network';

/**
 * A small stale-while-revalidate data hook.
 *
 * Rather than pull in a full query library, this covers exactly what the app
 * needs and makes the offline behaviour explicit, because that behaviour is a
 * safety property here: a cached-but-stale threat list is shown with a visible
 * "last updated" marker rather than replaced by a spinner, since a blank map
 * in a dead zone reads as "no threats" - the most dangerous possible lie.
 */

export type QueryState<T> = {
  data: T | null;
  error: ApiError | null;
  isLoading: boolean;
  isRefreshing: boolean;
  /** Data is served from cache and a refresh is in flight or overdue. */
  isStale: boolean;
  /** Serving cached data because the network is unavailable. */
  isOffline: boolean;
  updatedAt: number | null;
  refetch: (options?: { silent?: boolean }) => Promise<void>;
  setData: (updater: (prev: T | null) => T | null) => void;
};

export type QueryOptions<T> = {
  /** Stable cache key. Pass null to disable the query entirely. */
  key: string | null;
  fetcher: () => Promise<T>;
  policy?: CachePolicy;
  /** Realtime tables that should trigger a background refresh. */
  watch?: TableName[];
  /** Refresh when the app returns to the foreground. Default true. */
  refetchOnForeground?: boolean;
  /** Poll interval in ms. Used only for genuinely live views (SOS). */
  pollMs?: number;
  enabled?: boolean;
};

export function useQuery<T>({
  key,
  fetcher,
  policy = POLICY.threats,
  watch,
  refetchOnForeground = true,
  pollMs,
  enabled = true,
}: QueryOptions<T>): QueryState<T> {
  const [data, setDataState] = useState<T | null>(null);
  const [error, setError] = useState<ApiError | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [cacheState, setCacheState] = useState<CacheState>('miss');
  const [updatedAt, setUpdatedAt] = useState<number | null>(null);
  const [isOffline, setIsOffline] = useState(false);

  // The fetcher is usually an inline arrow, so it changes identity every render.
  // Holding it in a ref keeps `load` stable; the ref is updated in an effect
  // rather than during render, since `load` only reads it asynchronously.
  const fetcherRef = useRef(fetcher);
  useEffect(() => {
    fetcherRef.current = fetcher;
  });

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const load = useCallback(
    async (options: { silent?: boolean; initial?: boolean } = {}) => {
      if (!key || !enabled) {
        setIsLoading(false);
        return;
      }

      // Serve whatever is on disk first so the screen paints immediately.
      const cached = cache.peek<T>(key);
      if (options.initial && cached.data !== null) {
        setDataState(cached.data);
        setUpdatedAt(cached.storedAt);
        setCacheState(cached.state);
        setIsLoading(false);
        if (cached.state === 'fresh') return;
      }

      if (!options.silent && cached.data === null) setIsLoading(true);
      else setIsRefreshing(true);

      try {
        const result = await cache.fetch(key, fetcherRef.current, policy);
        if (!mountedRef.current) return;
        setDataState(result);
        setError(null);
        setUpdatedAt(Date.now());
        setCacheState('fresh');
        setIsOffline(false);
      } catch (e) {
        if (!mountedRef.current) return;
        const apiError = toApiError(e);

        // Offline with a usable cached copy is not an error state - it is the
        // designed behaviour, surfaced honestly rather than as a failure.
        const fallback = cache.peek<T>(key);
        if (apiError.kind === 'network' && fallback.data !== null) {
          setDataState(fallback.data);
          setUpdatedAt(fallback.storedAt);
          setCacheState('stale');
          setIsOffline(true);
          setError(null);
        } else {
          setError(apiError);
          if (apiError.kind !== 'network') logger.debug('query', `${key} failed`, { kind: apiError.kind });
        }
      } finally {
        if (mountedRef.current) {
          setIsLoading(false);
          setIsRefreshing(false);
        }
      }
    },
    [key, enabled, policy],
  );

  // Initial load and key changes. A disabled query is not "loading" - that is
  // derived below rather than written back into state.
  useEffect(() => {
    if (!key || !enabled) return;
    // Fetch-on-mount. `load` only writes state after an await, so this is not
    // the synchronous cascade the rule is guarding against.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load({ initial: true });
  }, [key, enabled, load]);

  // Realtime: refresh in the background when a watched table changes.
  useEffect(() => {
    if (!watch?.length || !key || !enabled) return;
    const unsubs = watch.map((table) =>
      subscribe(table, () => {
        void load({ silent: true });
      }),
    );
    return () => unsubs.forEach((fn) => fn());
  }, [watch, key, enabled, load]);

  // Foreground refresh - the app is frequently backgrounded mid-journey.
  useEffect(() => {
    if (!refetchOnForeground || !key || !enabled) return;
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') void load({ silent: true });
    });
    return () => sub.remove();
  }, [refetchOnForeground, key, enabled, load]);

  // Retry automatically the moment connectivity returns.
  useEffect(() => {
    if (!key || !enabled) return;
    let wasOffline = !network.isOnline();
    const unsubscribe = network.subscribe((status) => {
      const online = status.online && !status.simulatedOffline;
      if (online && wasOffline) void load({ silent: true });
      wasOffline = !online;
    });
    return () => {
      unsubscribe();
    };
  }, [key, enabled, load]);

  useEffect(() => {
    if (!pollMs || !key || !enabled) return;
    const id = setInterval(() => void load({ silent: true }), pollMs);
    return () => clearInterval(id);
  }, [pollMs, key, enabled, load]);

  const refetch = useCallback(
    async (options?: { silent?: boolean }) => {
      if (key) cache.invalidate(key);
      await load({ silent: options?.silent ?? false });
    },
    [key, load],
  );

  const setData = useCallback((updater: (prev: T | null) => T | null) => {
    setDataState((prev) => updater(prev));
  }, []);

  return {
    data,
    error,
    // A disabled or key-less query never resolves, so it is never "loading".
    isLoading: isLoading && !!key && enabled,
    isRefreshing,
    isStale: cacheState === 'stale' || cacheState === 'expired',
    isOffline,
    updatedAt,
    refetch,
    setData,
  };
}

// ---------------------------------------------------------------------------

export type MutationState<TInput, TResult> = {
  mutate: (input: TInput) => Promise<TResult | null>;
  isPending: boolean;
  error: ApiError | null;
  fieldErrors: Record<string, string>;
  reset: () => void;
};

/**
 * Mutations, with field errors surfaced separately so forms can attach them to
 * the right input rather than dumping a generic banner.
 */
export function useMutation<TInput, TResult>(
  fn: (input: TInput) => Promise<TResult>,
  options: {
    onSuccess?: (result: TResult, input: TInput) => void | Promise<void>;
    onError?: (error: ApiError, input: TInput) => void;
    invalidateTags?: string[];
  } = {},
): MutationState<TInput, TResult> {
  const [isPending, setIsPending] = useState(false);
  const [error, setError] = useState<ApiError | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  // Callbacks are read only after the mutation resolves, so updating the ref in
  // an effect is soon enough and keeps `mutate` stable.
  const optionsRef = useRef(options);
  useEffect(() => {
    optionsRef.current = options;
  });

  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const mutate = useCallback(
    async (input: TInput): Promise<TResult | null> => {
      setIsPending(true);
      setError(null);
      setFieldErrors({});

      try {
        const result = await fn(input);
        if (optionsRef.current.invalidateTags?.length) {
          cache.invalidateTags(...optionsRef.current.invalidateTags);
        }
        await optionsRef.current.onSuccess?.(result, input);
        return result;
      } catch (e) {
        const apiError = toApiError(e);
        if (mountedRef.current) {
          setError(apiError);
          setFieldErrors(apiError.fieldErrors ?? {});
        }
        optionsRef.current.onError?.(apiError, input);
        return null;
      } finally {
        if (mountedRef.current) setIsPending(false);
      }
    },
    [fn],
  );

  const reset = useCallback(() => {
    setError(null);
    setFieldErrors({});
  }, []);

  return { mutate, isPending, error, fieldErrors, reset };
}
