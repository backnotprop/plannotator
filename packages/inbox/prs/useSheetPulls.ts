import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { InboxPullsAnswer } from '@plannotator/core/inbox-types';
import { inboxApi } from '../api';
import { PULLS_FOCUS_MS, PULLS_PENDING_MS, PULLS_TICK_MS } from '../pulls/usePulls';
import { onHiddenWritten, pullsShown, settleHidden, useHiddenChanges } from '../pulls/hiddenPulls';
import type { Route } from '../app/route';
import { boardInProject, boardProjectName, sheetModel } from './sheetModel';

export interface SheetPullsState {
  model: InboxPullsAnswer | null;
  error: string | null;
  loading: boolean;
  /** Ask the forges again now (after a merge, or the person's refresh). */
  refresh: () => void;
}

/**
 * The Pull requests page's list (`GET /api/inbox/pulls?everywhere=1&machines=1`, with each linked machine's): read only while the page (or a PR opened from
 * it) is on screen, on the same clock as the Reviews page (on open, on focus after `PULLS_FOCUS_MS`, every
 * `PULLS_TICK_MS` while visible). The server answers from its cache in between: no extra polling of the forges.
 */
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
          settleHidden(answer.hidden, Date.now(), answer.hidden_repos);
          setError(null);
          // Others (the projects' other PRs) and a linked machine's board still being read: on the server's next answer.
          const pending = answer.hosts.some((h) => h.others_pending) || Object.values(answer.machines ?? {}).some((m) => m.pending);
          if (pending) pendingTimer.current = setTimeout(() => readRef.current(false), PULLS_PENDING_MS);
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

  // A PR hidden or shown again (hiddenPulls.ts): read again from the server's cache.
  useEffect(() => onHiddenWritten(() => readRef.current(false)), []);

  const refresh = useCallback(() => read(true), [read]);
  // What was hidden here leaves at once, before the server's next answer says so.
  const changes = useHiddenChanges();
  return { model: useMemo(() => pullsShown(model, changes), [model, changes]), error, loading, refresh };
}

/**
 * The board as the window shows it: it follows Reviews' project filter, in Reviews' pane, on its own page (a phone's)
 * and beside a thread opened from Reviews (`project`), and its head (the sidebar's summary) counts that project's.
 */
export function useBoardInProject(model: InboxPullsAnswer | null, route: Pick<Route, 'page' | 'project' | 'reviews'>, names: ReadonlyMap<string, string>, projects: readonly { id: string; name: string }[]) {
  const project = route.page === 'reviews' || route.page === 'prs' ? (route.project ?? null) : (route.reviews?.project ?? null);
  const board = useMemo(() => (model ? boardInProject(model, project) : null), [model, project]);
  const head = useMemo(() => (board ? sheetModel(board, Date.now(), {}).head : null), [board]);
  return { project, board, head, name: boardProjectName(project, names, projects) };
}

