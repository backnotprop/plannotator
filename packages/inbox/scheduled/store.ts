/**
 * This machine's routines, read once and shared by the page, the list rows and a thread's foot. Read while
 * the capability is on and something shows them; read again on a `scheduled` record, a run or skip line, and (while
 * the page is open) a launch's run line moving (CONTRACT.md section 4).
 */
import { useEffect, useSyncExternalStore } from 'react';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { InboxEvent, SettingsModel } from '../api';
import { scheduledApi } from './client';

export interface ScheduledSnapshot {
  /** Routines' switch: null while the window's settings are not read yet (the list filter waits on it). */
  on: boolean | null;
  rows: readonly InboxScheduledRow[] | null;
  /** False: "Start agents from New message" is off, so nothing runs. */
  launchOn: boolean;
  error: string | null;
  /** Counts every change seen, so an open editor reads its own record again. */
  version: number;
}

const EMPTY: ScheduledSnapshot = { on: false, rows: null, launchOn: true, error: null, version: 0 };
let on: boolean | null = false;
let snap = EMPTY;
let reading: Promise<void> | null = null;
let again = false;
let pages = 0;
const listeners = new Set<() => void>();

function emit(next: Partial<ScheduledSnapshot>) {
  snap = { ...snap, ...next };
  for (const listener of listeners) listener();
}

export function readScheduled(): Promise<void> {
  if (!on) return Promise.resolve();
  if (reading) {
    again = true;
    return reading;
  }
  reading = scheduledApi.list().then(
    (answer) => emit({ rows: answer.scheduled, launchOn: answer.launch_on, error: null, version: snap.version + 1 }),
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
  if (!on) emit({ ...EMPTY, on, version: snap.version + 1 });
  else {
    emit({ on });
    if (listeners.size > 0) void readScheduled();
  }
}

/** From the event stream (eventFrames.ts): `null` is a `deliveries` frame. */
export function scheduledFrame(event: InboxEvent | null): void {
  if (!on || listeners.size === 0) return;
  if (event === null ? pages > 0 : event.kind === 'scheduled' || (event.kind === 'message' && !!(event.message.scheduled_run || event.message.scheduled_change))) void readScheduled();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  if (on && snap.rows === null && !reading) void readScheduled();
  return () => listeners.delete(listener);
}
const current = () => snap;

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
 * The window's switch, from its settings: the store reads only while it is on. Until the settings are read it is not
 * known (`null` in the store); `settingsFailed`: they could not be read, so it is off.
 */
export function useScheduledOn(settings: Pick<SettingsModel, 'scheduled_threads'> | null, settingsFailed = false): boolean {
  const value = settings?.scheduled_threads?.on === true;
  const known = settings !== null || settingsFailed;
  useEffect(() => setScheduledOn(known ? value : null), [known, value]);
  return value;
}

/** Saved rows go in at once, before the read again. */
export function putScheduled(row: InboxScheduledRow | null, removed?: string): void {
  // An answer that comes back after a newer one (two writes in flight) never puts the older row back.
  const held = row ? snap.rows?.find((r) => r.id === row.id) : undefined;
  if (row && held && held.updated_at > row.updated_at) return;
  const rows = (snap.rows ?? []).filter((r) => r.id !== (row?.id ?? removed));
  emit({ rows: row ? [...rows, row] : rows, version: snap.version + 1 });
}

/** Tests: a fresh store. */
export function resetScheduledForTests(rows: readonly InboxScheduledRow[] | null = null, isOn: boolean | null = rows !== null): void {
  on = isOn;
  reading = null;
  again = false;
  pages = 0;
  snap = { ...EMPTY, on: isOn, rows };
}
