/**
 * Client-side observability.
 *
 * This is the seam a real crash/APM reporter (Sentry, Bugsnag) plugs into. It
 * keeps a bounded in-memory ring buffer of breadcrumbs and errors, mirrors them
 * to disk so a crash on a device in the field is still inspectable afterwards,
 * and exposes them to the in-app Diagnostics screen.
 *
 * Two rules it enforces on our behalf:
 *   1. Nothing is logged verbatim - every payload passes through `redact`, so
 *      passwords, OTP codes, tokens and precise coordinates never land in a log.
 *   2. The buffer is bounded, so a logging loop cannot exhaust device memory.
 */

import { storage } from './storage';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogEntry = {
  id: string;
  ts: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: Record<string, unknown>;
};

export type PerfEntry = {
  name: string;
  ms: number;
  ts: number;
  ok: boolean;
};

const MAX_ENTRIES = 300;
const MAX_PERF = 120;
const PERSIST_KEY = 'diagnostics.log';
const SENSITIVE = /(password|passcode|token|secret|otp|code|authorization|pin|session)/i;

let buffer: LogEntry[] = [];
let perf: PerfEntry[] = [];
let counter = 0;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

const listeners = new Set<() => void>();

const notify = () => listeners.forEach((fn) => fn());

/** Strip or mask anything that must never appear in a log line. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 4) return '[deep]';
  if (value == null) return value;
  if (typeof value === 'string') return value.length > 300 ? `${value.slice(0, 300)}...` : value;
  if (typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((v) => redact(v, depth + 1));

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SENSITIVE.test(k)) {
      out[k] = '[redacted]';
    } else if (k === 'lat' || k === 'lng' || k === 'latitude' || k === 'longitude') {
      // Coarsen coordinates to ~1km so logs cannot re-identify a reporter.
      out[k] = typeof v === 'number' ? Number(v.toFixed(2)) : v;
    } else {
      out[k] = redact(v, depth + 1);
    }
  }
  return out;
}

function push(level: LogLevel, scope: string, message: string, data?: Record<string, unknown>) {
  const entry: LogEntry = {
    id: `log_${Date.now().toString(36)}_${(counter += 1).toString(36)}`,
    ts: Date.now(),
    level,
    scope,
    message,
    data: data ? (redact(data) as Record<string, unknown>) : undefined,
  };

  buffer = [entry, ...buffer].slice(0, MAX_ENTRIES);
  notify();

  if (__DEV__) {
    const line = `[${scope}] ${message}`;
    if (level === 'error') console.error(line, entry.data ?? '');
    else if (level === 'warn') console.warn(line, entry.data ?? '');
    else if (level === 'info') console.log(line, entry.data ?? '');
  }

  if (level === 'error' || level === 'warn') schedulePersist();
}

function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void storage.set(PERSIST_KEY, buffer.slice(0, 80));
  }, 1500);
}

export const logger = {
  debug: (scope: string, message: string, data?: Record<string, unknown>) => push('debug', scope, message, data),
  info: (scope: string, message: string, data?: Record<string, unknown>) => push('info', scope, message, data),
  warn: (scope: string, message: string, data?: Record<string, unknown>) => push('warn', scope, message, data),
  error: (scope: string, message: string, data?: Record<string, unknown>) => push('error', scope, message, data),

  /** Capture a thrown value with its stack, without leaking the payload. */
  capture(scope: string, err: unknown, context?: Record<string, unknown>) {
    const message = err instanceof Error ? err.message : String(err);
    push('error', scope, message, {
      ...context,
      stack: err instanceof Error ? err.stack?.split('\n').slice(0, 6).join('\n') : undefined,
    });
  },

  /** Time an async span and record it for the performance panel. */
  async span<T>(name: string, fn: () => Promise<T>): Promise<T> {
    const started = Date.now();
    try {
      const result = await fn();
      perf = [{ name, ms: Date.now() - started, ts: started, ok: true }, ...perf].slice(0, MAX_PERF);
      return result;
    } catch (err) {
      perf = [{ name, ms: Date.now() - started, ts: started, ok: false }, ...perf].slice(0, MAX_PERF);
      throw err;
    } finally {
      notify();
    }
  },

  entries: () => buffer,
  perfEntries: () => perf,

  subscribe(fn: () => void) {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },

  async hydrate() {
    const saved = await storage.get<LogEntry[]>(PERSIST_KEY);
    if (saved?.length) {
      buffer = [...buffer, ...saved].slice(0, MAX_ENTRIES);
      notify();
    }
  },

  clear() {
    buffer = [];
    perf = [];
    void storage.remove(PERSIST_KEY);
    notify();
  },

  /** Rolled-up counters for the Diagnostics screen. */
  summary() {
    const errors = buffer.filter((e) => e.level === 'error').length;
    const warnings = buffer.filter((e) => e.level === 'warn').length;
    const durations = perf.map((p) => p.ms).sort((a, b) => a - b);
    const p50 = durations.length ? durations[Math.floor(durations.length * 0.5)] : 0;
    const p95 = durations.length ? durations[Math.floor(durations.length * 0.95)] : 0;
    const failures = perf.filter((p) => !p.ok).length;
    return {
      errors,
      warnings,
      requests: perf.length,
      failures,
      p50,
      p95,
      errorRate: perf.length ? failures / perf.length : 0,
    };
  },
};
