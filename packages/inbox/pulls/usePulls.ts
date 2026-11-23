import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxPullsAnswer, InboxReviewsAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { rememberFarBranches } from './branchReviews';
import { onHiddenWritten, pullsShown, reviewsShown, settleHidden, useHiddenChanges } from './hiddenPulls';
import { REVIEWS_AFTER_STORE_MAX_MS, REVIEWS_AFTER_STORE_MS } from '../app/boot';
import { useKeptState } from '../data/keptState';

/** The list's PRs on a ref card: "Open in Reviews" (refCardReviews.ts). */
export { useRefCardReviews } from './refCardReviews';

/** The window got its focus back: the list is read again, at most this often. */
export const PULLS_FOCUS_MS = 20_000;
/** While the page stays open, the list is read again this often (the server answers from its cache in between). */
export const PULLS_TICK_MS = 2 * 60_000;
/** Others is read in the background (the server never waits for it): while it is on its way, ask again this soon. */
export const PULLS_PENDING_MS = 2_000;

export interface PullsState {
  model: InboxPullsAnswer | null;
  /** The Reviews rows (`GET /api/inbox/reviews`): review threads and listed PRs. */
  reviews: InboxReviewsAnswer | null;
  error: string | null;
  loading: boolean;
  /** Read the forges again now (the footer's refresh). */
  refresh: () => void;
  /** Read the list again from the server's cache (a PR was just handed to an agent: its thread is new). */
  reload: () => void;
  /** The store changed (a review arrived, a verdict went): the rows again, from what the forges last answered. */
  reloadRows: () => void;
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
  const [reviews, keepReviews] = useKeptState<InboxReviewsAnswer | null>(null);
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
          settleHidden(answer.hidden, Date.now(), answer.hidden_repos);
          // A linked machine's reported branch: its thread opens there (Branch reviews).
          rememberFarBranches(rows);
          // The same rows keep the held answer (most reads are the server's cache): what reads them draws nothing new.
          keepReviews(rows);
          setError(null);
          // Others still on its way: its answer lands on the server's next answer (a cache read, no forge call). The
          // same for a linked machine's reported branches, read in the background too.
          if (answer.hosts.some((h) => h.others_pending) || rows.branches_pending) pendingTimer.current = setTimeout(() => readRef.current(false), PULLS_PENDING_MS);
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

  // A PR hidden or shown again here (hiddenPulls.ts): read again from the server's cache, the list and the count.
  useEffect(() => onHiddenWritten(() => readRef.current(false)), []);

  const refresh = useCallback(() => read(true), [read]);
  const reload = useCallback(() => read(false), [read]);
  const reloadRows = useCallback(() => {
    // A read of the whole list in flight brings the rows too.
    if (inFlight.current || (!enabled && !counted)) return;
    rowsInFlight.current?.abort();
    const controller = new AbortController();
    rowsInFlight.current = controller;
    inboxApi.reviewsCached(controller.signal).then(
      (rows) => {
        // Nothing read since the Inbox started (`cold`): the next read of the list brings them.
        if (controller.signal.aborted || 'cold' in rows) return;
        rememberFarBranches(rows);
        keepReviews(rows);
      },
      () => {
        // The next read of the list says what is wrong.
      },
    );
  }, [enabled, counted]);
  // What was hidden here leaves at once, before the server's next answer says so.
  const changes = useHiddenChanges();
  const shownModel = useMemo(() => pullsShown(model, changes), [model, changes]);
  const shownReviews = useMemo(() => reviewsShown(reviews, changes), [reviews, changes]);
  return { model: shownModel, reviews: shownReviews, error, loading, refresh, reload, reloadRows };
}

/**
 * A review arrived, a verdict went: Reviews' rows and the sidebar's count follow the store, a moment after it changed
 * (`moved`: what changes with it, the list and the open thread's messages), but a steady stream of messages never
 * holds it off for long.
 */
export function useRowsAfterStore(on: boolean, reloadRows: () => void, ...moved: unknown[]): void {
  const waitingSince = useRef<number | null>(null);
  useEffect(() => {
    if (!on) return;
    const since = (waitingSince.current ??= Date.now());
    const timer = setTimeout(() => {
      waitingSince.current = null;
      reloadRows();
    }, Math.min(REVIEWS_AFTER_STORE_MS, Math.max(0, since + REVIEWS_AFTER_STORE_MAX_MS - Date.now())));
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on, reloadRows, ...moved]);
}
