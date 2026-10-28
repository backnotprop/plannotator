/**
 * Plannotator Inbox: the list's sections, per thread. Pure: rows in, the
 * placed and ordered sections out.
 *
 * A ROW IS A THREAD (owner ruling 2026-10-07); the project is a label and a
 * filter, so a filtered list keeps the same sections and only drops rows.
 *
 * The sections and their order are Workspaces' approved inbox model
 * (including its Sent band; design record, not in this repo), read per
 * thread here. The strongest
 * reason wins:
 *
 *   quiet     the thread is archived (resolved: done), unless it came back
 *             (`back_from_archive`: an agent wrote after the archive and
 *             something there still waits), which is placed by the rules
 *             below as an open thread would be (mail apps' rule) while it
 *             stays resolved until the person acts
 *   quiet     the person marked it read (Mark read) and nothing but a
 *             set-aside note came after; an agent's next message (or the
 *             person's own reply) brings it back, with no write; but a
 *             thread holding unsent work is placed in new instead (below)
 *   sent      the person's Re-ask note is the last message (approval
 *             "inbox-reask"): it waits on the agent to ask again, whatever
 *             is still open, read by the agent or not; a draft there keeps
 *             its Draft label but never moves the row out of Sent
 *   stopped   an open question says the agent cannot go on (`Stopped:`)
 *   holding   an open question names work that waits (`Holds up:`)
 *   waiting   any other open question
 *   new       every open question is picked and none sent ("Answered, not
 *             sent": it waits only for Send)
 *   sent      the person's reply is the last message and the agent has not
 *             read it yet; once it has, the row is Quiet
 *   new       agent messages the person has not looked at
 *   new       the person's unsent work: words typed in the reply box (a
 *             reply draft), picks not sent, comments waiting for a Send
 *             (`unsent`; approval "inbox-reply-drafts": a thread holding
 *             any of it never sinks to Quiet). New, because New already
 *             holds "Answered, not sent" (work that waits only for the
 *             person's Send) and sits above Quiet without claiming a
 *             question waits; the row is not bold for a draft alone
 *   quiet     the remainder
 *
 * An archived thread is the exception: archiving is the person's explicit
 * "done", so it stays archived with its draft kept (the archive already
 * closes its questions, and comments cannot be added to it).
 *
 * The sections are shown in INBOX_SECTIONS' order, which puts Sent (waiting
 * on the agent, not on the person) below New since you looked (owner
 * ruling 2026-10-11).
 *
 * Order inside every section: newest first, by the thread's latest message
 * (`last_at`, the time the row shows), so the time column reads down in order
 * (owner ruling 2026-10-08: an older question sat above a newer one in
 * "Waiting on you"). A row moves when the thread gains a message: an agent's
 * new message, or the person's reply (which in most cases moves it to Sent).
 * Picks, looks and reads move it between sections only. Ties break on the
 * thread id, so the order is total.
 *
 * Archived threads (owner ruling 2026-10-12): the window keeps them out of the
 * list altogether and shows them in Settings' Archived block instead. The
 * list model still places them in Quiet unless the caller asks for them apart
 * (`GET /api/inbox/threads?archived=exclude`), so an older window and the
 * phone, which may draw these sections, keep every thread. "Archived" here
 * means resolved and not come back.
 */

import {
  INBOX_SECTIONS,
  type InboxListRow,
  type InboxListSection,
  inboxHasUnsent,
  inboxRowArchived,
  type InboxRowUnsent,
  type InboxSectionId,
} from "@plannotator/core/inbox-types";
import { inboxUrgencyOf } from "@plannotator/core/inbox-questions";

/** The facts a thread is placed by (all on its list row). */
export type InboxSectionFacts = Pick<
  InboxListRow,
  "resolved_at" | "questions" | "answered_not_sent" | "sent" | "unseen"
> & { read_at?: string | null; back_from_archive?: boolean; reask_pending?: boolean; unsent?: InboxRowUnsent | null };

export { inboxHasUnsent };

export function inboxSectionOf(row: InboxSectionFacts): InboxSectionId {
  if (row.resolved_at !== null && row.back_from_archive !== true) return "quiet";
  const unsent = inboxHasUnsent(row.unsent);
  // Re-ask first: while its note waits on the agent, unsent work never moves the row (approval "inbox-reask").
  if (row.read_at != null) return unsent && row.reask_pending !== true ? "new" : "quiet";
  // The person's Re-ask note is the last message: it waits on the agent (approval "inbox-reask").
  if (row.reask_pending === true) return "sent";
  if (row.questions.open > 0) {
    // The urgency rule decision mode orders by (core inboxUrgencyOf).
    const urgency = inboxUrgencyOf(row.questions);
    return urgency === 0 ? "stopped" : urgency === 1 ? "holding" : "waiting";
  }
  // An action item's Done or Can't do it waits in the draft: the agent still waits on the person's Send, so the
  // row stays where the item put it (approval "inbox-action-items-in-reply", Q2: a Stopped item keeps "Stopped on you").
  if ((row.questions.staged ?? 0) > 0) {
    const urgency = inboxUrgencyOf(row.questions);
    return urgency === 0 ? "stopped" : urgency === 1 ? "holding" : "waiting";
  }
  if (row.answered_not_sent) return "new";
  if (row.sent !== null && row.sent.checked_at === null) return "sent";
  if (row.unseen > 0) return "new";
  return unsent ? "new" : "quiet";
}

/**
 * Bold in the list: something waits on the person, or is new to them. A row in
 * New only for the person's own unsent words or comments (`draftOnly`) is not
 * bold: nothing new arrived, and its "Draft" label says what is there.
 */
export function inboxRowUnread(section: InboxSectionId, draftOnly = false): boolean {
  if (section === "new" && draftOnly) return false;
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

/** Archived: resolved, and not come back (the rule lives in core, so the window shares it). */
export { inboxRowArchived };

/** Newest archived first (the Archived block's order); ties on the thread id. */
function newestArchivedFirst(left: InboxListRow, right: InboxListRow): number {
  return (right.resolved_at ?? "").localeCompare(left.resolved_at ?? "") || byId(left, right);
}

/** The archived rows, newest archived first. */
export function inboxArchivedRows(rows: readonly InboxListRow[]): InboxListRow[] {
  return rows.filter(inboxRowArchived).sort(newestArchivedFirst);
}
