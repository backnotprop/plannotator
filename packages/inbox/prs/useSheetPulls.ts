import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { PULLS_FOCUS_MS, PULLS_PENDING_MS, PULLS_TICK_MS } from '../pulls/usePulls';

export interface SheetPullsState {
  model: InboxPullsAnswer | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
}

export function useSheetPulls(enabled: boolean): SheetPullsState {
  const [model, setModel] = useState<InboxPullsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const read = useCallback(
    (refresh: boolean) => {
      if (!enabled) return;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      lastAt.current = Date.now();
      setLoading(true);
      inboxApi
        .pulls(refresh, controller.signal, false, true)
        .then((answer) => {
          if (controller.signal.aborted) return;
          setModel(answer);
          setError(null);
          if (answer.hosts.some((h) => h.others_pending)) pendingTimer.current = setTimeout(() => readRef.current(false), PULLS_PENDING_MS);
        })
        .catch((cause: unknown) => {
          if (controller.signal.aborted) return;
          setError(cause instanceof Error ? cause.message : 'The pull requests could not be read.');
        })
        .finally(() => {
          if (inFlight.current === controller) {
            inFlight.current = null;
            setLoading(false);
          }
        });
    },
    [enabled],
  );
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!enabled) {
      inFlight.current?.abort();
      inFlight.current = null;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      setLoading(false);
      return;
    }
    read(false);
    const onFocus = () => {
      if (Date.now() - lastAt.current >= PULLS_FOCUS_MS) read(true);
    };
    const tick = setInterval(() => {
      if (document.visibilityState === 'visible') read(false);
    }, PULLS_TICK_MS);
    window.addEventListener('focus', onFocus);
    return () => {
      window.removeEventListener('focus', onFocus);
      clearInterval(tick);
    };
  }, [enabled, read]);

  useEffect(
    () => () => {
      inFlight.current?.abort();
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );

  const refresh = useCallback(() => read(true), [read]);
  return { model, error, loading, refresh };
}
