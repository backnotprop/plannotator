/**
 * Mark all as read on the list (the list's ⋮, and the button on the "New since you looked" band): which rows it
 * takes. Pure. The project menu's rule (App.tsx `projectAction`): every row single Mark read is offered on
 * (markRead.ts `offersRowMarkRead`), never a snoozed one. The ⋮ takes every row the list shows (its filter is already
 * in `sections`); the band takes only its own rows. bulkWrites.ts `markRead` writes them, with one toast and one Undo.
 */
import type { InboxListRow, InboxListSection } from '@plannotator/core/inbox-types';
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
