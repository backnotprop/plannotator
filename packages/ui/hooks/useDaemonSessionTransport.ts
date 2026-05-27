import { useEffect } from 'react';
import type {
  DaemonEventFamily,
  DaemonWebSocketServerMessage,
} from '@plannotator/shared/daemon-protocol';
import { subscribeToDaemonSessionFamily } from '../utils/daemonHub';

type SessionEventFamily = Exclude<DaemonEventFamily, 'daemon'>;
export type DaemonSessionTransportMessage = Extract<
  DaemonWebSocketServerMessage,
  { type: 'snapshot' | 'event' }
>;

const CONNECTING_FALLBACK_MS = 1_000;

interface UseDaemonSessionTransportOptions<TSnapshot> {
  enabled: boolean;
  family: SessionEventFamily;
  pollMs: number;
  fetchSnapshot: () => Promise<TSnapshot | null | undefined>;
  applySnapshot: (snapshot: TSnapshot) => void;
  applyMessage: (message: DaemonSessionTransportMessage) => void;
}

export function useDaemonSessionTransport<TSnapshot>({
  enabled,
  family,
  pollMs,
  fetchSnapshot,
  applySnapshot,
  applyMessage,
}: UseDaemonSessionTransportOptions<TSnapshot>): void {
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let socketOpen = false;
    let transportGeneration = 0;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    let connectingFallbackTimer: ReturnType<typeof setTimeout> | undefined;

    const fetchAndApplySnapshot = async () => {
      const startedWhileSocketOpen = socketOpen;
      const startedGeneration = transportGeneration;
      let snapshot: TSnapshot | null | undefined;
      try {
        snapshot = await fetchSnapshot();
      } catch {
        return;
      }
      if (
        !cancelled &&
        !socketOpen &&
        !startedWhileSocketOpen &&
        startedGeneration === transportGeneration &&
        snapshot !== null &&
        snapshot !== undefined
      ) {
        applySnapshot(snapshot);
      }
    };

    const startPolling = () => {
      if (pollTimer) return;
      void fetchAndApplySnapshot();
      pollTimer = setInterval(() => void fetchAndApplySnapshot(), pollMs);
    };

    const stopPolling = () => {
      if (!pollTimer) return;
      clearInterval(pollTimer);
      pollTimer = undefined;
    };

    const stopConnectingFallback = () => {
      if (!connectingFallbackTimer) return;
      clearTimeout(connectingFallbackTimer);
      connectingFallbackTimer = undefined;
    };

    const startConnectingFallback = () => {
      if (connectingFallbackTimer || pollTimer) return;
      connectingFallbackTimer = setTimeout(() => {
        connectingFallbackTimer = undefined;
        if (!socketOpen) startPolling();
      }, CONNECTING_FALLBACK_MS);
    };

    const unsubscribe = subscribeToDaemonSessionFamily(
      family,
      (message) => {
        if (cancelled || (message.type !== 'snapshot' && message.type !== 'event')) return;
        applyMessage(message);
      },
      (state) => {
        if (state === 'open') {
          socketOpen = true;
          transportGeneration += 1;
          stopConnectingFallback();
          stopPolling();
          return;
        }
        socketOpen = false;
        if (state === 'connecting') {
          startConnectingFallback();
        } else if (state === 'closed' || state === 'unavailable') {
          stopConnectingFallback();
          startPolling();
        }
      },
    );
    if (!unsubscribe) startPolling();

    return () => {
      cancelled = true;
      unsubscribe?.();
      stopConnectingFallback();
      stopPolling();
    };
  }, [applyMessage, applySnapshot, enabled, family, fetchSnapshot, pollMs]);
}
