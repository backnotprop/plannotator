import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';

/** The window got its focus back: the list is read again, at most this often. */
export const PULLS_FOCUS_MS = 20_000;
/** While the page stays open, the list is read again this often (the server answers from its cache in between). */
export const PULLS_TICK_MS = 2 * 60_000;
/** Others is read in the background (the server never waits for it): while it is on its way, ask again this soon. */
export const PULLS_PENDING_MS = 2_000;

export interface PullsState {
  model: InboxPullsAnswer | null;
  error: string | null;
  loading: boolean;
  /** Read the forges again now (the footer's refresh). */
  refresh: () => void;
  /** Read the list again from the server's cache (a PR was just handed to an agent: its thread is new). */
  reload: () => void;
}

/**
 * The Pull requests list (approval "inbox-code-review-direction", item 4):
 * read while `enabled` (the page is open and Code review is on): on open, on
 * focus after `PULLS_FOCUS_MS`, every `PULLS_TICK_MS` while visible. While the
 * page is closed but `counted` (Code review is on), the sidebar's "On you"
 * count is kept current: the list is read once when the window starts and
 * again on focus after `PULLS_FOCUS_MS` (the server answers from its cache
 * while that is fresh). Leaving the page keeps a read in flight while the
 * count still wants it (its answer is the count's). Neither: nothing is asked
 * and a read in flight is dropped. `othersView`: the page shows the Others view, so the server reads Others as often
 * as the list (else every 5 min at most); opening it reads at once.
 */
export function usePulls(enabled: boolean, counted = false, othersView = false): PullsState {
  const [model, setModel] = useState<InboxPullsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const others = useRef(othersView);
  others.current = othersView;

  const read = useCallback(
    (refresh: boolean) => {
      if (!enabled && !counted) return;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      inFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      lastAt.current = Date.now();
      setLoading(true);
      inboxApi
        .pulls(refresh, controller.signal, enabled && others.current)
        .then((answer) => {
          if (controller.signal.aborted) return;
          setModel(answer);
          setError(null);
          // Others still on its way: its answer lands on the server's next answer (a cache read, no forge call).
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
    [enabled, counted],
  );
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!enabled && counted) {
      // The page is closed: the count only. Read when the window starts (or Code review is turned on), then on focus.
      if (lastAt.current === 0 || Date.now() - lastAt.current >= PULLS_FOCUS_MS) read(false);
      const onFocus = () => {
        if (Date.now() - lastAt.current >= PULLS_FOCUS_MS) read(false);
      };
      window.addEventListener('focus', onFocus);
      return () => window.removeEventListener('focus', onFocus);
    }
    if (!enabled) {
      // Neither the page nor the count: a read in flight is dropped.
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
      // Not aborted here: the page closing while the count is kept lets the read land (the next state decides).
    };
  }, [enabled, counted, read]);

  // The Others view opened: read now, so its PRs are as fresh as the list's (the server reads Others then).
  const wasOthers = useRef(othersView);
  useEffect(() => {
    if (othersView && !wasOthers.current && enabled) read(false);
    wasOthers.current = othersView;
  }, [othersView, enabled, read]);

  // Gone from the window: whatever is in flight is dropped.
  useEffect(
    () => () => {
      inFlight.current?.abort();
      inFlight.current = null;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
    },
    [],
  );

  const refresh = useCallback(() => read(true), [read]);
  const reload = useCallback(() => read(false), [read]);
  return { model, error, loading, refresh, reload };
}
