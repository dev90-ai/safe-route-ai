import type { PostgrestError } from '@supabase/supabase-js';

import { logger } from '@/lib/logger';
import { network } from '@/lib/network';
import { ApiError } from '../errors';

/**
 * The Supabase equivalent of the mock's `request` pipeline.
 *
 * Everything above the data layer branches on `ApiError.kind`, never on a
 * message string, so Postgres error codes have to be translated into the same
 * vocabulary the mock produced. Otherwise the offline queue would stop
 * recognising which failures are worth retrying.
 */

/** Postgres SQLSTATE -> the app's error vocabulary. */
function kindFor(error: PostgrestError | null, status?: number): ApiError['kind'] {
  const code = error?.code ?? '';

  if (code === '42501' || code === 'PGRST301') return 'forbidden';   // insufficient_privilege
  if (code === '23514') return 'validation';                          // check_violation
  if (code === '23505') return 'conflict';                            // unique_violation
  if (code === '23503') return 'validation';                          // foreign_key_violation
  if (code === '23502') return 'validation';                          // not_null_violation
  if (code === 'PGRST116') return 'not-found';                        // no rows returned
  if (code === 'P0001') return 'validation';                          // raise exception

  // Malformed input - a bad uuid, a bad date. Retrying cannot fix the payload,
  // and mapping it to a retryable kind puts the offline queue into a loop that
  // never drains. It must park as failed and be surfaced in the Outbox.
  if (code === '22P02') return 'validation';                          // invalid_text_representation
  if (code === '22007' || code === '22008') return 'validation';      // invalid datetime
  if (code === '22003') return 'validation';                          // numeric out of range
  if (code.startsWith('42')) return 'validation';                     // syntax / undefined column

  if (status === 401) return 'unauthorized';
  if (status === 403) return 'forbidden';
  if (status === 404) return 'not-found';
  if (status === 409) return 'conflict';
  if (status === 429) return 'rate-limited';
  if (status && status >= 500) return 'server';

  return 'server';
}

/**
 * RLS denials do not error - they return zero rows. That is correct REST
 * behaviour but a poor experience, so callers that expect a row treat an empty
 * result as forbidden rather than silently showing nothing.
 */
export function deniedOrMissing(message: string): ApiError {
  return new ApiError({
    kind: 'forbidden',
    message,
    userMessage: 'You do not have access to that, or it no longer exists.',
  });
}

export type SupabaseResult = {
  data: unknown;
  error: PostgrestError | null;
  status?: number;
};

/**
 * Run a Supabase query, translating the outcome into the app's error shape and
 * recording it for the Diagnostics screen.
 *
 * The return type defaults to `any` rather than being inferred from the query
 * builder: without a generated Database type, supabase-js infers row types as
 * `never`, which would make every field access an error. The mappers in
 * `mappers.ts` are what actually guarantee shape here. Generating types and
 * tightening this is a worthwhile follow-up.
 */
export async function call<T = any>(name: string, run: () => PromiseLike<SupabaseResult>): Promise<T> {
  const started = Date.now();

  if (!network.isOnline()) {
    recordPerf(name, 0, false);
    throw new ApiError({ kind: 'network', message: `offline: ${name}` });
  }

  let result: SupabaseResult;
  try {
    result = await run();
  } catch (e) {
    // Thrown rather than returned: almost always a transport failure.
    recordPerf(name, Date.now() - started, false);
    const message = e instanceof Error ? e.message : String(e);
    logger.warn('api', `${name} threw`, { message });
    throw new ApiError({
      kind: /network|fetch|timeout|abort/i.test(message) ? 'network' : 'server',
      message,
    });
  }

  const ms = Date.now() - started;

  if (result.error) {
    recordPerf(name, ms, false);
    const kind = kindFor(result.error, result.status);
    const expected = kind === 'validation' || kind === 'forbidden' || kind === 'conflict';

    if (expected) logger.warn('api', `${name} ${kind}`, { ms, code: result.error.code });
    else logger.error('api', `${name} failed: ${result.error.message}`, { ms, code: result.error.code });

    throw new ApiError({
      kind,
      message: result.error.message,
      // Trigger-raised messages are written for humans; database plumbing is not.
      userMessage: result.error.code === 'P0001' || result.error.code === '42501'
        ? result.error.message
        : undefined,
    });
  }

  recordPerf(name, ms, true);
  logger.debug('api', `${name} ok`, { ms });
  return result.data as T;
}

// Shares the Diagnostics performance panel with the mock transport.
const perfSamples: { name: string; ms: number; ok: boolean; ts: number }[] = [];

function recordPerf(name: string, ms: number, ok: boolean) {
  perfSamples.unshift({ name, ms, ok, ts: Date.now() });
  if (perfSamples.length > 200) perfSamples.length = 200;
}

export function supabaseStats() {
  const total = perfSamples.length;
  const failures = perfSamples.filter((s) => !s.ok).length;
  const sorted = perfSamples.map((s) => s.ms).sort((a, b) => a - b);
  const at = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0);

  const byEndpoint = new Map<string, { count: number; totalMs: number; failures: number }>();
  for (const sample of perfSamples) {
    const entry = byEndpoint.get(sample.name) ?? { count: 0, totalMs: 0, failures: 0 };
    entry.count += 1;
    entry.totalMs += sample.ms;
    if (!sample.ok) entry.failures += 1;
    byEndpoint.set(sample.name, entry);
  }

  return {
    total,
    failures,
    errorRate: total ? failures / total : 0,
    p50: at(0.5),
    p95: at(0.95),
    p99: at(0.99),
    endpoints: [...byEndpoint.entries()]
      .map(([name, e]) => ({ name, count: e.count, avgMs: Math.round(e.totalMs / e.count), failures: e.failures }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 12),
  };
}

/** A row as it arrives from PostgREST, before the mappers give it shape. */
export type Row = Record<string, any>;
