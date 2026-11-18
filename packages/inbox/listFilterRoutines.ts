/**
 * The list filter's Routine group (listFilter.ts): which rows are a routine's thread. The list row carries nothing
 * that says so, so this reads this computer's own routines and matches by thread, the row look's own rule
 * (scheduled/rowLook.tsx `scheduledLook`): a row from another linked machine is an ordinary thread.
 *
 * `null` while Routines are off or not read yet: the Routine picks step aside (`appliedFilter`) and the menu offers
 * no Routine group.
 */
import { useMemo } from 'react';
import type { InboxScheduledRow } from '@plannotator/core/inbox-scheduled-types';
import type { RowIsRoutine } from './listFilter';
import { selfMachineId } from './inboxUrl';
import { useScheduled } from './scheduled/store';

export function routineThreadTest(scheduled: readonly InboxScheduledRow[] | null): RowIsRoutine | null {
  if (scheduled === null) return null;
  const threads = new Set(scheduled.flatMap((s) => (s.thread_id ? [s.thread_id] : [])));
  return (row) => threads.has(row.thread_id) && (!row.machine || row.machine === selfMachineId());
}

/** The window's test, from the routines store (read only while Routines are on). */
export function useRoutineThreads(): RowIsRoutine | null {
  const rows = useScheduled().rows;
  return useMemo(() => routineThreadTest(rows), [rows]);
}
