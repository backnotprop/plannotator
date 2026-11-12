/**
 * The list's Priority group, the person's side: which item a row offers, and
 * where a row goes back to when it leaves. Pure.
 */

import { INBOX_SECTIONS, inboxRowArchived, type InboxListRow } from '@plannotator/core/inbox-types';
import { INBOX_SNOOZED_BAND } from '@plannotator/core/inbox-snooze';

/**
 * Add to Priority or Remove from Priority for a row, or null where neither is
 * offered: a row from an Inbox that keeps no priority, and Add on an archived
 * row. A linked machine's row also needs that machine to take it
 * (`machineTakes(row, model, 'priority')`, which the callers ask).
 */
export function priorityAction(row: Pick<InboxListRow, 'priority' | 'resolved_at' | 'back_from_archive'>): 'priority-add' | 'priority-remove' | null {
  if (row.priority === undefined) return null;
  if (row.priority !== null) return 'priority-remove';
  return inboxRowArchived(row) ? null : 'priority-add';
}

/** The group a row returns to when it leaves Priority, for Remove's toast ("Back in Waiting on you"); null when unknown. */
export function priorityBackIn(row: InboxListRow | null | undefined): string | null {
  if (!row) return null;
  if (inboxRowArchived(row)) return 'Back in Archived';
  if (row.snoozed) return `Back in ${INBOX_SNOOZED_BAND.label}`;
  const label = INBOX_SECTIONS.find((section) => section.id === row.section)?.label;
  return label ? `Back in ${label}` : null;
}
