/**
 * The list filter's Routine group (listFilter.ts): which rows are a routine's thread. The list row carries nothing
 * that says so, so this reads the routines (this computer's and every linked computer's) and matches by thread, the
 * row look's own rule (scheduled/rowLook.tsx `scheduledLook`). Thread ids are ULIDs: one names one computer's thread.
 *
 * Three states, never "not read" read as "no routine threads":
 * - `off`: Routines are off, or their read failed. The Routine picks step aside (`appliedFilter`) and no group is offered.
 * - `pending`: the settings or the routines are not read yet. A saved Routine pick holds the list (`routineHold`): no
 *   row is drawn until it can be applied, and the badge still counts it. With no Routine pick nothing waits.
 * - `ready`: the test applies.
 */
import { useMemo } from 'react';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { ListFilter, RowIsRoutine } from './listFilter';
import { farRoutinesOn, useScheduled, type ScheduledSnapshot } from './scheduled/store';

export type RoutineThreads = { state: 'off' } | { state: 'pending' } | { state: 'ready'; test: RowIsRoutine };

export function routineThreadTest(scheduled: readonly InboxScheduledRow[] | null): RowIsRoutine | null {
  if (scheduled === null) return null;
  return testOf(new Set(scheduled.flatMap((s) => (s.thread_id ? [s.thread_id] : []))));
}

const testOf = (threads: ReadonlySet<string>): RowIsRoutine => (row) => threads.has(row.thread_id);

export function routineThreadsState(snap: Pick<ScheduledSnapshot, 'on' | 'rows' | 'error'> & Partial<Pick<ScheduledSnapshot, 'computers'>>): RoutineThreads['state'] {
  if (snap.on === false && !farRoutinesOn({ computers: snap.computers ?? [] })) return 'off';
  if (snap.rows !== null) return 'ready';
  return snap.on === true && snap.error !== null ? 'off' : 'pending';
}

/** The routines' thread ids, sorted, as one key: a read that changes none of them keeps the same test. */
const threadKey = (rows: readonly InboxScheduledRow[]) => [...new Set(rows.flatMap((s) => (s.thread_id ? [s.thread_id] : [])))].sort().join('\n');

/** The window's state, from the routines store (read only while Routines are on). */
export function useRoutineThreads(): RoutineThreads {
  const snap = useScheduled();
  const state = routineThreadsState(snap);
  const key = state === 'ready' && snap.rows ? threadKey(snap.rows) : null;
  return useMemo<RoutineThreads>(() => (state === 'ready' ? { state, test: testOf(new Set(key ? key.split('\n') : [])) } : { state }), [state, key]);
}

/** The Routine picks wait for the routines: the list is held, no row drawn, until they are read. */
export const routineHold = (routines: RoutineThreads, applied: Pick<ListFilter, 'routines'>): boolean => routines.state === 'pending' && applied.routines.length > 0;
