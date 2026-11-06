/**
 * "Back from snooze" in the open thread (approval `snooze-back-line`,
 * 2026-11-05). The return lives on the row only until the first look, and the
 * opening look follows at once, so the window keeps what the row said for as
 * long as the person stays in the thread, as it does for "New since you looked".
 */
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { inboxRowSnoozed } from '@plannotator/core/inbox-snooze';

export interface SnoozeBack {
  threadId: string;
  /** When the snooze ran out. */
  until: string;
}

/**
 * What the open thread keeps after this row: a return stays until the person
 * leaves the thread (`threadId` changes or goes) or snoozes it again.
 */
export function snoozeBackAfter(current: SnoozeBack | null, threadId: string | null, row: Pick<InboxListRow, 'snoozed' | 'snooze_back'> | null): SnoozeBack | null {
  const kept = threadId && current?.threadId === threadId ? current : null;
  if (!threadId || !row) return kept;
  if (inboxRowSnoozed(row)) return null;
  if (!row.snooze_back) return kept;
  return kept?.until === row.snooze_back ? kept : { threadId, until: row.snooze_back };
}

/** The message the line sits above: the first new one, or with nothing new the last, whoever sent it. */
export function snoozeBackAbove(messages: readonly { id: string }[], fresh: ReadonlySet<string>): string | null {
  return (messages.find((message) => fresh.has(message.id)) ?? messages[messages.length - 1])?.id ?? null;
}
