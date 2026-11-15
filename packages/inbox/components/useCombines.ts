/**
 * Combines the window follows (approval "inbox-multi-select", 4A; combineApi.ts): while one waits for its new thread,
 * its rows say "Combining…" and every machine holding one is read every few seconds. When the thread arrives the toast
 * says so, with Undo (the picked threads come back) and Open; when the agent ends or stops without it, the toast says
 * nothing was archived. A Combine that settled while no window watched is told once, on the next load (`TOLD_KEY`).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxCombineRecord, InboxListRow } from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import type { BulkWrites } from '../bulkWrites';
import { combineApi } from '../combineApi';
import { rememberMachine } from '../inboxUrl';
import { isAway, type MachinesModel } from '../machines';
import { errorToast } from '../toastError';

const POLL_MS = 4000;
const TOLD_KEY = 'plannotator-inbox-combines-told';
const TOLD_KEPT = 20;

interface Tracked {
  record: InboxCombineRecord;
  machine: string | null;
  /** The picked rows as they were, for Undo's snooze and Priority (a Combine started in this window). */
  rows?: readonly InboxListRow[];
}

// This browser's own list (never a cookie: it would ride every request).
const TOLD_WITHIN_MS = 24 * 60 * 60 * 1000;
const fresh = (record: InboxCombineRecord) => Date.now() - Date.parse(record.settled_at ?? record.at) < TOLD_WITHIN_MS;
const told = (): string[] => {
  try {
    const value = JSON.parse(localStorage.getItem(TOLD_KEY) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
  } catch {
    return [];
  }
};
const tell = (id: string) => {
  try {
    localStorage.setItem(TOLD_KEY, JSON.stringify([...told().filter((t) => t !== id), id].slice(-TOLD_KEPT)));
  } catch {
    // Private mode or a full store: the toast may show again on the next load.
  }
};

const FAILED: Record<NonNullable<InboxCombineRecord['reason']>, string> = {
  ended: 'Its session ended. Nothing was archived.',
  nothing: 'It finished without writing the new thread. Nothing was archived.',
  timeout: 'It never wrote the new thread. Nothing was archived.',
};

/** The machines that may hold Combines: this one, and each linked one there now that takes them. */
const combineMachines = (machines: MachinesModel | undefined): (string | null)[] => [null, ...(machines?.linked ?? []).filter((m) => !isAway(m) && (m.marks ?? []).includes('combine')).map((m) => m.id)];

export function useCombines(bulk: BulkWrites | undefined, machines: MachinesModel | undefined) {
  const tracked = useRef(new Map<string, Tracked>());
  const [waiting, setWaiting] = useState<ReadonlyMap<string, string>>(new Map());
  const bulkRef = useRef(bulk);
  bulkRef.current = bulk;

  /** Which thread waits in which Combine, for the rows' menu (Stop combining). */
  const sync = () => setWaiting(new Map([...tracked.current.values()].filter((t) => t.record.state === 'asked').flatMap((t) => t.record.threads.map((thread) => [thread.id, t.record.id] as const))));

  const undo = useCallback(async (t: Tracked) => {
    const host = bulkRef.current?.host;
    if (!host) return;
    host.dismissToast();
    try {
      await combineApi.change(t.record.id, 'undo', t.machine);
      for (const row of t.rows ?? []) {
        await host.restoreSnooze(row.thread_id, row.snoozed);
        await host.restorePriority(row.thread_id, row.priority);
      }
      host.say('Combine undone.');
    } catch (cause) {
      host.showToast(errorToast(cause, 'The threads did not come back.'));
    }
    void host.afterWrite(t.record.threads.map((thread) => thread.id));
  }, []);

  /** A Combine's new state, and the toast for an ending no window told yet. */
  const settle = useCallback(
    (t: Tracked, next: InboxCombineRecord) => {
      const host = bulkRef.current?.host;
      const was = t.record.state;
      t.record = next;
      if (next.state === 'asked') return;
      if (!host || told().includes(next.id) || (was !== 'asked' && next.state !== 'done' && next.state !== 'failed')) return;
      tell(next.id);
      const n = plural(next.threads.length, 'thread');
      if (next.state === 'done' && next.thread) {
        const opened = next.thread.id;
        if (t.machine) rememberMachine([opened], t.machine);
        host.showToast({ icon: 'check', lead: `Combined ${n}`, phoneLead: 'Combined', detail: `into “${next.thread.subject}”`, onUndo: () => void undo(t), action: { label: 'Open', onPress: () => host.openThread(opened) } });
        void host.afterWrite(next.threads.map((thread) => thread.id));
      } else if (next.state === 'failed') {
        host.showToast({ icon: 'warn', lead: `${next.name} did not combine the ${n}`, detail: FAILED[next.reason ?? 'timeout'], wrap: true });
      }
    },
    [undo],
  );

  /** Reads each machine's Combines and settles what changed. */
  const read = useCallback(
    async (only?: ReadonlySet<string | null>) => {
      const list = combineMachines(machinesRef.current).filter((m) => !only || only.has(m));
      await Promise.all(
        list.map(async (machine) => {
          const answer = await combineApi.list(machine).catch(() => null);
          for (const record of answer?.combines ?? []) {
            const known = tracked.current.get(record.id);
            if (known) settle(known, record);
            else {
              const t: Tracked = { record, machine };
              tracked.current.set(record.id, t);
              // First seen settled: told on this load only when no window told it yet, and within a day (a browser
              // opening this Inbox for the first time is not told of old ones).
              if ((record.state === 'done' || record.state === 'failed') && !told().includes(record.id) && fresh(record)) settle({ ...t, record: { ...record, state: 'asked' } }, record);
            }
          }
        }),
      );
      sync();
    },
    [settle],
  );
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const linkedKey = combineMachines(machines).join(',');
  useEffect(() => {
    if (bulk) void read();
    // Read once per set of machines; the poll below follows those waiting.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linkedKey, !!bulk]);
  const anyWaiting = waiting.size > 0;
  useEffect(() => {
    if (!anyWaiting) return;
    const timer = setInterval(() => {
      const machinesWaiting = new Set([...tracked.current.values()].filter((t) => t.record.state === 'asked').map((t) => t.machine));
      void read(machinesWaiting);
    }, POLL_MS);
    return () => clearInterval(timer);
  }, [anyWaiting, read]);

  /** A Combine this window just started: drawn at once, and its toast's Undo stops it. */
  const begin = (record: InboxCombineRecord, machine: string | null, rows: readonly InboxListRow[]) => {
    const host = bulkRef.current?.host;
    const t: Tracked = { record, machine, rows };
    tracked.current.set(record.id, t);
    sync();
    host?.showToast({ icon: 'clock', lead: `Asked ${record.name} to combine ${plural(record.threads.length, 'thread')}`, phoneLead: 'Combining', onUndo: () => void stop(record.id) });
  };
  /** Stop one still waiting (its toast's Undo, or a row's Stop combining). */
  const stop = async (id: string) => {
    const t = tracked.current.get(id);
    const host = bulkRef.current?.host;
    if (!t || !host) return;
    host.dismissToast();
    try {
      const { combine } = await combineApi.change(id, 'cancel', t.machine);
      settle(t, combine);
      sync();
      host.say('Combine stopped.');
    } catch (cause) {
      host.showToast(errorToast(cause, 'The Combine did not stop.'));
    }
  };
  return { waiting, begin, stop };
}

export type CombinesTracker = ReturnType<typeof useCombines>;
