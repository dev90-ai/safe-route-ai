import { localId } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { parseOrThrow, sanitizeText, sosResolveSchema, sosTriggerSchema } from '@/lib/validation';
import { ApiError } from '../errors';
import { rateLimiter } from '../rateLimit';
import type { SosEvent, SosTimelineEntry } from '../types';
import { call, deniedOrMissing } from './call';
import { supabase } from './client';
import { mapSosEvent } from './mappers';

/**
 * SOS.
 *
 * `track` and `timeline` are jsonb arrays, so appends are read-modify-write.
 * That is a deliberate trade: one row, one realtime payload, no join on the
 * path that matters most. At the volumes involved - one event, a few hundred
 * pings - the lost-update risk is negligible next to the latency saved.
 */

const SELECT = '*, lat, lng';

function entry(kind: SosTimelineEntry['kind'], text: string, actorId: string | null = null): SosTimelineEntry {
  return { id: localId('sostl'), ts: new Date().toISOString(), actorId, kind, text };
}

async function currentUser(): Promise<{ id: string; organizationId: string; fullName: string }> {
  const { data } = await supabase().auth.getUser();
  if (!data.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

  const row = await call('sos.me', () =>
    supabase().from('profiles').select('id, organization_id, full_name').eq('id', data.user!.id).maybeSingle(),
  );
  if (!row) throw deniedOrMissing('profile');
  return { id: row.id, organizationId: row.organization_id, fullName: row.full_name };
}

export const supabaseSosApi = {
  async trigger(input: unknown, options: { clientId?: string; queuedOffline?: boolean } = {}): Promise<SosEvent> {
    const data = parseOrThrow(sosTriggerSchema, input);
    await rateLimiter.consume('sos.trigger');

    const me = await currentUser();
    const now = new Date().toISOString();

    // A partial unique index enforces one live event per worker, so a second
    // tap escalates the existing one rather than fragmenting the officer's view.
    const existing = await call('sos.existing', () =>
      supabase()
        .from('sos_events')
        .select(SELECT)
        .eq('worker_id', me.id)
        .in('status', ['active', 'acknowledged'])
        .maybeSingle(),
    );

    if (existing) {
      const event = mapSosEvent(existing);
      const updated = await call('sos.reTrigger', () =>
        supabase()
          .from('sos_events')
          .update({
            location: `SRID=4326;POINT(${data.location.lng} ${data.location.lat})`,
            accuracy_meters: data.accuracyMeters,
            track: [...event.track, { point: data.location, ts: now, accuracyMeters: data.accuracyMeters }],
            timeline: [...event.timeline, entry('note', 'SOS re-triggered by the worker.', me.id)],
          })
          .eq('id', event.id)
          .select(SELECT)
          .maybeSingle(),
      );
      return mapSosEvent(updated ?? existing);
    }

    const timeline: SosTimelineEntry[] = [entry('triggered', `SOS triggered by ${me.fullName}.`, me.id)];
    if (options.queuedOffline) {
      timeline.push(entry('queued-offline', 'No connectivity - SOS held in the local queue.'));
      timeline.push(entry('synced', 'Connectivity restored - SOS delivered to officers.'));
    }

    const row = await call('sos.trigger', () =>
      supabase()
        .from('sos_events')
        .insert({
          ...(options.clientId ? { id: options.clientId } : {}),
          worker_id: me.id,
          organization_id: me.organizationId,
          status: 'active',
          reason: data.reason ? sanitizeText(data.reason) : null,
          location: `SRID=4326;POINT(${data.location.lng} ${data.location.lat})`,
          accuracy_meters: data.accuracyMeters,
          track: [{ point: data.location, ts: now, accuracyMeters: data.accuracyMeters }],
          timeline,
        })
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) throw deniedOrMissing('sos insert rejected');

    logger.warn('sos', 'SOS triggered', { id: row.id, queuedOffline: options.queuedOffline ?? false });
    return mapSosEvent(row);
  },

  /** Best-effort position ping. A dropped one must never invalidate the event. */
  async pushLocation(sosId: string, location: { lat: number; lng: number }, accuracyMeters: number | null): Promise<void> {
    const current = await call('sos.trackRead', () =>
      supabase().from('sos_events').select('track, status').eq('id', sosId).maybeSingle(),
    );

    if (!current || current.status === 'resolved' || current.status === 'cancelled') return;

    const track = [
      ...(current.track ?? []),
      { point: location, ts: new Date().toISOString(), accuracyMeters },
    ].slice(-240); // bounded: a long incident must not grow without limit

    await call('sos.pushLocation', () =>
      supabase()
        .from('sos_events')
        .update({
          location: `SRID=4326;POINT(${location.lng} ${location.lat})`,
          accuracy_meters: accuracyMeters,
          track,
        })
        .eq('id', sosId)
        .select('id')
        .maybeSingle(),
    );
  },

  async acknowledge(sosId: string): Promise<SosEvent> {
    const me = await currentUser();
    const current = await call('sos.get', () =>
      supabase().from('sos_events').select(SELECT).eq('id', sosId).maybeSingle(),
    );
    if (!current) throw deniedOrMissing('sos event');

    const event = mapSosEvent(current);
    const row = await call('sos.acknowledge', () =>
      supabase()
        .from('sos_events')
        .update({
          status: 'acknowledged',
          acknowledged_by: me.id,
          acknowledged_at: new Date().toISOString(),
          timeline: [...event.timeline, entry('acknowledged', `Acknowledged by ${me.fullName}.`, me.id)],
        })
        .eq('id', sosId)
        .eq('status', 'active')
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'conflict',
        message: 'not active',
        userMessage: 'This SOS has already been acknowledged or resolved.',
      });
    }
    return mapSosEvent(row);
  },

  async addNote(sosId: string, note: string): Promise<SosEvent> {
    const me = await currentUser();
    const text = sanitizeText(note);
    if (text.length < 3) {
      throw new ApiError({ kind: 'validation', message: 'note too short', fieldErrors: { note: 'Add a short note' } });
    }

    const current = await call('sos.get', () =>
      supabase().from('sos_events').select(SELECT).eq('id', sosId).maybeSingle(),
    );
    if (!current) throw deniedOrMissing('sos event');

    const event = mapSosEvent(current);
    const row = await call('sos.addNote', () =>
      supabase()
        .from('sos_events')
        .update({ timeline: [...event.timeline, entry('note', text, me.id)] })
        .eq('id', sosId)
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) throw deniedOrMissing('note rejected');
    return mapSosEvent(row);
  },

  async resolve(input: unknown): Promise<SosEvent> {
    const data = parseOrThrow(sosResolveSchema, input);
    const me = await currentUser();
    const note = sanitizeText(data.note);

    const current = await call('sos.get', () =>
      supabase().from('sos_events').select(SELECT).eq('id', data.sosId).maybeSingle(),
    );
    if (!current) throw deniedOrMissing('sos event');

    const event = mapSosEvent(current);
    const row = await call('sos.resolve', () =>
      supabase()
        .from('sos_events')
        .update({
          status: 'resolved',
          resolved_by: me.id,
          resolved_at: new Date().toISOString(),
          resolution_note: note,
          timeline: [...event.timeline, entry('resolved', `Resolved: ${note}`, me.id)],
        })
        .eq('id', data.sosId)
        .neq('status', 'resolved')
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) throw new ApiError({ kind: 'conflict', message: 'already resolved' });
    return mapSosEvent(row);
  },

  /** Only the person who raised it can stand it down. */
  async cancel(sosId: string, reason: string): Promise<SosEvent> {
    const me = await currentUser();
    const current = await call('sos.get', () =>
      supabase().from('sos_events').select(SELECT).eq('id', sosId).maybeSingle(),
    );
    if (!current) throw deniedOrMissing('sos event');

    const event = mapSosEvent(current);
    const text = sanitizeText(reason) || 'Stood down by the worker.';

    const row = await call('sos.cancel', () =>
      supabase()
        .from('sos_events')
        .update({
          status: 'cancelled',
          resolved_at: new Date().toISOString(),
          resolution_note: text,
          timeline: [...event.timeline, entry('cancelled', `Stood down by ${me.fullName}: ${text}`, me.id)],
        })
        .eq('id', sosId)
        .eq('worker_id', me.id)
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'cancel rejected',
        userMessage: 'Only the person who raised this SOS can stand it down. An officer resolves it instead.',
      });
    }
    return mapSosEvent(row);
  },

  async active(): Promise<SosEvent[]> {
    const rows = await call('sos.active', () =>
      supabase()
        .from('sos_events')
        .select(SELECT)
        .in('status', ['active', 'acknowledged'])
        .order('created_at', { ascending: true }),
    );
    return (rows ?? []).map(mapSosEvent);
  },

  async history(limit = 40): Promise<SosEvent[]> {
    const rows = await call('sos.history', () =>
      supabase().from('sos_events').select(SELECT).order('created_at', { ascending: false }).limit(limit),
    );
    return (rows ?? []).map(mapSosEvent);
  },

  async get(sosId: string): Promise<SosEvent> {
    const row = await call('sos.get', () =>
      supabase().from('sos_events').select(SELECT).eq('id', sosId).maybeSingle(),
    );
    if (!row) throw deniedOrMissing('sos event');
    return mapSosEvent(row);
  },

  async mine(): Promise<SosEvent | null> {
    const { data } = await supabase().auth.getUser();
    if (!data.user) return null;

    const row = await call('sos.mine', () =>
      supabase()
        .from('sos_events')
        .select(SELECT)
        .eq('worker_id', data.user!.id)
        .in('status', ['active', 'acknowledged'])
        .maybeSingle(),
    );
    return row ? mapSosEvent(row) : null;
  },
};
