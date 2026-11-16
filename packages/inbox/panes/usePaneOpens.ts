import { useEffect, useRef, useState } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { PaneId, PaneSet } from './model';
import { createPaneReads, type PaneOpenView, type PaneReads, type PaneReadsDeps } from './paneReads';

/** Every pane's reads and open (paneReads.ts), with their views as the window's state. */
export function usePaneReads(deps: Omit<PaneReadsDeps, 'drawn' | 'panes'>, panes: PaneSet): PaneReads {
  const panesRef = useRef(panes);
  panesRef.current = panes;
  const [, setViews] = useState<ReadonlyMap<PaneId, PaneOpenView>>(() => new Map());
  const [reads] = useState(() => createPaneReads({ ...deps, panes: () => panesRef.current, drawn: setViews }));
  return reads;
}

/**
 * Each pane opens its thread: a pane whose thread or Try again changed closes its last open and opens again; the
 * others go on. `opened` runs once a pane's read landed (the window records the look).
 */
export function usePaneOpening(reads: PaneReads, panes: PaneSet, opened: (threadId: string, thread: InboxThread) => void): void {
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const runs = useRef(new Map<PaneId, { key: string; stop: () => void }>());
  const key = panes.panes.map((pane) => `${pane.id}\u0000${pane.thread ?? ''}\u0000${reads.view(pane.id).retry}`).join('\u0001');
  useEffect(() => {
    const live = new Set<PaneId>();
    for (const { id, thread } of panes.panes) {
      live.add(id);
      const runKey = `${thread ?? ''}\u0000${reads.view(id).retry}`;
      const run = runs.current.get(id);
      if (run?.key === runKey) continue;
      run?.stop();
      if (thread) runs.current.set(id, { key: runKey, stop: reads.open(id, thread, (threadId, read) => openedRef.current(threadId, read)) });
      else {
        reads.close(id);
        runs.current.set(id, { key: runKey, stop: () => {} });
      }
    }
    for (const [id, run] of runs.current) {
      if (live.has(id)) continue;
      run.stop();
      runs.current.delete(id);
      reads.close(id);
    }
    // `key` names every pane's thread and Try again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reads]);
  useEffect(() => {
    const all = runs.current;
    return () => {
      for (const run of all.values()) run.stop();
      all.clear();
    };
  }, []);
}
