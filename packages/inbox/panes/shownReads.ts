import type { InboxThread } from '@plannotator/core/inbox-types';
import type { ListModel } from '../api';
import { machineOf } from '../inboxUrl';
import { listsThread, openThreadRead, type RecordBatch } from '../openThreadReads';
import type { KeyedSignal } from '../signal';
import type { PaneReads } from './paneReads';

/** How long the frames of a linked machine's records gather before its threads on screen are read again. */
export const MACHINE_THREAD_WAIT_MS = 80;

export interface ShownReadsDeps {
  reads: Pick<PaneReads, 'shown' | 'readOf' | 'refreshThread'>;
  latest: () => ListModel | null;
  filesSignals: KeyedSignal;
}

/**
 * The reads that follow every thread on screen, in whichever pane (panes/model.ts), where one open thread was read
 * before: after records, on a catch-up or a refresh, and when a linked machine's frames name its threads.
 */
export function createShownReads({ reads, latest, filesSignals }: ShownReadsDeps) {
  const machineTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const readAll = (threads: readonly string[]): Promise<(InboxThread | null)[]> => Promise.all(threads.map((id) => reads.refreshThread(id)));
  return {
    /** Each thread on screen, read again: a catch-up, a refresh, after the person's own write. */
    all: () => readAll(reads.shown()),
    /**
     * The records of a pause (openThreadReads.ts): each thread on screen reads what they owe it. One they owe nothing
     * is read anyway when the list read that came with them no longer lists it (deleted elsewhere, which no record says).
     */
    afterRecords: (records: RecordBatch, listRead: Promise<ListModel | null>): Promise<unknown> => {
      const owed: string[] = [];
      for (const threadId of reads.shown()) {
        const { load, loaded, loadedAt } = reads.readOf(threadId);
        const read = openThreadRead(records, {
          threadId,
          remote: machineOf(threadId) !== null,
          loaded,
          loadedAt,
          now: Date.now(),
          settled: load === null || load.threadId !== threadId,
          listed: listsThread(latest(), threadId),
        });
        if (read === 'thread') {
          owed.push(threadId);
          continue;
        }
        if (read === 'files') filesSignals.emit(threadId);
        void listRead.then((next) => {
          if (reads.shown().includes(threadId) && !listsThread(next, threadId)) void reads.refreshThread(threadId);
        });
      }
      return readAll(owed);
    },
    /** A record from a linked machine: its threads on screen read again once its frames pause. */
    machineFrame: (machine: string) => {
      for (const threadId of reads.shown()) {
        if (machineOf(threadId) !== machine) continue;
        const timer = machineTimers.get(threadId);
        if (timer) clearTimeout(timer);
        machineTimers.set(
          threadId,
          setTimeout(() => {
            machineTimers.delete(threadId);
            if (reads.shown().includes(threadId)) void reads.refreshThread(threadId);
          }, MACHINE_THREAD_WAIT_MS),
        );
      }
    },
    /** Held writes settled (or one was delivered) on these machines: their threads on screen show them now. */
    onMachines: (machines: ReadonlySet<string>) => readAll(reads.shown().filter((id) => machines.has(machineOf(id) ?? ''))),
    /** The live sessions moved: a launched thread on screen reads its run line again. */
    launched: () => readAll(reads.shown().filter((id) => reads.readOf(id).loaded?.thread_id === id && !!reads.readOf(id).loaded?.messages[0]?.launch)),
    stop: () => {
      for (const timer of machineTimers.values()) clearTimeout(timer);
      machineTimers.clear();
    },
  };
}

export type ShownReads = ReturnType<typeof createShownReads>;
