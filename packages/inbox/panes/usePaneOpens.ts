import { useEffect, useRef, useState } from 'react';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { PaneId, PaneSet } from './model';
import type { QueryClient } from '@tanstack/react-query';
import { createPaneReads, type PaneOpenView, type PaneReads, type PaneReadsDeps } from './paneReads';
import { createShownReads, watchStaleShown, type ShownReads, type ShownReadsDeps } from './shownReads';
import { latestAgentSeq } from '../seenOnSight';
import { useStaleOpenRead } from '../threadFlights';

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
  /** The open's look went out: going back into the pane looks again at what reached it meanwhile. */
  looked: string | null;
}

/**
 * Each pane opens its thread: a pane whose thread or Try again changed closes its last open and opens again; the
 * others go on. `opened` (the window records the look) runs once a pane's read landed, and only for the active pane
 * (scope.ts: only the active pane counts messages as seen): a pane opened beside it is looked at when it becomes active.
 * A pane the person goes back into is looked at again as an open is, when an agent's message reached it while they
 * were in another pane: a pane beside the active one never counts what it shows as seen, so this is where it is.
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
      const run: PaneRun = { key: runKey, stop: () => {}, landed: null, looked: null };
      runs.current.set(id, run);
      if (!thread) reads.close(id);
      else
        run.stop = reads.open(id, thread, (threadId, read) => {
          if (activeRef.current === id) {
            run.looked = threadId;
            openedRef.current(threadId, read);
          } else run.landed = { threadId, read };
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
    if (!run) return;
    if (run.landed) {
      const { threadId, read } = run.landed;
      run.landed = null;
      run.looked = threadId;
      openedRef.current(threadId, reads.readOf(threadId).loaded ?? read);
      return;
    }
    // Back in a pane opened before: an agent's message past what its looks cover is looked at, as an open looks.
    const threadId = run.looked;
    const loaded = threadId ? reads.readOf(threadId).loaded : null;
    const look = reads.view(panes.active).look;
    if (!threadId || !loaded || loaded.thread_id !== threadId || look?.threadId !== threadId) return;
    const latest = latestAgentSeq(loaded);
    if (latest === null || (look.through !== null && latest <= look.through)) return;
    reads.raiseThrough(threadId, latest);
    openedRef.current(threadId, loaded);
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

/**
 * The reads that follow every thread on screen (shownReads.ts), and the re-read of one left stale: each thread on
 * screen with the switch (`watchStaleShown`), the address's thread without it, as main reads it (threadFlights.ts).
 */
export function useShownReads(reads: PaneReads, deps: Omit<ShownReadsDeps, 'reads' | 'split'> & { split: boolean }, client: QueryClient): ShownReads {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [shown] = useState(() => createShownReads({ reads, latest: () => depsRef.current.latest(), filesSignals: deps.filesSignals, split: () => depsRef.current.split, open: () => depsRef.current.open() }));
  const [single] = useState(() => ({
    get current() {
      return { thread: depsRef.current.split ? null : depsRef.current.open() };
    },
  }));
  useStaleOpenRead(client, single, (id) => void reads.refreshThread(id));
  useEffect(() => watchStaleShown(client, () => (depsRef.current.split ? reads.shown() : []), (id) => void reads.refreshThread(id)), [client, reads]);
  useEffect(() => shown.stop, [shown]);
  return shown;
}
