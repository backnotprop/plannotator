/**
 * The Inbox list's side of Hide pull requests (hiddenPulls.ts), for the window (App.tsx): the row menu's Hide, and
 * the threads an Undo or a Show again made here brought back.
 */
import { useEffect, useRef } from 'react';
import { hideThreadsWithUndo, onThreadsBack, type Toast } from './hiddenPulls';

export { hiddenChangedElsewhere } from './hiddenPulls';

/**
 * `afterWrite`: the window's own-write refresh (held.ts `addOwnThreads`). A thread an Undo or a Show again brought
 * back is the person's own write, so it goes back in place at once, never behind "N new"; a thread back on an agent's
 * new activity is news as any other. `hideRow`: the row menu's Hide, its open PRs hidden and the thread out of the
 * list until one is shown again, merged or closed.
 */
export function useHiddenInList(afterWrite: (written: readonly string[]) => unknown, toast: Toast): { hideRow: (threadId: string) => void } {
  const written = useRef(afterWrite);
  written.current = afterWrite;
  useEffect(() => onThreadsBack((ids) => void written.current(ids)), []);
  return {
    hideRow: (threadId) =>
      void hideThreadsWithUndo([threadId], toast).then((hid) => {
        if (hid) void written.current([threadId]);
      }),
  };
}
