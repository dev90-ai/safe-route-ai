import { logger } from '@/lib/logger';
import { network } from '@/lib/network';
import { localId } from '@/lib/ids';
import { db } from './db';
import { ApiError, toApiError } from './errors';
import { rateLimiter } from './rateLimit';
import type { Profile, Session } from './types';

/**
 * The transport seam.
 *
 * Every endpoint runs through `request`, which does the things a real network
 * boundary does and which the UI must therefore be built to survive: it fails
 * when offline, it takes time, it occasionally errors for no good reason, it
 * enforces rate limits, and it refuses requests without a valid session.
 *
 * When Supabase lands, `request` becomes a thin wrapper over supabase-js and
 * nothing above this file changes.
 */

export type RequestOptions = {
  /** Endpoint label, used for logging, rate-limit buckets and perf spans. */
  name: string;
  /** Requires an authenticated session. Default true. */
  auth?: boolean;
  /** Rate-limit bucket key and subject. */
  limit?: { key: string; subject?: string };
  /** Override the simulated latency band. */
  latency?: [number, number];
  /** Endpoint must succeed even with no connection (reads from local cache). */
  allowOffline?: boolean;
  /** Chance of a synthetic transient failure, 0-1. Default from CONFIG. */
  flakiness?: number;
};

export const CONFIG = {
  /** Baseline simulated latency band in ms. */
  latency: [180, 620] as [number, number],
  /** Extra latency applied when the connection reports "poor". */
  poorConnectionMultiplier: 3.2,
  /** Probability a request fails transiently. Kept low but non-zero. */
  flakiness: 0.02,
  /** Session lifetime. Short, because these devices get lost or seized. */
  sessionTtlMs: 12 * 60 * 60 * 1000,
  /** Idle timeout - re-auth after this long with no activity. */
  idleTimeoutMs: 30 * 60 * 1000,
};

// ---------------------------------------------------------------------------
// Session state (the "Authorization: Bearer" the mock backend checks)
// ---------------------------------------------------------------------------

let currentSession: Session | null = null;
let lastActivityAt = Date.now();

export const auth = {
  setSession(session: Session | null) {
    currentSession = session;
    lastActivityAt = Date.now();
  },

  getSession(): Session | null {
    return currentSession;
  },

  touch() {
    lastActivityAt = Date.now();
  },

  /** Resolve the caller's profile, enforcing expiry. Throws on any problem. */
  requireProfile(): Profile {
    if (!currentSession) {
      throw new ApiError({ kind: 'unauthorized', message: 'no session' });
    }
    if (Date.parse(currentSession.expiresAt) < Date.now()) {
      throw new ApiError({ kind: 'unauthorized', message: 'session expired' });
    }
    if (Date.now() - lastActivityAt > CONFIG.idleTimeoutMs) {
      throw new ApiError({
        kind: 'unauthorized',
        message: 'idle timeout',
        userMessage: 'Signed out after 30 minutes of inactivity. Please sign in again.',
      });
    }
    const profile = db.get().profiles.find((p) => p.id === currentSession!.profileId);
    if (!profile) {
      throw new ApiError({ kind: 'unauthorized', message: 'profile missing for session' });
    }
    if (profile.status !== 'active') {
      throw new ApiError({
        kind: 'forbidden',
        message: 'profile not active',
        userMessage: 'This account has been deactivated. Contact your organisation admin.',
      });
    }
    lastActivityAt = Date.now();
    return profile;
  },
};

/**
 * Role guard, mirroring the RLS policy set.
 *
 * Every mutating endpoint calls this. The rule the whole product rests on -
 * admins manage people but never verify reports, officers verify but never
 * manage the org - is enforced here rather than by hiding buttons.
 */
export function requireRole(profile: Profile, ...roles: Profile['role'][]): void {
  if (!roles.includes(profile.role)) {
    throw new ApiError({
      kind: 'forbidden',
      message: `role ${profile.role} not in [${roles.join(', ')}]`,
      userMessage: `Only a ${roles.map(labelForRole).join(' or ')} can do that.`,
    });
  }
}

function labelForRole(role: Profile['role']): string {
  return role === 'worker' ? 'humanitarian worker' : role === 'officer' ? 'security officer' : 'organisation admin';
}

/** Same-org or cross-share-partner check, mirroring the RLS visibility rule. */
export function assertOrgVisible(profile: Profile, organizationId: string): void {
  if (profile.organizationId === organizationId) return;
  const org = db.get().organizations.find((o) => o.id === profile.organizationId);
  if (org?.crossSharePartners.includes(organizationId)) return;
  throw new ApiError({
    kind: 'forbidden',
    message: 'cross-organization access denied',
    userMessage: 'That belongs to another organisation.',
  });
}

// ---------------------------------------------------------------------------
// Request pipeline
// ---------------------------------------------------------------------------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function simulateLatency(override?: [number, number]): Promise<void> {
  const [min, max] = override ?? CONFIG.latency;
  const base = min + Math.random() * (max - min);
  const quality = network.quality();
  const multiplier = quality === 'poor' ? CONFIG.poorConnectionMultiplier : 1;
  return sleep(Math.round(base * multiplier));
}

export async function request<T>(options: RequestOptions, handler: (profile: Profile | null) => T | Promise<T>): Promise<T> {
  const requestId = localId('req');
  const started = Date.now();

  try {
    await db.init();
    await rateLimiter.ready();

    if (!network.isOnline() && !options.allowOffline) {
      throw new ApiError({
        kind: 'network',
        message: `offline: ${options.name}`,
        requestId,
      });
    }

    if (options.limit) {
      await rateLimiter.consume(options.limit.key, options.limit.subject);
    }

    await simulateLatency(options.latency);

    // Synthetic transient failures. Real networks drop requests; the retry and
    // queue paths need to be exercised in development, not discovered in Wajir.
    const flakiness = options.flakiness ?? CONFIG.flakiness;
    if (flakiness > 0 && Math.random() < flakiness) {
      throw new ApiError({
        kind: Math.random() < 0.5 ? 'timeout' : 'server',
        message: `synthetic transient failure: ${options.name}`,
        requestId,
      });
    }

    const profile = options.auth === false ? null : auth.requireProfile();
    const result = await handler(profile);

    const ms = Date.now() - started;
    logger.debug('api', `${options.name} ok`, { ms, requestId });
    recordPerf(options.name, ms, true);
    return result;
  } catch (e) {
    const error = toApiError(e);
    const ms = Date.now() - started;
    recordPerf(options.name, ms, false);

    // Expected conditions are noise at error level; genuine faults are not.
    const expected = error.kind === 'network' || error.kind === 'validation' || error.kind === 'rate-limited';
    if (expected) logger.warn('api', `${options.name} ${error.kind}`, { ms, requestId });
    else logger.error('api', `${options.name} failed: ${error.message}`, { ms, kind: error.kind, requestId });

    throw error;
  }
}

// Perf samples feed the Diagnostics screen without going through logger.span,
// which would double-count nested calls.
const perfSamples: { name: string; ms: number; ok: boolean; ts: number }[] = [];
function recordPerf(name: string, ms: number, ok: boolean) {
  perfSamples.unshift({ name, ms, ok, ts: Date.now() });
  if (perfSamples.length > 200) perfSamples.length = 200;
}

export function apiStats() {
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

/** Retry with exponential backoff and jitter, for the offline queue. */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: { attempts?: number; baseMs?: number; maxMs?: number } = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const baseMs = opts.baseMs ?? 800;
  const maxMs = opts.maxMs ?? 15_000;

  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      return await fn();
    } catch (e) {
      lastError = e;
      const error = toApiError(e);
      if (!error.retryable || attempt === attempts - 1) throw error;
      const backoff = Math.min(maxMs, baseMs * 2 ** attempt);
      const jitter = backoff * (0.5 + Math.random() * 0.5);
      await sleep(error.retryAfterMs ?? jitter);
    }
  }
  throw toApiError(lastError);
}
