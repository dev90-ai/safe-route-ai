import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { db } from '@/api/db';
import { subscribe } from '@/api/realtime';
import { API_MODE, supabase } from '@/api/supabase/client';
import { mapNotification } from '@/api/supabase/mappers';
import { alertsApi } from '@/api/endpoints/alerts';
import type { NotificationRecord } from '@/api/types';
import { haptics } from '@/lib/haptics';
import { logger } from '@/lib/logger';
import { push, type PushPermission } from '@/lib/push';
import { useAuth } from './auth';
import { useToast } from './toast';

/**
 * Alert delivery on the device.
 *
 * Two channels, and only one of them is guaranteed:
 *  - **Realtime + the persistent feed** always work. An alert that arrives while
 *    the app is open raises a toast immediately, and every alert is written to
 *    the feed regardless.
 *  - **OS push** is best-effort. It is unavailable in Expo Go on Android and on
 *    web, so it goes through `lib/push`, which no-ops rather than throwing.
 *
 * Push is therefore an optimisation, never the record. Losing it costs the user
 * the buzz in their pocket, not the alert.
 */

// Safe on every platform: no-ops when the native module is unavailable.
push.configure();

type NotificationsContextValue = {
  unreadCount: number;
  latest: NotificationRecord | null;
  permission: PushPermission;
  /** Null when push works; an explanation for the UI when it does not. */
  unavailableMessage: string | null;
  requestPermission: () => Promise<boolean>;
  refreshUnread: () => Promise<void>;
  markRead: (id: string) => Promise<void>;
  markAllRead: () => Promise<void>;
};

/**
 * Fetch the notification behind a realtime event, whichever transport is live.
 *
 * Returns null when the row is not addressed to this user. Realtime delivers
 * table-level events, so the filtering that matters is RLS: another person's
 * notification simply is not readable.
 */
async function resolveNotification(id: string, profileId: string): Promise<NotificationRecord | null> {
  if (API_MODE !== 'supabase') {
    const record = db.find('notifications', id);
    return record && record.profileId === profileId ? record : null;
  }

  const { data } = await supabase().from('notifications').select('*').eq('id', id).maybeSingle();
  return data ? mapNotification(data) : null;
}

const NotificationsContext = createContext<NotificationsContextValue | null>(null);

export function NotificationsProvider({ children }: { children: ReactNode }) {
  const { user, status } = useAuth();
  const toast = useToast();

  const [unreadCount, setUnreadCount] = useState(0);
  const [latest, setLatest] = useState<NotificationRecord | null>(null);
  const [permission, setPermission] = useState<PushPermission>('undetermined');
  const seenIds = useRef(new Set<string>());
  const profileId = user?.profile.id ?? null;

  // --- Permission -----------------------------------------------------------
  useEffect(() => {
    if (!profileId) return;
    (async () => {
      await push.ensureAndroidChannels();
      const current = await push.getPermission();
      setPermission(current);
    })().catch((e) => logger.capture('notifications', e, { phase: 'permission-check' }));
  }, [profileId]);

  const requestPermission = useCallback(async (): Promise<boolean> => {
    const granted = await push.requestPermission();
    setPermission(granted ? 'granted' : push.available ? 'denied' : 'unavailable');
    return granted;
  }, []);

  // --- Unread badge ---------------------------------------------------------
  const refreshUnread = useCallback(async () => {
    if (!profileId) return;
    try {
      const count = await alertsApi.unreadCount();
      setUnreadCount(count);
      await push.setBadgeCount(count);
    } catch {
      // A failed badge refresh is never worth interrupting anyone over.
    }
  }, [profileId]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    // Badge count is fetched, not computed; the state write happens after the
    // request resolves rather than synchronously during this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refreshUnread();
  }, [status, refreshUnread]);

  // --- Realtime -------------------------------------------------------------
  useEffect(() => {
    if (!profileId || status !== 'authenticated') return;

    // Seed the seen-set so restoring a session does not replay history as a
    // burst of toasts.
    let cancelled = false;
    void alertsApi
      .feed(80)
      .then((items) => items.forEach(({ notification }) => seenIds.current.add(notification.id)))
      .catch(() => undefined);

    const handle = async (id: string) => {
      if (cancelled || seenIds.current.has(id)) return;

      const record = await resolveNotification(id, profileId);
      if (!record || cancelled) return;
      if (seenIds.current.has(record.id)) return;
      seenIds.current.add(record.id);

      setLatest(record);
      setUnreadCount((c) => c + 1);

      const critical = record.severity === 'critical' || record.severity === 'high';
      if (critical) haptics.warning();
      else haptics.tap();

      toast.show({
        tone: critical ? 'error' : 'warning',
        title: record.title,
        description: record.body.slice(0, 140),
        durationMs: critical ? 9000 : 5000,
      });

      void push.present({
        title: record.title,
        body: record.body,
        data: { alertId: record.alertId, reportId: record.reportId, severity: record.severity },
        critical,
        channelId: record.reportId ? 'threat-alerts' : 'advisories',
      });
    };

    const unsubscribe = subscribe('notifications', (event) => {
      if (event.type !== 'insert') return;
      void handle(event.id);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [profileId, status, toast]);

  // --- Actions --------------------------------------------------------------
  const markRead = useCallback(async (id: string) => {
    try {
      await alertsApi.markRead(id);
      setUnreadCount((c) => Math.max(0, c - 1));
    } catch {
      /* the feed re-renders from source on next load */
    }
  }, []);

  const markAllRead = useCallback(async () => {
    try {
      await alertsApi.markAllRead();
      setUnreadCount(0);
      await push.setBadgeCount(0);
    } catch {
      /* noop */
    }
  }, []);

  const value = useMemo<NotificationsContextValue>(
    () => ({
      unreadCount,
      latest,
      permission,
      unavailableMessage: push.unavailableMessage,
      requestPermission,
      refreshUnread,
      markRead,
      markAllRead,
    }),
    [unreadCount, latest, permission, requestPermission, refreshUnread, markRead, markAllRead],
  );

  return <NotificationsContext.Provider value={value}>{children}</NotificationsContext.Provider>;
}

export function useNotifications(): NotificationsContextValue {
  const ctx = useContext(NotificationsContext);
  if (!ctx) throw new Error('useNotifications must be used inside <NotificationsProvider>');
  return ctx;
}
