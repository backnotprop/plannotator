/**
 * After records arrive, the window reads the drafts again only when those
 * records can change what the drafts read shows (#2593). It used to read them
 * after every record, an agent's message to any thread included.
 *
 * What `GET /api/inbox/drafts` carries, and what changes it:
 *  - `replies`: every open thread holding unsent work (reply words, picks,
 *    comments), each with its list row. A record changes it only when it is of
 *    a thread that held unsent work (the row changed, or the work was sent,
 *    archived or closed) or holds it after (a pick, a comment, an Unarchive);
 *  - `drafts`: compose drafts, which only a draft save, delete or Send changes
 *    (in any window: the stream's `event: drafts` with `compose: true` reads
 *    them by itself), and each draft's session status, which the Drafts page
 *    follows by itself and, while it is open, after every record as before;
 *  - a record the window cannot place (a project, a kind it does not know, a
 *    pick save's read owed with no record): read, as before;
 *  - and a list read whose rows holding unsent work are not the reply drafts
 *    shown (`replyDraftsDiffer`): a deleted thread or project, which no record
 *    says.
 */
import { inboxHasUnsent, type InboxListRow, type InboxListSection } from '@plannotator/core/inbox-types';
import type { RecordBatch } from './openThreadReads';

/** The threads a list read shows holding unsent work (any section, and the snoozed ones). */
export function unsentThreads(list: { sections: readonly InboxListSection[]; snoozed?: readonly InboxListRow[] } | null | undefined): Set<string> {
  const threads = new Set<string>();
  if (!list) return threads;
  for (const section of list.sections) for (const row of section.threads) if (inboxHasUnsent(row.unsent)) threads.add(row.thread_id);
  for (const row of list.snoozed ?? []) if (inboxHasUnsent(row.unsent)) threads.add(row.thread_id);
  return threads;
}

/**
 * Whether the reply drafts the window shows (`GET /api/inbox/drafts`' `replies`, this machine's only) are other
 * threads than this machine's rows holding unsent work in a list read: something no record says changed them (a
 * thread or project deleted, here or elsewhere). Rows of a linked machine are left out (`machine` other than the
 * list's `self`): their unsent work is never in `replies`, so counting them would owe a read after every list read.
 */
export function replyDraftsDiffer(
  replies: readonly { thread_id: string }[],
  list: { sections: readonly InboxListSection[]; snoozed?: readonly InboxListRow[]; self?: string } | null | undefined,
): boolean {
  if (!list) return false;
  const local = new Set<string>();
  const add = (row: InboxListRow) => {
    if (inboxHasUnsent(row.unsent) && (row.machine === undefined || row.machine === list.self)) local.add(row.thread_id);
  };
  for (const section of list.sections) for (const row of section.threads) add(row);
  for (const row of list.snoozed ?? []) add(row);
  const shown = new Set(replies.map((row) => row.thread_id));
  if (shown.size !== local.size) return true;
  for (const threadId of shown) if (!local.has(threadId)) return true;
  return false;
}

/** Whether these records can change the drafts read, given threads known to hold unsent work (before or after them). */
export function draftsReadOwed(batch: RecordBatch, holding: Iterable<string>): boolean {
  if (batch.any) return true;
  for (const threadId of holding) if (batch.threads.has(threadId)) return true;
  return false;
}
