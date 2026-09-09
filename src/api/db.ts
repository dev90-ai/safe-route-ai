import { hashSecret } from '@/lib/hash';
import { logger } from '@/lib/logger';
import { storage } from '@/lib/storage';
import type {
  AuditEntry,
  Invite,
  NotificationRecord,
  Organization,
  Profile,
  SafetyAlert,
  Session,
  SosEvent,
  ThreatReport,
} from './types';
import { buildSeed } from './seed';

/**
 * The mock datastore.
 *
 * It stands in for Postgres + Realtime until the Supabase backend lands. Three
 * things it deliberately models rather than fakes:
 *
 *  1. **Row-level security.** Reads go through `endpoints/*`, which apply the
 *     same predicates the RLS policies will. Nothing in the UI is trusted to
 *     scope its own query.
 *  2. **Realtime.** `db.subscribe` mirrors a Supabase channel, so the officer
 *     dashboard and SOS console are already written against push, not polling.
 *  3. **An append-only audit log.** Every state transition is recorded with the
 *     actor, which is what makes the verification chain defensible.
 *
 * Credentials here are hashed rather than compared in plaintext. The hash is a
 * toy - it exists so no seeded password sits in AsyncStorage in the clear, and
 * so the auth code already has the right shape for a real backend.
 */

export type Credential = {
  profileId: string;
  email: string;
  passwordHash: string;
  /** Rolls on every password change; invalidates issued sessions. */
  passwordVersion: number;
  failedAttempts: number;
  lockedUntil: string | null;
  lastSignInAt: string | null;
};

export type VerificationCode = {
  id: string;
  email: string;
  /** Hashed - the six digits are never stored, matching real OTP practice. */
  codeHash: string;
  purpose: 'password-reset' | 'email-verification' | 'sign-in';
  createdAt: string;
  expiresAt: string;
  consumedAt: string | null;
  attempts: number;
  /** Dev affordance: the plaintext the "email" would have contained. */
  devPreview: string;
};

export type DbShape = {
  organizations: Organization[];
  profiles: Profile[];
  credentials: Credential[];
  verificationCodes: VerificationCode[];
  reports: ThreatReport[];
  alerts: SafetyAlert[];
  notifications: NotificationRecord[];
  sosEvents: SosEvent[];
  audit: AuditEntry[];
  invites: Invite[];
  sessions: Session[];
  meta: { seededAt: string; version: number };
};

export type TableName = keyof Omit<DbShape, 'meta'>;

const PERSIST_KEY = 'db.state';
const SCHEMA_VERSION = 1;

let state: DbShape | null = null;
let ready: Promise<void> | null = null;
let saveTimer: ReturnType<typeof setTimeout> | null = null;

type ChangeEvent = { table: TableName; type: 'insert' | 'update' | 'delete'; id: string };
const channels = new Map<string, Set<(e: ChangeEvent) => void>>();

// Re-exported for convenience; defined in lib/hash so seed.ts can use it
// without importing this module and creating a require cycle.
export { hashSecret };

function scheduleSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    if (state) void storage.set(PERSIST_KEY, state);
  }, 400);
}

function emit(event: ChangeEvent) {
  channels.get(event.table)?.forEach((fn) => fn(event));
  channels.get('*')?.forEach((fn) => fn(event));
}

/**
 * Primary key for a row. Most tables key on `id`; sessions key on `token` and
 * credentials on `profileId`, exactly as they will in Postgres.
 */
function rowId(row: unknown): string {
  const r = row as Record<string, unknown>;
  return String(r.id ?? r.token ?? r.profileId ?? '');
}

export const db = {
  async init(): Promise<void> {
    if (ready) return ready;
    ready = (async () => {
      const saved = await storage.get<DbShape>(PERSIST_KEY);
      if (saved && saved.meta?.version === SCHEMA_VERSION) {
        state = saved;
        logger.info('db', 'restored from disk', {
          reports: saved.reports.length,
          profiles: saved.profiles.length,
        });
      } else {
        state = buildSeed();
        logger.info('db', 'seeded fresh dataset', {
          reports: state.reports.length,
          profiles: state.profiles.length,
        });
        scheduleSave();
      }
    })();
    return ready;
  },

  get(): DbShape {
    if (!state) throw new Error('db.init() must complete before access');
    return state;
  },

  table<K extends TableName>(name: K): DbShape[K] {
    return db.get()[name];
  },

  insert<K extends TableName>(name: K, row: DbShape[K][number]): DbShape[K][number] {
    const rows = db.get()[name] as unknown[];
    rows.unshift(row);
    scheduleSave();
    emit({ table: name, type: 'insert', id: rowId(row) });
    return row;
  },

  update<K extends TableName>(
    name: K,
    id: string,
    patch: Partial<DbShape[K][number]>,
  ): DbShape[K][number] | null {
    const rows = db.get()[name] as unknown[];
    const index = rows.findIndex((r) => rowId(r) === id);
    if (index === -1) return null;
    const next = { ...(rows[index] as object), ...patch };
    rows[index] = next;
    scheduleSave();
    emit({ table: name, type: 'update', id });
    return next as DbShape[K][number];
  },

  remove<K extends TableName>(name: K, id: string): boolean {
    const rows = db.get()[name] as unknown[];
    const index = rows.findIndex((r) => rowId(r) === id);
    if (index === -1) return false;
    rows.splice(index, 1);
    scheduleSave();
    emit({ table: name, type: 'delete', id });
    return true;
  },

  find<K extends TableName>(name: K, id: string): DbShape[K][number] | undefined {
    return (db.get()[name] as unknown[]).find((r) => rowId(r) === id) as DbShape[K][number] | undefined;
  },

  /** Realtime channel. `table` may be '*' for everything. */
  subscribe(table: TableName | '*', fn: (e: ChangeEvent) => void): () => void {
    const set = channels.get(table) ?? new Set();
    set.add(fn);
    channels.set(table, set);
    return () => {
      set.delete(fn);
    };
  },

  /** Append-only audit trail. Callers never write to `audit` directly. */
  audit(entry: Omit<AuditEntry, 'id' | 'ts'>): AuditEntry {
    const row: AuditEntry = {
      ...entry,
      id: `aud_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
      ts: new Date().toISOString(),
    };
    db.get().audit.unshift(row);
    // Keep the client-side mirror bounded; the real table is retained server-side.
    if (db.get().audit.length > 800) db.get().audit.length = 800;
    scheduleSave();
    emit({ table: 'audit', type: 'insert', id: row.id });
    return row;
  },

  async reset(): Promise<void> {
    state = buildSeed();
    await storage.set(PERSIST_KEY, state);
    logger.warn('db', 'dataset reset to seed');
    emit({ table: 'reports', type: 'update', id: '*' });
  },

  async flush(): Promise<void> {
    if (saveTimer) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (state) await storage.set(PERSIST_KEY, state);
  },
};
