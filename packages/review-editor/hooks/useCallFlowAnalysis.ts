import { useCallback, useEffect, useState } from 'react';
import type { CallFlowResponse } from '@plannotator/shared/call-flow-types';

export type CallFlowAnalysisState =
  | { status: 'idle' | 'loading' }
  | { status: 'ready'; data: Extract<CallFlowResponse, { status: 'ok' }> }
  | { status: 'error'; error: Exclude<CallFlowResponse, { status: 'ok' }> | Error };

export interface CallFlowAnalysisController {
  readonly state: CallFlowAnalysisState;
  /** Start a fresh client request without changing the shared review snapshot. */
  readonly retry: () => void;
}

/** Run once per visible review snapshot; all Dock/Lens consumers share this state. */
export function useCallFlowAnalysis(
  snapshotId: string | undefined,
  available: boolean,
): CallFlowAnalysisController {
  const [state, setState] = useState<CallFlowAnalysisState>({ status: 'idle' });
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);

  useEffect(() => {
    if (!available || !snapshotId) {
      setState({ status: 'idle' });
      return;
    }
    const controller = new AbortController();
    setState({ status: 'loading' });
    fetch(`/api/call-flow?snapshot=${encodeURIComponent(snapshotId)}&attempt=${attempt}`, { signal: controller.signal })
      .then(async (response) => {
        const payload = await response.json() as CallFlowResponse;
        return payload;
      })
      .then((payload) => {
        if (controller.signal.aborted) return;
        setState(payload.status === 'ok'
          ? { status: 'ready', data: payload }
          : { status: 'error', error: payload });
      })
      .catch((error) => {
        if (controller.signal.aborted) return;
        setState({ status: 'error', error: error instanceof Error ? error : new Error(String(error)) });
      });
    return () => controller.abort();
  }, [attempt, available, snapshotId]);

  return { state, retry };
}
