/**
 * What the thread pane's "↓ N new" pill reads on each scroll (thread/helpers.ts `newBelow`), kept out of the pane.
 *
 * `usePassedNew`: the new messages the person has had on screen this visit (the pill never counts them again), kept
 * per thread. `useWatchNew`: which messages can count at all, as the pane last drew them (set once each commit, so a
 * scroll between two draws reads what is on the page), and each one's article: a scroll with none left reads nothing,
 * and otherwise only those articles, never the whole thread.
 */
import { useCallback, useLayoutEffect, useRef, type RefObject } from 'react';
import type { PillWatch } from './helpers';

export function usePassedNew(threadId: string): { passedIds: () => Set<string>; watch: RefObject<PillWatch | null> } {
  const passed = useRef<{ threadId: string; ids: Set<string> }>({ threadId, ids: new Set() });
  const passedIds = useCallback((): Set<string> => {
    if (passed.current.threadId !== threadId) passed.current = { threadId, ids: new Set() };
    return passed.current.ids;
  }, [threadId]);
  const watch = useRef<PillWatch | null>(null);
  return { passedIds, watch };
}

/** Called after the pane's sets are known; the pane's later layout effects (and every scroll) read what it set. */
export function useWatchNew(watch: RefObject<PillWatch | null>, arrivals: ReadonlySet<string>, atOpen: ReadonlySet<string>, article: (id: string) => HTMLElement | null): void {
  useLayoutEffect(() => {
    watch.current = { arrivals, atOpen, article };
  });
}
