import { localId, uuid } from '@/lib/ids';
import { logger } from '@/lib/logger';
import { parseOrThrow, sanitizeText, sosResolveSchema, sosTriggerSchema } from '@/lib/validation';
import { assertOrgVisible, request, requireRole } from '../client';
import { cache } from '../cache';
import { db } from '../db';
import { ApiError } from '../errors';
import type { Profile, SosEvent, SosTimelineEntry } from '../types';
import { API_MODE } from '../supabase/client';
import { supabaseSosApi } from '../supabase/sos';

/**
 * SOS.
 *
 * The design constraint that shapes everything here: the person triggering this
 * may have seconds, one hand, and no signal. So the client mints the event id
 * before it has connectivity, the trigger is idempotent on that id, and every
 * subsequent location update is best-effort and independently retryable. A
 * dropped location ping must never invalidate an active SOS.
 */

function timelineEntry(kind: SosTimelineEntry['kind'], text: string, actorId: string | null = null): SosTimelineEntry {
  return { id: localId('sostl'), ts: new Date().toISOString(), actorId, kind, text };
}

function visibleSosFor(profile: Profile): SosEvent[] {
  const all = db.table('sosEvents');
  if (profile.role === 'worker') return all.filter((e) => e.workerId === profile.id);
  // Officers see their own organisation's events. SOS is deliberately NOT
  // cross-shared: a live location is the most sensitive datum in the system.
  return all.filter((e) => e.organizationId === profile.organizationId);
}

const mockSosApi = {
  /**
   * Raise an SOS. `clientId` is generated on-device so an offline trigger that
   * syncs later cannot become a second event.
   */
  async trigger(input: unknown, options: { clientId?: string; queuedOffline?: boolean } = {}): Promise<SosEvent> {
    const data = parseOrThrow(sosTriggerSchema, input);

    return request({ name: 'sos.trigger', limit: { key: 'sos.trigger' }, flakiness: 0 }, (profile) => {
      requireRole(profile!, 'worker', 'officer');

      const id = options.clientId ?? uuid();
      const existing = db.find('sosEvents', id);
      if (existing) {
        logger.info('sos', 'idempotent trigger replay ignored', { id });
        return existing;
      }

      // One live event per person. A second tap escalates the existing one
      // rather than fragmenting the officer's view across two cards.
      const active = db
        .table('sosEvents')
        .find((e) => e.workerId === profile!.id && (e.status === 'active' || e.status === 'acknowledged'));
      if (active) {
        const updated = db.update('sosEvents', active.id, {
          location: data.location,
          accuracyMeters: data.accuracyMeters,
          track: [...active.track, { point: data.location, ts: new Date().toISOString(), accuracyMeters: data.accuracyMeters }],
          timeline: [...active.timeline, timelineEntry('note', 'SOS re-triggered by the worker.', profile!.id)],
        })!;
        cache.invalidateTags('sos');
        return updated;
      }

      const now = new Date().toISOString();
      const timeline: SosTimelineEntry[] = [];
      if (options.queuedOffline) {
        timeline.push(timelineEntry('queued-offline', 'No connectivity - SOS held in the local queue.', null));
        timeline.push(timelineEntry('synced', 'Connectivity restored - SOS delivered to officers.', null));
      }
      timeline.unshift(timelineEntry('triggered', `SOS triggered by ${profile!.fullName}.`, profile!.id));

      const event: SosEvent = {
        id,
        workerId: profile!.id,
        organizationId: profile!.organizationId,
        status: 'active',
        reason: data.reason ? sanitizeText(data.reason) : null,
        location: data.location,
        accuracyMeters: data.accuracyMeters,
        track: [{ point: data.location, ts: now, accuracyMeters: data.accuracyMeters }],
        createdAt: now,
        acknowledgedBy: null,
        acknowledgedAt: null,
        resolvedBy: null,
        resolvedAt: null,
        resolutionNote: null,
        timeline,
      };

      db.insert('sosEvents', event);
      db.update('profiles', profile!.id, { lastKnownLocation: data.location, lastSeenAt: now });

      db.audit({
        actorId: profile!.id,
        actorRole: profile!.role,
        organizationId: profile!.organizationId,
        action: 'sos.triggered',
        entity: 'sos',
        entityId: id,
        summary: `${profile!.fullName} triggered an SOS${data.reason ? `: ${data.reason}` : ''}.`,
      });

      logger.warn('sos', 'SOS triggered', { id, queuedOffline: options.queuedOffline ?? false });
      cache.invalidateTags('sos');
      return event;
    });
  },

  /** Best-effort position ping while an event is live. */
  async pushLocation(sosId: string, location: { lat: number; lng: number }, accuracyMeters: number | null): Promise<void> {
    return request({ name: 'sos.pushLocation', latency: [60, 220], flakiness: 0 }, (profile) => {
      const event = db.find('sosEvents', sosId);
      if (!event) throw new ApiError({ kind: 'not-found', message: 'sos event' });
      if (event.workerId !== profile!.id) {
        throw new ApiError({ kind: 'forbidden', message: 'not your sos event' });
      }
      if (event.status === 'resolved' || event.status === 'cancelled') return;

      const track = [...event.track, { point: location, ts: new Date().toISOString(), accuracyMeters }];
      db.update('sosEvents', sosId, {
        location,
        accuracyMeters,
        // Bound the track so a long incident cannot grow without limit.
        track: track.slice(-240),
      });
      db.update('profiles', profile!.id, { lastKnownLocation: location, lastSeenAt: new Date().toISOString() });
      cache.invalidateTags('sos');
    });
  },

  async acknowledge(sosId: string): Promise<SosEvent> {
    return request({ name: 'sos.acknowledge', flakiness: 0 }, (profile) => {
      requireRole(profile!, 'officer');
      const event = db.find('sosEvents', sosId);
      if (!event) throw new ApiError({ kind: 'not-found', message: 'sos event' });
      assertOrgVisible(profile!, event.organizationId);
      if (event.status !== 'active') {
        throw new ApiError({
          kind: 'conflict',
          message: 'not active',
          userMessage: `This SOS is already ${event.status}.`,
        });
      }

      const now = new Date().toISOString();
      const updated = db.update('sosEvents', sosId, {
        status: 'acknowledged',
        acknowledgedBy: profile!.id,
        acknowledgedAt: now,
        timeline: [...event.timeline, timelineEntry('acknowledged', `Acknowledged by ${profile!.fullName}.`, profile!.id)],
      })!;

      db.audit({
        actorId: profile!.id,
        actorRole: 'officer',
        organizationId: event.organizationId,
        action: 'sos.acknowledged',
        entity: 'sos',
        entityId: sosId,
        summary: `${profile!.fullName} acknowledged the SOS.`,
      });

      cache.invalidateTags('sos');
      return updated;
    });
  },

  /** Officer note appended to the live timeline. Visible to the worker. */
  async addNote(sosId: string, note: string): Promise<SosEvent> {
    return request({ name: 'sos.addNote', flakiness: 0 }, (profile) => {
      requireRole(profile!, 'officer');
      const event = db.find('sosEvents', sosId);
      if (!event) throw new ApiError({ kind: 'not-found', message: 'sos event' });
      assertOrgVisible(profile!, event.organizationId);

      const text = sanitizeText(note);
      if (text.length < 3) {
        throw new ApiError({ kind: 'validation', message: 'note too short', fieldErrors: { note: 'Add a short note' } });
      }

      const updated = db.update('sosEvents', sosId, {
        timeline: [...event.timeline, timelineEntry('note', text, profile!.id)],
      })!;

      db.audit({
        actorId: profile!.id,
        actorRole: 'officer',
        organizationId: event.organizationId,
        action: 'sos.note',
        entity: 'sos',
        entityId: sosId,
        summary: `${profile!.fullName} added a note: ${text}`,
      });

      cache.invalidateTags('sos');
      return updated;
    });
  },

  async resolve(input: unknown): Promise<SosEvent> {
    const data = parseOrThrow(sosResolveSchema, input);

    return request({ name: 'sos.resolve', flakiness: 0 }, (profile) => {
      requireRole(profile!, 'officer');
      const event = db.find('sosEvents', data.sosId);
      if (!event) throw new ApiError({ kind: 'not-found', message: 'sos event' });
      assertOrgVisible(profile!, event.organizationId);
      if (event.status === 'resolved') {
        throw new ApiError({ kind: 'conflict', message: 'already resolved' });
      }

      const now = new Date().toISOString();
      const note = sanitizeText(data.note);
      const updated = db.update('sosEvents', data.sosId, {
        status: 'resolved',
        resolvedBy: profile!.id,
        resolvedAt: now,
        resolutionNote: note,
        timeline: [...event.timeline, timelineEntry('resolved', `Resolved: ${note}`, profile!.id)],
      })!;

      db.audit({
        actorId: profile!.id,
        actorRole: 'officer',
        organizationId: event.organizationId,
        action: 'sos.resolved',
        entity: 'sos',
        entityId: data.sosId,
        summary: `${profile!.fullName} resolved the SOS: ${note}`,
      });

      cache.invalidateTags('sos');
      return updated;
    });
  },

  /** The worker can stand down their own SOS - false alarms happen. */
  async cancel(sosId: string, reason: string): Promise<SosEvent> {
    return request({ name: 'sos.cancel', flakiness: 0 }, (profile) => {
      const event = db.find('sosEvents', sosId);
      if (!event) throw new ApiError({ kind: 'not-found', message: 'sos event' });
      if (event.workerId !== profile!.id) {
        throw new ApiError({
          kind: 'forbidden',
          message: 'only the worker can cancel',
          userMessage: 'Only the person who raised this SOS can stand it down. An officer resolves it instead.',
        });
      }

      const now = new Date().toISOString();
      const text = sanitizeText(reason) || 'Stood down by the worker.';
      const updated = db.update('sosEvents', sosId, {
        status: 'cancelled',
        resolvedAt: now,
        resolutionNote: text,
        timeline: [...event.timeline, timelineEntry('cancelled', `Stood down by ${profile!.fullName}: ${text}`, profile!.id)],
      })!;

      db.audit({
        actorId: profile!.id,
        actorRole: profile!.role,
        organizationId: event.organizationId,
        action: 'sos.cancelled',
        entity: 'sos',
        entityId: sosId,
        summary: `${profile!.fullName} stood down their SOS: ${text}`,
      });

      cache.invalidateTags('sos');
      return updated;
    });
  },

  /** Live events for the officer console. */
  async active(): Promise<SosEvent[]> {
    return request({ name: 'sos.active', latency: [80, 240], flakiness: 0 }, (profile) =>
      visibleSosFor(profile!)
        .filter((e) => e.status === 'active' || e.status === 'acknowledged')
        .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt)),
    );
  },

  async history(limit = 40): Promise<SosEvent[]> {
    return request({ name: 'sos.history' }, (profile) =>
      visibleSosFor(profile!)
        .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
        .slice(0, limit),
    );
  },

  async get(sosId: string): Promise<SosEvent> {
    return request({ name: 'sos.get', latency: [60, 200], flakiness: 0 }, (profile) => {
      const event = visibleSosFor(profile!).find((e) => e.id === sosId);
      if (!event) throw new ApiError({ kind: 'not-found', message: 'sos event' });
      return event;
    });
  },

  /** The signed-in worker's own live event, if any. */
  async mine(): Promise<SosEvent | null> {
    return request({ name: 'sos.mine', latency: [50, 160], flakiness: 0 }, (profile) => {
      return (
        db
          .table('sosEvents')
          .find((e) => e.workerId === profile!.id && (e.status === 'active' || e.status === 'acknowledged')) ?? null
      );
    });
  },
};


// ---------------------------------------------------------------------------
// Transport selection
// ---------------------------------------------------------------------------
// Screens import `sosApi` and never learn which backend answered. The mock
// remains a first-class implementation - it is what makes the app demonstrable
// offline and without a project - so this is a switch, not a migration stub.

export const sosApi = API_MODE === 'supabase' ? supabaseSosApi : mockSosApi;
export { mockSosApi };
