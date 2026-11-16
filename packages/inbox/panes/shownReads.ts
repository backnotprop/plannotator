import type { QueryClient } from '@tanstack/react-query';
import type { InboxThread } from '@plannotator/core/inbox-types';
import type { ListModel } from '../api';
import { heldThread, isThreadStale } from '../data/queries/thread';
import { machineOf } from '../inboxUrl';
import { listsThread, openThreadRead, type RecordBatch } from '../openThreadReads';
import type { KeyedSignal } from '../signal';
import { STALE_OPEN_MS } from '../threadFlights';
import type { PaneReads } from './paneReads';

/** How long the frames of a linked machine's records gather before its threads on screen are read again. */
export const MACHINE_THREAD_WAIT_MS = 80;

export interface ShownReadsDeps {
  reads: Pick<PaneReads, 'shown' | 'readOf' | 'refreshThread' | 'parkedThreads' | 'owe'>;
  latest: () => ListModel | null;
  filesSignals: KeyedSignal;
  /** Several panes can show (useRoutePanes `allowed`). Without, every read below is main's for the one open thread. */
  split: () => boolean;
  /** The address's thread (App's `routeRef`): the one open thread without the switch, as main reads it. */
  open: () => string | null;
}

/**
 * The reads that follow every thread on screen, in whichever pane (panes/model.ts), where one open thread was read
 * before: after records, on a catch-up or a refresh, and when a linked machine's frames name its threads.
 *
 * Without the switch the window has one pane, and each read here is main's for the address's thread, call for call:
 * the same thread, the same requests in the same order, the same promise awaited (none when no thread is open), and
 * a linked machine's frames on one timer.
 *
 * A pane kept off the page (ThreadPanes.tsx) is not on screen: its thread is not read, only owed the read (paneReads.ts
 * `owe`), which it gets once when it is back.
 */
export function createShownReads({ reads, latest, filesSignals, split, open }: ShownReadsDeps) {
  const machineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let oneTimer: ReturnType<typeof setTimeout> | null = null;
  const shown = (): readonly string[] => {
    if (split()) return reads.shown();
    const thread = open();
    return thread ? [thread] : [];
  };
  /** The threads off the page these reads would have read (`which`): each is owed one. */
  const owe = (which: (threadId: string) => boolean) => {
    if (split()) for (const threadId of reads.parkedThreads()) if (which(threadId)) reads.owe(threadId);
  };
  const isLaunched = (id: string) => reads.readOf(id).loaded?.thread_id === id && !!reads.readOf(id).loaded?.messages[0]?.launch;
  const onMachine = (machines: ReadonlySet<string>) => (id: string) => {
    const owner = machineOf(id);
    return owner !== null && machines.has(owner);
  };
  /** Each thread read again; none, nothing to wait for; one, its own read, as main awaited it. */
  const readAll = (threads: readonly string[]): Promise<unknown> | null =>
    threads.length === 0
      ? null
      : threads.length === 1
        ? reads.refreshThread(threads[0]!)
        : Promise.all(threads.map((id): Promise<InboxThread | null> => reads.refreshThread(id)));
  return {
    shown,
    /** The thread a run of the person's pick saves on `saved` reads for: that pane's, or without the switch the address's (main's). */
    ownOpen: (saved: string | null): string | null => (split() ? saved : open()),
    /** Each thread on screen, read again: a catch-up, a refresh, after the person's own write. Null: none on screen. */
    all: () => {
      owe(() => true);
      return readAll(shown());
    },
    /**
     * The records of a pause (openThreadReads.ts): each thread on screen reads what they owe it. One they owe nothing
     * is read anyway when the list read that came with them no longer lists it (deleted elsewhere, which no record says).
     */
    afterRecords: (records: RecordBatch, listRead: Promise<ListModel | null>): Promise<unknown> => {
      const owed: string[] = [];
      const readFor = (threadId: string) => {
        const { load, loaded, loadedAt } = reads.readOf(threadId);
        return openThreadRead(records, {
          threadId,
          remote: machineOf(threadId) !== null,
          loaded,
          loadedAt,
          now: Date.now(),
          settled: load === null || load.threadId !== threadId,
          listed: listsThread(latest(), threadId),
        });
      };
      owe((threadId) => readFor(threadId) !== 'none');
      // One off the page the list no longer lists is owed its read too, so its pane closes once back.
      void listRead.then((next) => owe((threadId) => !listsThread(next, threadId)));
      for (const threadId of shown()) {
        const read = readFor(threadId);
        if (read === 'thread') {
          owed.push(threadId);
          continue;
        }
        if (read === 'files') filesSignals.emit(threadId);
        void listRead.then((next) => {
          if (shown().includes(threadId) && !listsThread(next, threadId)) void reads.refreshThread(threadId);
        });
      }
      return readAll(owed) ?? Promise.resolve(null);
    },
    /** A record from a linked machine: its threads on screen read again once its frames pause. */
    machineFrame: (machine: string) => {
      if (!split()) {
        // Main's: the open thread of that machine, on one timer whichever thread set it.
        const thread = open();
        if (!thread || machineOf(thread) !== machine) return;
        if (oneTimer) clearTimeout(oneTimer);
        oneTimer = setTimeout(() => void reads.refreshThread(thread), MACHINE_THREAD_WAIT_MS);
        return;
      }
      owe((threadId) => machineOf(threadId) === machine);
      for (const threadId of shown()) {
        if (machineOf(threadId) !== machine) continue;
        const timer = machineTimers.get(threadId);
        if (timer) clearTimeout(timer);
        machineTimers.set(
          threadId,
          setTimeout(() => {
            machineTimers.delete(threadId);
            if (shown().includes(threadId)) void reads.refreshThread(threadId);
          }, MACHINE_THREAD_WAIT_MS),
        );
      }
    },
    /** Held writes settled (or one was delivered) on these machines: their threads on screen show them now. */
    onMachines: (machines: ReadonlySet<string>) => {
      owe(onMachine(machines));
      return readAll(shown().filter(onMachine(machines)));
    },
    /** The live sessions moved: a launched thread on screen reads its run line again. */
    launched: () => {
      owe(isLaunched);
      return readAll(shown().filter(isLaunched));
    },
    stop: () => {
      for (const timer of machineTimers.values()) clearTimeout(timer);
      machineTimers.clear();
      if (oneTimer) clearTimeout(oneTimer);
      oneTimer = null;
    },
  };
}

export type ShownReads = ReturnType<typeof createShownReads>;

/**
 * With the switch, each thread on screen (`shown`) left stale by any path is read after `ms`, unless a read made it
 * current meanwhile. Without it `shown` is empty, and main's `watchStaleOpen` (threadFlights.ts) watches the one open
 * thread instead.
 */
export function watchStaleShown(client: QueryClient, shown: () => readonly string[], read: (threadId: string) => void, ms = STALE_OPEN_MS): () => void {
  const timers = new Map<string, ReturnType<typeof setTimeout>>();
  const arm = (threadId: string) => {
    if (timers.has(threadId) || !heldThread(client, threadId) || !isThreadStale(client, threadId)) return;
    timers.set(
      threadId,
      setTimeout(() => {
        timers.delete(threadId);
        if (shown().includes(threadId) && heldThread(client, threadId) && isThreadStale(client, threadId)) read(threadId);
      }, ms),
    );
  };
  const stop = client.getQueryCache().subscribe((event) => {
    const threadId = event.query.queryKey[2];
    if (event.query.queryKey[1] === 'thread' && typeof threadId === 'string' && shown().includes(threadId)) arm(threadId);
  });
  return () => {
    stop();
    for (const timer of timers.values()) clearTimeout(timer);
    timers.clear();
  };
}
