import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallFlowInstallStatus } from '@plannotator/shared/call-flow-types';

export interface CallFlowInstallController {
  readonly status: CallFlowInstallStatus;
  /** Start the runtime install, or retry after an error. */
  readonly start: () => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_500;

/**
 * Client controller for the opt-in CallDiff runtime install.
 *
 * POST /api/call-flow/install starts (or joins) the server-side install;
 * while it reports running, GET /api/call-flow/install-status is polled on
 * a slow interval. Polling stops on done, error, and unmount, and never
 * runs in any other state. A transition to done fires onInstalled exactly
 * once per attempt so the owner can refresh the capability advert.
 */
export function useCallFlowInstall(
  onInstalled: () => void,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): CallFlowInstallController {
  const [status, setStatus] = useState<CallFlowInstallStatus>({ state: 'idle' });
  const onInstalledRef = useRef(onInstalled);
  useEffect(() => {
    onInstalledRef.current = onInstalled;
  }, [onInstalled]);

  // Tracked outside setState so the done transition side effect fires exactly
  // once even when React re-runs state updaters.
  const statusRef = useRef<CallFlowInstallStatus>(status);
  const applyStatus = useCallback((next: CallFlowInstallStatus) => {
    const wasDone = statusRef.current.state === 'done';
    statusRef.current = next;
    setStatus(next);
    if (!wasDone && next.state === 'done') onInstalledRef.current();
  }, []);

  const start = useCallback(() => {
    if (statusRef.current.state === 'running') return;
    applyStatus({ state: 'running', stage: 'downloading' });
    fetch('/api/call-flow/install', { method: 'POST' })
      .then(async (response) => {
        if (!response.ok) {
          const body = await response.json().catch(() => null) as { error?: string } | null;
          throw new Error(body?.error ?? 'The runtime install could not be started.');
        }
        return response.json() as Promise<CallFlowInstallStatus>;
      })
      .then(applyStatus)
      .catch((error) => {
        applyStatus({
          state: 'error',
          error: error instanceof Error ? error.message : 'The runtime install could not be started.',
        });
      });
  }, [applyStatus]);

  useEffect(() => {
    if (status.state !== 'running') return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetch('/api/call-flow/install-status')
        .then((response) => response.json() as Promise<CallFlowInstallStatus>)
        .then((next) => {
          if (!cancelled) applyStatus(next);
        })
        .catch(() => {
          // Transient poll failures keep the current running state; the next
          // tick retries.
        });
    }, pollIntervalMs);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [applyStatus, pollIntervalMs, status.state]);

  return useMemo(() => ({ status, start }), [start, status]);
}
