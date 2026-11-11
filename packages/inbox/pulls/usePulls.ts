import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxPullsAnswer, InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';

export const PULLS_FOCUS_MS = 20_000;
export const PULLS_TICK_MS = 2 * 60_000;
export const PULLS_PENDING_MS = 2_000;

export interface PullsState {
  model: InboxPullsAnswer | null;
  reviews: InboxReviewsAnswer | null;
  error: string | null;
  loading: boolean;
  refresh: () => void;
  reload: () => void;
  reloadRows: () => void;
}

export function usePulls(enabled: boolean, counted = false, othersView = false): PullsState {
  const [model, setModel] = useState<InboxPullsAnswer | null>(null);
  const [reviews, setReviews] = useState<InboxReviewsAnswer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<AbortController | null>(null);
  const lastAt = useRef(0);
  const pendingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const rowsInFlight = useRef<AbortController | null>(null);
  const others = useRef(othersView);
  others.current = othersView;

  const read = useCallback(
    (refresh: boolean) => {
      if (!enabled && !counted) return;
      if (pendingTimer.current) clearTimeout(pendingTimer.current);
      pendingTimer.current = null;
      inFlight.current?.abort();
      // A late answer from the cache never overwrites this newer read.
      rowsInFlight.current?.abort();
      const controller = new AbortController();
      inFlight.current = controller;
      lastAt.current = Date.now();
      setLoading(true);
      inboxApi
        .pulls(refresh, controller.signal, enabled && others.current)
        .then(async (answer) => [answer, await inboxApi.reviews({ others: enabled && others.current }, controller.signal)] as const)
        .then(([answer, rows]) => {
          if (controller.signal.aborted) return;
          setModel(answer);
          setReviews(rows);
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
    [enabled, counted],
  );
  const readRef = useRef(read);
  readRef.current = read;

  useEffect(() => {
    if (!enabled && counted) {
      if (lastAt.current === 0 || Date.now() - lastAt.current >= PULLS_FOCUS_MS) read(false);
      const onFocus = () => {
        if (Date.now() - lastAt.current >= PULLS_FOCUS_MS) read(false);
      };
      window.addEventListener('focus', onFocus);
      return () => window.removeEventListener('focus', onFocus);
    }
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
      // Not aborted here: the page closing while the count is kept lets the read land (the next state decides).
    };
  }, [enabled, counted, read]);

  const wasOthers = useRef(othersView);
  useEffect(() => {
    if (othersView && !wasOthers.current && enabled) read(false);
    wasOthers.current = othersView;
  }, [othersView, enabled, read]);

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
  const reloadRows = useCallback(() => {
    if (inFlight.current || (!enabled && !counted)) return;
    rowsInFlight.current?.abort();
    const controller = new AbortController();
    rowsInFlight.current = controller;
    inboxApi.reviewsCached(controller.signal).then(
      (rows) => {
        if (!controller.signal.aborted && !('cold' in rows)) setReviews(rows);
      },
      () => {
      },
    );
  }, [enabled, counted]);
  return { model, reviews, error, loading, refresh, reload, reloadRows };
}
