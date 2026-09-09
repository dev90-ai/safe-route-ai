import { advisorySchema, parseOrThrow, sanitizeText } from '@/lib/validation';
import { ApiError } from '../errors';
import { rateLimiter } from '../rateLimit';
import type { MatchReason, NotificationRecord, SafetyAlert } from '../types';
import { call, deniedOrMissing } from './call';
import { supabase } from './client';
import { mapAlert, mapNotification } from './mappers';

const SELECT = '*, lat, lng';

export const supabaseAlertsApi = {
  async list(options: { includeExpired?: boolean } = {}): Promise<SafetyAlert[]> {
    let query = supabase().from('safety_alerts').select(SELECT).order('created_at', { ascending: false });

    if (!options.includeExpired) {
      query = query.is('cancelled_at', null).or(`expires_at.is.null,expires_at.gt.${new Date().toISOString()}`);
    }

    const rows = await call('alerts.list', () => query);
    return (rows ?? []).map(mapAlert);
  },

  /** Standalone advisory. RLS restricts this to officers. */
  async createAdvisory(input: unknown): Promise<SafetyAlert> {
    const data = parseOrThrow(advisorySchema, input);
    await rateLimiter.consume('alerts.create');

    const { data: me } = await supabase().auth.getUser();
    if (!me.user) throw new ApiError({ kind: 'unauthorized', message: 'no session' });

    const profile = await call('alerts.myOrg', () =>
      supabase().from('profiles').select('organization_id').eq('id', me.user!.id).maybeSingle(),
    );
    if (!profile) throw deniedOrMissing('profile');

    const row = await call('alerts.createAdvisory', () =>
      supabase()
        .from('safety_alerts')
        .insert({
          issued_by: me.user!.id,
          organization_id: profile.organization_id,
          title: sanitizeText(data.title),
          message: sanitizeText(data.message),
          severity: data.severity,
          threat_type: data.threatType,
          location: data.location ? `SRID=4326;POINT(${data.location.lng} ${data.location.lat})` : null,
          radius_meters: data.radiusMeters,
          region_ids: data.regionIds,
          kind: 'advisory',
          expires_at: new Date(Date.now() + data.expiresInHours * 3_600_000).toISOString(),
        })
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'advisory rejected',
        userMessage: 'Only a security officer can issue an advisory.',
      });
    }

    // The database owns the four fan-out rules.
    await call('alerts.fanOut', () => supabase().rpc('fan_out_alert', { p_alert_id: row.id }));

    const refreshed = await call('alerts.reload', () =>
      supabase().from('safety_alerts').select(SELECT).eq('id', row.id).maybeSingle(),
    );
    return mapAlert(refreshed ?? row);
  },

  async cancel(alertId: string, reason: string): Promise<SafetyAlert> {
    const row = await call('alerts.cancel', () =>
      supabase()
        .from('safety_alerts')
        .update({ cancelled_at: new Date().toISOString() })
        .eq('id', alertId)
        .is('cancelled_at', null)
        .select(SELECT)
        .maybeSingle(),
    );

    if (!row) {
      throw new ApiError({
        kind: 'forbidden',
        message: 'cancel rejected',
        userMessage: 'That advisory has already been withdrawn, or you cannot withdraw it.',
      });
    }
    void reason;
    return mapAlert(row);
  },

  /** The signed-in worker's persistent feed, with its alerts joined in. */
  async feed(limit = 60): Promise<{ notification: NotificationRecord; alert: SafetyAlert | null }[]> {
    const rows = await call('alerts.feed', () =>
      supabase()
        .from('notifications')
        .select('*, safety_alerts(*, lat, lng)')
        .order('delivered_at', { ascending: false })
        .limit(limit),
    );

    return (rows ?? []).map((row: Record<string, any>) => ({
      notification: mapNotification(row),
      alert: row.safety_alerts ? mapAlert(row.safety_alerts) : null,
    }));
  },

  async unreadCount(): Promise<number> {
    const { count, error } = await supabase()
      .from('notifications')
      .select('id', { count: 'exact', head: true })
      .is('read_at', null);

    if (error) return 0;
    return count ?? 0;
  },

  async markRead(notificationId: string): Promise<void> {
    await call('alerts.markRead', () =>
      supabase()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .eq('id', notificationId)
        .is('read_at', null)
        .select('id')
        .maybeSingle(),
    );
  },

  async markAllRead(): Promise<number> {
    const rows = await call('alerts.markAllRead', () =>
      supabase()
        .from('notifications')
        .update({ read_at: new Date().toISOString() })
        .is('read_at', null)
        .select('id'),
    );
    return rows?.length ?? 0;
  },

  /**
   * Preview the blast radius before issuing. Deliberately reuses the same
   * matching logic the fan-out uses, so what an officer is shown is what will
   * actually happen.
   */
  async previewRecipients(input: {
    organizationId: string;
    location: { lat: number; lng: number } | null;
    radiusMeters: number | null;
    regionIds: string[];
    shareWithPartners: boolean;
  }): Promise<{ total: number; byReason: Record<MatchReason, number>; sample: { name: string; reasons: MatchReason[]; distanceMeters: number | null }[] }> {
    const rows = await call('alerts.previewRecipients', () =>
      supabase().rpc('preview_alert_recipients', {
        p_org_id: input.organizationId,
        p_lat: input.location?.lat ?? null,
        p_lng: input.location?.lng ?? null,
        p_radius_meters: input.radiusMeters,
        p_region_ids: input.regionIds,
        p_share_with_partners: input.shareWithPartners,
      }),
    );

    const byReason: Record<MatchReason, number> = {
      'same-organization': 0,
      'partner-organization': 0,
      'within-alert-radius': 0,
      'operating-region': 0,
      'direct-advisory': 0,
    };

    const sample: { name: string; reasons: MatchReason[]; distanceMeters: number | null }[] = [];

    for (const row of rows ?? []) {
      const reasons = (row.reasons ?? []) as MatchReason[];
      reasons.forEach((r) => {
        if (r in byReason) byReason[r] += 1;
      });
      if (sample.length < 6) {
        sample.push({ name: row.full_name, reasons, distanceMeters: row.distance_meters ?? null });
      }
    }

    return { total: rows?.length ?? 0, byReason, sample };
  },
};
