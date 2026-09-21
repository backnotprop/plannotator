import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { CallFlowInstallStatus } from '@plannotator/shared/call-flow-types';
import type { CallFlowLanguageId } from '@plannotator/shared/call-flow-languages';

export interface CallFlowInstallController {
  readonly status: CallFlowInstallStatus;
  /** Start the runtime install, or retry after an error. */
  readonly start: (languageIds?: readonly CallFlowLanguageId[]) => void;
}

const DEFAULT_POLL_INTERVAL_MS = 2_500;
const MAX_RECONCILE_ATTEMPTS = 10;

/**
 * Client controller for the opt-in CallDiff runtime install.
 *
 * POST /api/call-flow/install starts (or joins) the server-side install;
 * while it reports running, GET /api/call-flow/install-status is polled on
 * a slow interval. Status polling stops on done, error, and unmount. Once
 * done, capability reconciliation retries at the same interval for a bounded
 * number of attempts, so one transient advert failure cannot strand the panel
 * and a corrupt store cannot leave the UI polling forever.
 */
export function useCallFlowInstall(
  onInstalled: () => Promise<void>,
  pollIntervalMs: number = DEFAULT_POLL_INTERVAL_MS,
): CallFlowInstallController {
  const [status, setStatus] = useState<CallFlowInstallStatus>({ state: 'idle' });
  const onInstalledRef = useRef(onInstalled);
  useEffect(() => {
    onInstalledRef.current = onInstalled;
  }, [onInstalled]);

  const statusRef = useRef<CallFlowInstallStatus>(status);
  const applyStatus = useCallback((next: CallFlowInstallStatus) => {
    statusRef.current = next;
    setStatus(next);
  }, []);

  const start = useCallback((languageIds?: readonly CallFlowLanguageId[]) => {
    if (statusRef.current.state === 'running') return;
    applyStatus({ state: 'running', stage: 'downloading', languageIds: [...(languageIds ?? [])] });
    fetch('/api/call-flow/install', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(languageIds ? { languageIds } : {}),
    })
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
          ...(languageIds && { languageIds: [...languageIds] }),
        });
      });
  }, [applyStatus]);

  useEffect(() => {
    if (status.state !== 'done') return;
    let cancelled = false;
    let timer: number | undefined;
    let attempts = 0;
    const languageIds = status.languageIds;
    const reconcile = () => {
      attempts++;
      onInstalledRef.current()
        .catch(() => {
          if (cancelled) return;
          if (attempts >= MAX_RECONCILE_ATTEMPTS) {
            applyStatus({
              state: 'error',
              reason: 'reconcile-failed',
              error: 'Call flow was installed, but its capabilities could not be refreshed. Retry to reconcile.',
              languageIds,
            });
            return;
          }
          timer = window.setTimeout(reconcile, pollIntervalMs);
        });
    };
    reconcile();
    return () => {
      cancelled = true;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [applyStatus, pollIntervalMs, status]);

  useEffect(() => {
    if (status.state !== 'running') return;
    let cancelled = false;
    const timer = window.setInterval(() => {
      fetch('/api/call-flow/install-status')
        .then((response) => {
          if (!response.ok) throw new Error('Call-flow install status is temporarily unavailable.');
          return response.json() as Promise<CallFlowInstallStatus>;
        })
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
