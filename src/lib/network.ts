import NetInfo, { type NetInfoState } from '@react-native-community/netinfo';

import { logger } from './logger';

/**
 * Single source of truth for connectivity.
 *
 * `simulatedOffline` exists on purpose: North Eastern Kenya's coverage gaps are
 * the hardest part of this product to test, and reviewers cannot be asked to
 * walk out of range. The Diagnostics screen flips this flag so the offline
 * queue, the SOS retry path, and every cache fallback can be exercised on a
 * desk. It is treated exactly like real loss of signal.
 */

export type ConnectionQuality = 'offline' | 'poor' | 'good';

export type NetworkStatus = {
  online: boolean;
  quality: ConnectionQuality;
  type: string;
  simulatedOffline: boolean;
};

let state: NetworkStatus = {
  online: true,
  quality: 'good',
  type: 'unknown',
  simulatedOffline: false,
};

const listeners = new Set<(s: NetworkStatus) => void>();
let unsubscribeNetInfo: (() => void) | null = null;

function emit() {
  listeners.forEach((fn) => fn(state));
}

function qualityFrom(info: NetInfoState): ConnectionQuality {
  if (!info.isConnected) return 'offline';
  if (info.isInternetReachable === false) return 'offline';
  const details = info.details as { cellularGeneration?: string | null } | null;
  const generation = details?.cellularGeneration;
  if (info.type === 'cellular' && (generation === '2g' || generation === '3g')) return 'poor';
  return 'good';
}

export const network = {
  start() {
    if (unsubscribeNetInfo) return;
    unsubscribeNetInfo = NetInfo.addEventListener((info) => {
      const quality = qualityFrom(info);
      const online = quality !== 'offline';
      const changed = online !== state.online || quality !== state.quality;
      state = { ...state, online, quality, type: info.type ?? 'unknown' };
      if (changed) {
        logger.info('network', online ? 'connection restored' : 'connection lost', {
          type: state.type,
          quality,
        });
        emit();
      }
    });
  },

  stop() {
    unsubscribeNetInfo?.();
    unsubscribeNetInfo = null;
  },

  get(): NetworkStatus {
    return state;
  },

  /** True only when we are actually able to reach the backend. */
  isOnline(): boolean {
    return state.online && !state.simulatedOffline;
  },

  quality(): ConnectionQuality {
    if (state.simulatedOffline) return 'offline';
    return state.quality;
  },

  setSimulatedOffline(value: boolean) {
    if (state.simulatedOffline === value) return;
    state = { ...state, simulatedOffline: value };
    logger.warn('network', value ? 'simulated offline enabled' : 'simulated offline disabled');
    emit();
  },

  subscribe(fn: (s: NetworkStatus) => void) {
    listeners.add(fn);
    fn(state);
    return () => listeners.delete(fn);
  },
};
