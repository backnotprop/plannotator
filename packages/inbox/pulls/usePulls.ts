import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';

/** The window got its focus back: the list is read again, at most this often. */
export const PULLS_FOCUS_MS = 20_000;
/** While the page stays open, the list is read again this often (the server answers from its cache in between). */
export const PULLS_TICK_MS = 2 * 60_000;

export interface PullsState {
  model: InboxPullsAnswer | null;
  error: string | null;
  loading: boolean;
  /** Read the forges again now (the footer's refresh). */
  refresh: () => void;
}

/**
 * The Pull requests list (approval "inbox-code-review-direction", item 4):
 * read only while `enabled` (the page is open and Code review is on). Off,
 * nothing is asked and a read in flight is dropped. The last answer is kept
 * for the sidebar's count and the next visit; nothing refreshes it while the
 * page is closed.
 */
export function usePulls(enabled: boolean): PullsState {
  const [model, setModel] = useState<InboxPullsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastAt = useRef(0);

  const read = useCallback(
    (refresh: boolean) => {
      if (!enabled) return;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      lastAt.current = Date.now();
      setLoading(true);
      inboxApi
        .pulls(refresh, controller.signal)
        .then((answer) => {
          if (controller.signal.aborted) return;
          setModel(answer);
          setError(null);
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

  useEffect(() => {
    if (!enabled) {
      inFlight.current?.abort();
      inFlight.current = null;
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
      inFlight.current?.abort();
      inFlight.current = null;
    };
  }, [enabled, read]);

  const refresh = useCallback(() => read(true), [read]);
  return { model, error, loading, refresh };
}
