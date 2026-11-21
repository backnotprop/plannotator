/**
 * Mark all as read on the list (the list's ⋮, and the button on the "New since you looked" band): which rows it
 * takes. Pure. The project menu's rule (App.tsx `projectAction`): every row single Mark read is offered on
 * (markRead.ts `offersRowMarkRead`), never a snoozed one. The ⋮ takes every row the list shows (its filter is already
 * in `sections`); the band takes only its own rows. bulkWrites.ts `markAllRead` writes them (`currentMarkAllRows`),
 * with one toast and one Undo.
 */
import type { InboxListGroupId, InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
import { waitsBehindShow } from './held';
import { offersRowMarkRead } from './markRead';

/** The rows of these sections Mark all as read takes, each once, in the order drawn. */
function takes(sections: readonly InboxListSection[]): InboxListRow[] {
  const seen = new Set<string>();
  const out: InboxListRow[] = [];
  for (const section of sections) {
    for (const row of section.threads) {
      if (seen.has(row.thread_id) || row.snoozed || !offersRowMarkRead(row, section.id)) continue;
      seen.add(row.thread_id);
      out.push(row);
    }
  }
  return out;
}

/** The list's ⋮ Mark all as read: every row the list shows that takes it. */
export function listMarkAllRows(sections: readonly InboxListSection[]): InboxListRow[] {
  return takes(sections);
}

/** The "New since you looked" band's button: that band's rows only; none when the list draws no such band. */
export function bandMarkAllRows(sections: readonly InboxListSection[]): InboxListRow[] {
  const band = sections.find((section) => section.id === 'new');
  return band ? takes([band]) : [];
}

/**
 * The rows Mark all as read writes, from the rows it took off the list as drawn: each thread's row as it is now
 * (`rowOf`), since the list holds still and a drawn row can be older (held.ts `refreshHeldRows`). A thread with agent
 * activity the list has not shown yet is left out: that news waits behind "N new · Show", and Mark read would close a
 * question the person never saw, so the thread stays new. So is a thread gone from the list, snoozed since, or no
 * longer offering Mark read (read elsewhere, say). `drawnIn`: the group the list draws the thread in.
 */
export function currentMarkAllRows(
  drawn: readonly InboxListRow[],
  rowOf: (threadId: string) => InboxListRow | undefined,
  drawnIn: (threadId: string) => InboxListGroupId | null,
): InboxListRow[] {
  return drawn.flatMap((row) => {
    const now = rowOf(row.thread_id);
    return now && !now.snoozed && !waitsBehindShow(row, now) && offersRowMarkRead(now, drawnIn(row.thread_id)) ? [now] : [];
  });
}
