import { ApiError } from './errors';
import { storage } from '@/lib/storage';

/**
 * Token-bucket rate limiting, enforced inside the mock backend.
 *
 * The real limits will live in Postgres/Edge Functions, but they are modelled
 * here for two reasons: the screens must handle 429 gracefully before the
 * backend exists, and abuse of the sensitive endpoints (OTP request, sign-in,
 * SOS) has a real-world cost - an SMS bill, or an officer's attention.
 *
 * Buckets are persisted so that killing the app does not reset a lockout.
 */

export type LimitRule = {
  /** Bucket capacity: how many calls can burst. */
  capacity: number;
  /** Refill window in ms for a full bucket. */
  windowMs: number;
  /** Extra cooldown applied once the bucket empties. */
  penaltyMs?: number;
};

export const LIMITS = {
  'auth.signIn': { capacity: 5, windowMs: 5 * 60_000, penaltyMs: 60_000 },
  'auth.signUp': { capacity: 3, windowMs: 60 * 60_000 },
  'auth.requestCode': { capacity: 3, windowMs: 15 * 60_000, penaltyMs: 60_000 },
  'auth.verifyCode': { capacity: 6, windowMs: 15 * 60_000, penaltyMs: 5 * 60_000 },
  'auth.resetPassword': { capacity: 5, windowMs: 15 * 60_000 },
  'reports.create': { capacity: 12, windowMs: 60 * 60_000 },
  'reports.verify': { capacity: 60, windowMs: 60_000 },
  'alerts.create': { capacity: 10, windowMs: 60 * 60_000 },
  'sos.trigger': { capacity: 4, windowMs: 10 * 60_000 },
  'routes.analyze': { capacity: 30, windowMs: 5 * 60_000 },
  'invites.create': { capacity: 20, windowMs: 60 * 60_000 },
  default: { capacity: 120, windowMs: 60_000 },
} as const satisfies Record<string, LimitRule>;

export type LimitKey = keyof typeof LIMITS;

type Bucket = { tokens: number; updatedAt: number; blockedUntil: number };

const STORAGE_KEY = 'ratelimit.buckets';
let buckets: Record<string, Bucket> = {};
let hydrated = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;

async function hydrate() {
  if (hydrated) return;
  hydrated = true;
  const saved = await storage.get<Record<string, Bucket>>(STORAGE_KEY);
  if (saved) buckets = { ...saved, ...buckets };
}

function flush() {
  if (flushTimer) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void storage.set(STORAGE_KEY, buckets);
  }, 800);
}

const ruleFor = (key: string): LimitRule => (LIMITS as Record<string, LimitRule>)[key] ?? LIMITS.default;

/** Bucket identity is per-endpoint and per-subject (email, device, or user id). */
const bucketKey = (key: string, subject: string) => `${key}::${subject}`;

export const rateLimiter = {
  async ready() {
    await hydrate();
  },

  /** Peek without spending a token. Used to render "try again in 42s" copy. */
  inspect(key: string, subject = 'device') {
    const rule = ruleFor(key);
    const bucket = buckets[bucketKey(key, subject)];
    if (!bucket) return { remaining: rule.capacity, blockedForMs: 0, capacity: rule.capacity };
    const now = Date.now();
    const refillRate = rule.capacity / rule.windowMs;
    const tokens = Math.min(rule.capacity, bucket.tokens + (now - bucket.updatedAt) * refillRate);
    return {
      remaining: Math.floor(tokens),
      blockedForMs: Math.max(0, bucket.blockedUntil - now),
      capacity: rule.capacity,
    };
  },

  /** Spend a token or throw a 429 carrying the wait time. */
  async consume(key: string, subject = 'device'): Promise<void> {
    await hydrate();
    const rule = ruleFor(key);
    const id = bucketKey(key, subject);
    const now = Date.now();
    const existing = buckets[id] ?? { tokens: rule.capacity, updatedAt: now, blockedUntil: 0 };

    if (existing.blockedUntil > now) {
      throw new ApiError({
        kind: 'rate-limited',
        message: `rate limit cooldown for ${key}`,
        retryAfterMs: existing.blockedUntil - now,
        userMessage: `Too many attempts. Try again in ${Math.ceil((existing.blockedUntil - now) / 1000)}s.`,
      });
    }

    const refillRate = rule.capacity / rule.windowMs;
    const tokens = Math.min(rule.capacity, existing.tokens + (now - existing.updatedAt) * refillRate);

    if (tokens < 1) {
      const waitMs = Math.ceil((1 - tokens) / refillRate);
      const blockedUntil = now + (rule.penaltyMs ?? waitMs);
      buckets[id] = { tokens: 0, updatedAt: now, blockedUntil };
      flush();
      throw new ApiError({
        kind: 'rate-limited',
        message: `rate limit exceeded for ${key}`,
        retryAfterMs: blockedUntil - now,
        userMessage: `Too many attempts. Try again in ${Math.ceil((blockedUntil - now) / 1000)}s.`,
      });
    }

    buckets[id] = { tokens: tokens - 1, updatedAt: now, blockedUntil: 0 };
    flush();
  },

  /** Give a token back when an attempt turns out to have been legitimate. */
  refund(key: string, subject = 'device') {
    const id = bucketKey(key, subject);
    const bucket = buckets[id];
    if (!bucket) return;
    const rule = ruleFor(key);
    buckets[id] = {
      tokens: Math.min(rule.capacity, bucket.tokens + 1),
      updatedAt: Date.now(),
      blockedUntil: 0,
    };
    flush();
  },

  reset(key?: string) {
    if (!key) buckets = {};
    else {
      for (const id of Object.keys(buckets)) if (id.startsWith(`${key}::`)) delete buckets[id];
    }
    flush();
  },
};
