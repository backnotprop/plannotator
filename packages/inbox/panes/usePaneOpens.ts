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

interface PaneRun {
  key: string;
  stop: () => void;
  /** Opened while another pane was active: looked at once this pane is. */
  landed: { threadId: string; read: InboxThread } | null;
}

/**
 * Each pane opens its thread: a pane whose thread or Try again changed closes its last open and opens again; the
 * others go on. `opened` (the window records the look) runs once a pane's read landed, and only for the active pane
 * (scope.ts: only the active pane counts messages as seen): a pane opened beside it is looked at when it becomes active.
 */
export function usePaneOpening(reads: PaneReads, panes: PaneSet, opened: (threadId: string, thread: InboxThread) => void): void {
  const openedRef = useRef(opened);
  openedRef.current = opened;
  const activeRef = useRef(panes.active);
  activeRef.current = panes.active;
  const runs = useRef(new Map<PaneId, PaneRun>());
  const key = panes.panes.map((pane) => `${pane.id}\u0000${pane.thread ?? ''}\u0000${reads.view(pane.id).retry}`).join('\u0001');
  useEffect(() => {
    const live = new Set<PaneId>();
    for (const { id, thread } of panes.panes) {
      live.add(id);
      const runKey = `${thread ?? ''}\u0000${reads.view(id).retry}`;
      const last = runs.current.get(id);
      if (last?.key === runKey) continue;
      last?.stop();
      const run: PaneRun = { key: runKey, stop: () => {}, landed: null };
      runs.current.set(id, run);
      if (!thread) reads.close(id);
      else
        run.stop = reads.open(id, thread, (threadId, read) => {
          if (activeRef.current === id) openedRef.current(threadId, read);
          else run.landed = { threadId, read };
        });
    }
    for (const [id, run] of runs.current) {
      if (live.has(id)) continue;
      run.stop();
      runs.current.delete(id);
      reads.remove(id);
    }
    // `key` names every pane's thread and Try again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, reads]);
  useEffect(() => {
    const run = runs.current.get(panes.active);
    if (!run?.landed) return;
    const { threadId, read } = run.landed;
    run.landed = null;
    openedRef.current(threadId, reads.readOf(threadId).loaded ?? read);
  }, [panes.active, reads]);
  useEffect(() => {
    const all = runs.current;
    return () => {
      for (const [id, run] of all) {
        run.stop();
        reads.remove(id);
      }
      all.clear();
    };
  }, [reads]);
}
