import type { RealtimeChannel } from '@supabase/supabase-js';

import { logger } from '@/lib/logger';
import { db, type TableName } from './db';
import { API_MODE, supabase } from './supabase/client';

/**
 * One realtime abstraction over both transports.
 *
 * The mock's `db.subscribe` and a Supabase realtime channel have the same job -
 * tell me when this table changed - so the app subscribes through here and
 * never learns which one is running. That is what let the officer queue and the
 * SOS console be written against push from the very first day.
 */

export type ChangeEvent = {
  table: TableName;
  type: 'insert' | 'update' | 'delete';
  id: string;
};

/** Mock table name -> Postgres table name. */
const POSTGRES_TABLE: Record<TableName, string | null> = {
  organizations: 'organizations',
  profiles: 'profiles',
  reports: 'threat_reports',
  alerts: 'safety_alerts',
  notifications: 'notifications',
  sosEvents: 'sos_events',
  audit: 'audit_log',
  invites: 'invites',
  credentials: null,
  verificationCodes: null,
  sessions: null,
};

export function subscribe(table: TableName, onChange: (event: ChangeEvent) => void): () => void {
  if (API_MODE !== 'supabase') return db.subscribe(table, onChange);

  const pgTable = POSTGRES_TABLE[table];
  if (!pgTable) return () => {};

  let channel: RealtimeChannel | null = null;

  try {
    channel = supabase()
      .channel(`sra:${pgTable}:${Math.random().toString(36).slice(2, 8)}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: pgTable },
        (payload: { eventType: string; new?: Record<string, unknown>; old?: Record<string, unknown> }) => {
          const row = payload.new ?? payload.old ?? {};
          onChange({
            table,
            type:
              payload.eventType === 'INSERT'
                ? 'insert'
                : payload.eventType === 'DELETE'
                  ? 'delete'
                  : 'update',
            id: String(row.id ?? ''),
          });
        },
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          // Not fatal: every screen still polls and refreshes on focus, so a
          // dead channel degrades to slower updates rather than stale ones.
          logger.warn('realtime', `channel ${pgTable} ${status}`);
        }
      });
  } catch (e) {
    logger.capture('realtime', e, { table: pgTable });
    return () => {};
  }

  return () => {
    if (channel) void supabase().removeChannel(channel);
  };
}
