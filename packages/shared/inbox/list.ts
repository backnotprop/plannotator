/**
 * Plannotator Inbox: the list's sections, per thread. Pure: rows in, the
 * placed and ordered sections out.
 *
 * A ROW IS A THREAD (owner ruling 2026-10-07); the project is a label and a
 * filter, so a filtered list keeps the same sections and only drops rows.
 *
 * The sections and their order are Workspaces' approved inbox model
 * (`.product/approved/inbox-by-workspace-2026-10-05/`, the Sent band of
 * `inbox-sent-section-2026-10-06/`), read per thread here. The strongest
 * reason wins:
 *
 *   quiet     the thread is resolved (done)
 *   stopped   an open question says the agent cannot go on (`Stopped:`)
 *   holding   an open question names work that waits (`Holds up:`)
 *   waiting   any other open question
 *   new       every open question is picked and none sent ("Answered, not
 *             sent": it waits only for Send)
 *   sent      the person's reply is the last message and the agent has not
 *             read it yet; once it has, the row is Quiet
 *   new       agent messages the person has not looked at
 *   quiet     the remainder
 *
 * Order inside every section: newest first, by the thread's latest message
 * (`last_at`, the time the row shows), so the time column reads down in order
 * (owner ruling 2026-10-08: an older question sat above a newer one in
 * "Waiting on you"). A row moves when the thread gains a message: an agent's
 * new message, or the person's reply (which in most cases moves it to Sent).
 * Picks, looks and reads move it between sections only. Ties break on the
 * thread id, so the order is total.
 */

import {
  INBOX_SECTIONS,
  type InboxListRow,
  type InboxListSection,
  type InboxSectionId,
} from "@plannotator/core/inbox-types";

/** The facts a thread is placed by (all on its list row). */
export type InboxSectionFacts = Pick<
  InboxListRow,
  "resolved_at" | "questions" | "answered_not_sent" | "sent" | "unseen"
>;

export function inboxSectionOf(row: InboxSectionFacts): InboxSectionId {
  if (row.resolved_at !== null) return "quiet";
  if (row.questions.open > 0) {
    if (row.questions.stopped) return "stopped";
    if (row.questions.holds_up.length > 0) return "holding";
    return "waiting";
  }
  if (row.answered_not_sent) return "new";
  if (row.sent !== null && row.sent.checked_at === null) return "sent";
  if (row.unseen > 0) return "new";
  return "quiet";
}

/** Bold in the list: something waits on the person, or is new to them. */
export function inboxRowUnread(section: InboxSectionId): boolean {
  return section === "stopped" || section === "holding" || section === "waiting" || section === "new";
}

function byId(left: InboxListRow, right: InboxListRow): number {
  return left.thread_id.localeCompare(right.thread_id);
}

function newestFirst(left: InboxListRow, right: InboxListRow): number {
  return right.last_at.localeCompare(left.last_at) || byId(left, right);
}

/** Every section, in the approved order, each with its rows in order (empty ones included). */
export function inboxListSections(rows: readonly InboxListRow[]): InboxListSection[] {
  return INBOX_SECTIONS.map(({ id, label }) => ({
    id,
    label,
    threads: rows.filter((row) => row.section === id).sort(newestFirst),
  }));
}
