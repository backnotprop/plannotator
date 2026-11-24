/**
 * The routines, read once and shared by the page, the list rows and a thread's foot: this computer's and every linked
 * computer's that takes them (the merged read, client.ts). Read while Routines are on here or a linked computer takes
 * them, and something shows them; read again on a `scheduled` record, a run or skip line, a launch's run line moving
 * while the page is open or a run is under way (a run's end is only that), any record of a linked computer while the
 * page is open, a reconnect, and the window shown again while a run is under way (CONTRACT.md section 4).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { InboxEvent, SettingsModel } from '../api';
import { linkedMachinesWith, onLinkedMachines, onLinkedMachinesListed } from '../inboxUrl';
import { scheduledApi, setRoutineRowReader, type RoutineComputer } from './client';

/** The mark a linked computer's list carries when its routines can be read and changed from here. */
export const ROUTINES_MARK = 'routines';

export interface ScheduledSnapshot {
  /** Routines' switch on this computer: null while the window's settings are not read yet (the list filter waits on it). */
  on: boolean | null;
  rows: readonly InboxScheduledRow[] | null;
  /** False: "Start agents from New message" is off here, so nothing of this computer's runs. */
  launchOn: boolean;
  /** The linked computers that take routines, as the last read said (whether they are on there, and away). */
  computers: readonly RoutineComputer[];
  error: string | null;
  /** Counts every change seen, so an open editor reads its own record again. */
  version: number;
}

const EMPTY: ScheduledSnapshot = { on: false, rows: null, launchOn: true, computers: [], error: null, version: 0 };
let on: boolean | null = false;
let snap = EMPTY;
let reading: Promise<void> | null = null;
let again = false;
let pages = 0;
const listeners = new Set<() => void>();
/** Hear changes without asking for a read (see `watch`). */
const watchers = new Set<() => void>();

function emit(next: Partial<ScheduledSnapshot>) {
  snap = { ...snap, ...next };
  for (const listener of listeners) listener();
  for (const watcher of watchers) watcher();
}

setRoutineRowReader((id) => snap.rows?.find((row) => row.id === id) ?? null);

/** Something to read: Routines on here, or a linked computer that takes them (once the settings are read). */
const wanted = () => on === true || (on !== null && linkedMachinesWith(ROUTINES_MARK).length > 0);

/** A linked computer has Routines on, so its routines can be listed and made from here. */
export const farRoutinesOn = (s: Pick<ScheduledSnapshot, 'computers'>): boolean => s.computers.some((c) => c.on);

/**
 * A linked computer that is away: its routines as it last said, with nothing live claimed for it. A run it said was
 * going keeps its Stop (held, it ends that run only) but no running time (`running_since`, which the Running marks
 * read), and no next run is counted down.
 */
export function lastKnownRows(rows: readonly InboxScheduledRow[], computers: readonly RoutineComputer[]): InboxScheduledRow[] {
  const away = new Set(computers.filter((c) => c.away).map((c) => c.id));
  if (away.size === 0) return [...rows];
  return rows.map((row) => (row.machine && away.has(row.machine) ? { ...row, running_since: null, next_run: null } : row));
}

/** The row's computer is away (its row is as that computer last said). */
export const rowAway = (s: Pick<ScheduledSnapshot, 'computers'>, row: Pick<InboxScheduledRow, 'machine'>): boolean => !!row.machine && s.computers.some((c) => c.id === row.machine && c.away);

export function readScheduled(): Promise<void> {
  if (!wanted()) return Promise.resolve();
  if (reading) {
    again = true;
    return reading;
  }
  reading = scheduledApi.list().then(
    (answer) => {
      const computers = answer.computers ?? [];
      emit({ rows: lastKnownRows(answer.scheduled, computers), launchOn: answer.launch_on, computers, error: null, version: snap.version + 1 });
    },
    (error: unknown) => emit({ error: error instanceof Error ? error.message : String(error) }),
  );
  return reading.finally(() => {
    reading = null;
    if (again) {
      again = false;
      void readScheduled();
    }
  });
}

/** `null`: the settings are not read yet, so whether Routines are on is not known (nothing is read). */
export function setScheduledOn(next: boolean | null): void {
  if (on === next) return;
  on = next;
  if (!wanted()) emit({ ...EMPTY, on, version: snap.version + 1 });
  else {
    emit({ on });
    if (listeners.size > 0) void readScheduled();
  }
}

// A linked computer that takes routines, named for the first time: its routines are read in. A first read that failed
// (nothing read yet) is tried again on the next merged list, which names the same computers and so changes nothing.
const readFirst = () => {
  if (wanted() && listeners.size > 0 && snap.rows === null && !reading) void readScheduled();
};
onLinkedMachines(readFirst);
onLinkedMachinesListed(readFirst);

/** A run under way: its end writes no store line, only the launch's run line moving (`event: deliveries`). */
const anyRunning = () => !!snap.rows?.some((row) => row.state === 'running');

/**
 * From the event stream (eventFrames.ts): `null` is a `deliveries` frame, `'connect'` a (re)connect's `hello`. A run
 * ending moves only its launch's run line, so `deliveries` reads again while the page is open or a run is under way
 * (a list row's Running, a thread's foot); a reconnect reads again, as nothing replays a `deliveries` it missed.
 */
export function scheduledFrame(event: InboxEvent | null | 'connect'): void {
  if (!wanted() || listeners.size === 0) return;
  if (event === 'connect' || (event === null ? pages > 0 || anyRunning() : event.kind === 'scheduled' || (event.kind === 'message' && !!(event.message.scheduled_run || event.message.scheduled_change)))) void readScheduled();
}

/** The window shown again (a wake, a tab brought back): a run under way may have ended unheard meanwhile. */
function onShown() {
  if (document.visibilityState === 'visible' && wanted() && listeners.size > 0 && (pages > 0 || anyRunning())) void readScheduled();
}

/** A linked computer's record (eventFrames.ts `machine`): its routines, run lines and runs moving, read again. */
export function scheduledMachineFrame(record: InboxEvent | null): void {
  if (!wanted() || listeners.size === 0 || snap.computers.length === 0) return;
  if (pages > 0 || (record && (record.kind === 'scheduled' || (record.kind === 'message' && !!(record.message.scheduled_run || record.message.scheduled_change))))) void readScheduled();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0 && typeof document !== 'undefined') document.addEventListener('visibilitychange', onShown);
  listeners.add(listener);
  if (wanted() && snap.rows === null && !reading) void readScheduled();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && typeof document !== 'undefined') document.removeEventListener('visibilitychange', onShown);
  };
}
const current = () => snap;

/** Hears the store without counting as something that shows routines: it asks for no read. */
function watch(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}
const farOnNow = () => farRoutinesOn(snap);

export function useScheduled(): ScheduledSnapshot {
  return useSyncExternalStore(subscribe, current, current);
}

/** The page: also reads again when a run starts or ends. */
export function useScheduledPage(): ScheduledSnapshot {
  useEffect(() => {
    pages += 1;
    void readScheduled();
    return () => {
      pages -= 1;
    };
  }, []);
  return useScheduled();
}

/**
 * Whether the Routines page is offered: Routines on here, from the window's settings, or on a linked computer. The
 * store reads only while one of them may be. Until the settings are read it is not known (`null` in the store);
 * `settingsFailed`: they could not be read, so it is off here.
 */
export function useScheduledOn(settings: Pick<SettingsModel, 'scheduled_threads'> | null, settingsFailed = false): boolean {
  const value = settings?.scheduled_threads?.on === true;
  const known = settings !== null || settingsFailed;
  useEffect(() => setScheduledOn(known ? value : null), [known, value]);
  // One hook call on every render (a call skipped once Routines turn on breaks the window's hooks). With Routines on
  // here it only watches, so the window reads nothing more than it did before linked computers; off, it reads, so a
  // linked computer's routines can offer the page.
  const far = useSyncExternalStore(value ? watch : subscribe, farOnNow, farOnNow);
  return value || far;
}

/** Saved rows go in at once, before the read again. */
export function putScheduled(row: InboxScheduledRow | null, removed?: string): void {
  // An answer that comes back after a newer one (two writes in flight) never puts the older row back.
  const held = row ? snap.rows?.find((r) => r.id === row.id) : undefined;
  if (row && held && held.updated_at > row.updated_at) return;
  // A far row keeps its computer: that computer's answer names none.
  const kept = row && held?.machine && !row.machine ? { ...row, machine: held.machine } : row;
  const rows = (snap.rows ?? []).filter((r) => r.id !== (row?.id ?? removed));
  emit({ rows: kept ? [...rows, kept] : rows, version: snap.version + 1 });
}

/** Tests: a fresh store. */
export function resetScheduledForTests(rows: readonly InboxScheduledRow[] | null = null, isOn: boolean | null = rows !== null, computers: readonly RoutineComputer[] = []): void {
  on = isOn;
  reading = null;
  again = false;
  pages = 0;
  snap = { ...EMPTY, on: isOn, rows, computers };
}
