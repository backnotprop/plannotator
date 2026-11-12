/**
 * Row actions drawn the moment they are pressed (data-layer brief, 2026-11-10: Mark read, Archive and Star waited
 * for the write and two reads in a row, about a second on a poor link). The window draws the row as the write makes
 * it, sends the write, and the server's row takes the drawn one's place when the list read after it lands. A write
 * that fails takes the drawn row away again, and the action's own error says why (the window's `showError`).
 *
 * Only what the write certainly does is drawn: Mark read reads the row as read (not bold, `read_at` set, which
 * presses the header's Read); Archive shows it archived in place (as `markHeldRowArchived` always did once the write
 * landed); Star adds or takes away the star. Everything else on the row (its group, its chips) comes with the
 * server's row, as before. Mark unread, Move back and Snooze still wait for their answer: what they do depends on
 * the server (a thread already unread, a time already past on the home machine).
 */
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';

export type RowPatch = Partial<Pick<InboxListRow, 'read_at' | 'unread' | 'unseen' | 'resolved_at' | 'section'>>;

/** Mark read, drawn at once: read, not bold, nothing unseen. */
export function readRowPatch(at: string): RowPatch {
  return { read_at: at, unread: false, unseen: 0 };
}

/** Archive, drawn at once: archived in place, as the list draws an archived row while its thread is open. */
export function archivedRowPatch(row: Pick<InboxListRow, 'resolved_at'> | null | undefined, at: string): RowPatch {
  return { resolved_at: row?.resolved_at ?? at, section: 'quiet', unread: false };
}

/** A row with the patch drawn over it (the same row when none). */
export function patchedRow<T extends InboxListRow | null | undefined>(row: T, patches: ReadonlyMap<string, RowPatch>): T {
  if (!row) return row;
  const patch = patches.get(row.thread_id);
  return patch ? ({ ...row, ...patch } as T) : row;
}

/** The list on screen with one row patched in place (its group never changes). */
export function patchShownRow(shown: readonly InboxListSection[], threadId: string, patch: RowPatch): InboxListSection[] {
  return shown.map((section) =>
    section.threads.some((row) => row.thread_id === threadId)
      ? { ...section, threads: section.threads.map((row) => (row.thread_id === threadId ? { ...row, ...patch } : row)) }
      : section,
  );
}

/** The row as the list on screen draws it, to put back if the write fails. */
export function shownRowOf(shown: readonly InboxListSection[] | null, threadId: string): InboxListRow | null {
  for (const section of shown ?? []) for (const row of section.threads) if (row.thread_id === threadId) return row;
  return null;
}

/** The pinned threads with each Star or Unstar on its way drawn already. */
export function withPinPatches(pinned: Set<string>, patches: ReadonlyMap<string, boolean>): Set<string> {
  if (patches.size === 0) return pinned;
  const out = new Set(pinned);
  for (const [threadId, on] of patches) {
    if (on) out.add(threadId);
    else out.delete(threadId);
  }
  return out;
}

/** A map with one entry set or taken away (state updates). */
export function withEntry<V>(map: ReadonlyMap<string, V>, key: string, value: V | undefined): ReadonlyMap<string, V> {
  const next = new Map(map);
  if (value === undefined) next.delete(key);
  else next.set(key, value);
  return next;
}
