import * as Crypto from 'expo-crypto';

/**
 * Client-generated identifiers.
 *
 * Reports are created offline, so the client - not the server - mints the id.
 * That id doubles as the idempotency key: if a queued submission is retried
 * after a timeout, the server sees the same id and stores it once.
 */
export function uuid(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    // randomUUID needs a secure context; fall back for older web hosts.
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }
}

/** Short, human-quotable reference shown on reports: "SR-4F2A9C". */
export function shortRef(id: string, prefix = 'SR'): string {
  const clean = id.replace(/[^a-zA-Z0-9]/g, '').toUpperCase();
  return `${prefix}-${clean.slice(0, 6)}`;
}

let sequence = 0;
/** Monotonic local id for ephemeral UI objects (toasts, queue items). */
export function localId(prefix = 'id'): string {
  sequence += 1;
  return `${prefix}_${Date.now().toString(36)}_${sequence.toString(36)}`;
}
