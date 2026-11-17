/**
 * Combines the window follows (approval "inbox-multi-select", 4A; combineApi.ts): the ones this browser started
 * (`WATCH_KEY`), and nothing else, so an Inbox where nobody combines reads nothing for them. While one waits for its
 * new thread its rows say "Combining…" and its machine is read every few seconds. When the thread arrives the toast says
 * so, with Undo (the picked threads come back) and Open; when the agent ends or stops without it, the toast says nothing
 * was archived, and the machine is read each minute for a day in case the thread still comes (then it is done after
 * all, and told so). Each ending is told once (`TOLD_KEY`), on the next load when no window was open.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxCombineRecord, InboxListRow } from '@plannotator/core/inbox-types';
import { plural } from '@plannotator/core/inbox-format';
import { bulkWrites, type BulkHost, type BulkWrites } from '../bulkWrites';
import { combineApi } from '../combineApi';
import { rememberMachine } from '../inboxUrl';
import { isAway, type MachinesModel } from '../machines';
import { errorToast } from '../toastError';

const POLL_MS = 4000;
/** A failed one, read this often while it may still be done after all. */
const LATE_POLL_MS = 60_000;
/** Watched this long after its start: as long as the server waits for an undelivered wake. */
const WATCH_MS = 24 * 60 * 60 * 1000;
const WATCH_KEY = 'plannotator-inbox-combines-watch';
const TOLD_KEY = 'plannotator-inbox-combines-told';
const TOLD_KEPT = 40;

interface Tracked {
  record: InboxCombineRecord;
  machine: string | null;
  /** The picked rows as they were, for Undo's snooze and Priority (a Combine started in this window). */
  rows?: readonly InboxListRow[];
}

interface Watched {
  id: string;
  machine: string | null;
  at: string;
}

// This browser's own lists (never a cookie: it would ride every request). Private mode or a full store: a toast may
// show again, or a Combine is not followed after a reload.
const readList = <T>(key: string, ok: (v: unknown) => v is T): T[] => {
  try {
    const value = JSON.parse(localStorage.getItem(key) ?? '[]') as unknown;
    return Array.isArray(value) ? value.filter(ok) : [];
  } catch {
    return [];
  }
};
const writeList = (key: string, list: unknown[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(list));
  } catch {
    // As above.
  }
};
const isWatched = (v: unknown): v is Watched => !!v && typeof (v as Watched).id === 'string' && typeof (v as Watched).at === 'string' && ((v as Watched).machine === null || typeof (v as Watched).machine === 'string');
const watched = () => readList(WATCH_KEY, isWatched).filter((w) => Date.now() - Date.parse(w.at) < WATCH_MS);
const watch = (w: Watched) => writeList(WATCH_KEY, [...watched().filter((x) => x.id !== w.id), w]);
const unwatch = (id: string) => writeList(WATCH_KEY, watched().filter((w) => w.id !== id));
/** Each ending is told once: a failure, and a done that comes after it, are two. */
const told = () => readList(TOLD_KEY, (v): v is string => typeof v === 'string');
const tellKey = (record: InboxCombineRecord) => `${record.id}:${record.state}`;
const tell = (record: InboxCombineRecord) => writeList(TOLD_KEY, [...told().filter((t) => t !== tellKey(record)), tellKey(record)].slice(-TOLD_KEPT));

const FAILED: Record<NonNullable<InboxCombineRecord['reason']>, string> = {
  ended: 'Its session ended. Nothing was archived.',
  nothing: 'It finished without writing the new thread. Nothing was archived.',
  timeout: 'It never wrote the new thread. Nothing was archived.',
};

/** A watched Combine's machine can be read now: this one, or a linked one there that takes Combines. */
const readable = (machine: string | null, machines: MachinesModel | undefined) => machine === null || (machines?.linked ?? []).some((m) => m.id === machine && !isAway(m) && (m.marks ?? []).includes('combine'));

/** The list's bulk writes (bulkWrites.ts) with this window's Combines on them: what the window hands its list. */
export function useBulkWrites(host: BulkHost, machines: MachinesModel | undefined) {
  const base = bulkWrites(host);
  return { ...base, combines: useCombines(base, machines) };
}

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
      // Done, stopped or undone: nothing more to follow. Failed: followed until its day is out.
      if (next.state !== 'failed') unwatch(next.id);
      if (!host || told().includes(tellKey(next)) || (next.state !== 'done' && next.state !== 'failed') || was === next.state) return;
      tell(next);
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

  /** Reads the machines of the watched Combines that pass `which`, and settles what changed. */
  const read = useCallback(
    async (which: (w: Watched) => boolean) => {
      const list = watched().filter((w) => readable(w.machine, machinesRef.current) && which(w));
      const ids = new Set(list.map((w) => w.id));
      await Promise.all(
        [...new Set(list.map((w) => w.machine))].map(async (machine) => {
          const answer = await combineApi.list(machine).catch(() => null);
          for (const record of answer?.combines ?? []) {
            if (!ids.has(record.id)) continue;
            const known = tracked.current.get(record.id);
            if (known) settle(known, record);
            else {
              // After a reload: told now when no window told this ending yet.
              const t: Tracked = { record: { ...record, state: 'asked' }, machine };
              tracked.current.set(record.id, t);
              settle(t, record);
            }
          }
        }),
      );
      sync();
      setFollowing(watched().length > 0);
    },
    [settle],
  );
  const machinesRef = useRef(machines);
  machinesRef.current = machines;
  const [following, setFollowing] = useState(() => watched().length > 0);
  // Each machine is read once at load (and once when it can be read again); after that the poll follows. Nothing this
  // browser started still to follow: no read at all.
  const readOnce = useRef(new Set<string>());
  const machineKey = (m: string | null) => m ?? 'here';
  const unread = [...new Set(watched().filter((w) => readable(w.machine, machines)).map((w) => machineKey(w.machine)))].filter((m) => !readOnce.current.has(m)).join(',');
  useEffect(() => {
    if (!bulk || !unread) return;
    const now = new Set(unread.split(','));
    for (const m of now) readOnce.current.add(m);
    void read((w) => now.has(machineKey(w.machine)));
  }, [unread, !!bulk, read]);
  const anyWaiting = waiting.size > 0;
  useEffect(() => {
    if (!anyWaiting && !following) return;
    const timer = setInterval(() => void read((w) => !anyWaiting || tracked.current.get(w.id)?.record.state !== 'failed'), anyWaiting ? POLL_MS : LATE_POLL_MS);
    return () => clearInterval(timer);
  }, [anyWaiting, following, read]);

  /** A Combine this window just started: drawn at once, and its toast's Undo stops it. */
  const begin = (record: InboxCombineRecord, machine: string | null, rows: readonly InboxListRow[]) => {
    const host = bulkRef.current?.host;
    const t: Tracked = { record, machine, rows };
    tracked.current.set(record.id, t);
    watch({ id: record.id, machine, at: record.at });
    setFollowing(true);
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
