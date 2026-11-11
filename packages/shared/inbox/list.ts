/** The list's sections, per thread. Pure: rows in, placed and ordered sections out. */

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

export type InboxSectionFacts = Pick<
  InboxListRow,
  "resolved_at" | "questions" | "answered_not_sent" | "sent" | "unseen"
> & { read_at?: string | null; back_from_archive?: boolean; reask_pending?: boolean; unsent?: InboxRowUnsent | null };

export { inboxHasUnsent };

export function inboxSectionOf(row: InboxSectionFacts): InboxSectionId {
  if (row.resolved_at !== null && row.back_from_archive !== true) return "quiet";
  const unsent = inboxHasUnsent(row.unsent);
  if (row.read_at != null && row.unseen > 0) return "new";
  if (row.read_at != null) return unsent && row.reask_pending !== true ? "new" : "quiet";
  if (row.reask_pending === true) return "sent";
  if (row.questions.open > 0) {
    const urgency = inboxUrgencyOf(row.questions);
    return urgency === 0 ? "stopped" : urgency === 1 ? "holding" : "waiting";
  }
  // An action item's Done or Can't do it waits in the draft: the agent still waits on the person's Send, so the row stays where the item put it.
  if ((row.questions.staged ?? 0) > 0) {
    const urgency = inboxUrgencyOf(row.questions);
    return urgency === 0 ? "stopped" : urgency === 1 ? "holding" : "waiting";
  }
  if (row.answered_not_sent) return "new";
  if (row.sent !== null && row.sent.checked_at === null) return "sent";
  if (row.unseen > 0) return "new";
  return unsent ? "new" : "quiet";
}

export function inboxRowUnread(section: InboxSectionId, unseen: number, draftOnly: boolean): boolean {
  if (section === "stopped" || section === "holding" || section === "waiting") return unseen > 0;
  return section === "new" && !draftOnly;
}

function byId(left: InboxListRow, right: InboxListRow): number {
  return left.thread_id.localeCompare(right.thread_id);
}

function newestFirst(left: InboxListRow, right: InboxListRow): number {
  return right.last_at.localeCompare(left.last_at) || byId(left, right);
}

export function inboxListSections(rows: readonly InboxListRow[]): InboxListSection[] {
  return INBOX_SECTIONS.map(({ id, label }) => ({
    id,
    label,
    threads: rows.filter((row) => row.section === id).sort(newestFirst),
  }));
}

export { inboxRowArchived };

function newestArchivedFirst(left: InboxListRow, right: InboxListRow): number {
  return (right.resolved_at ?? "").localeCompare(left.resolved_at ?? "") || byId(left, right);
}

export function inboxArchivedRows(rows: readonly InboxListRow[]): InboxListRow[] {
  return rows.filter(inboxRowArchived).sort(newestArchivedFirst);
}
