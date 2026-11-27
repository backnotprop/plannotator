/**
 * Rule 11 for a Combine's archive (approval "inbox-combine-across-computers"; inbox-combine-far.ts): a linked
 * computer's Combine archives a thread of this Inbox through its outbox, so the archive may land long after the
 * Combine read the thread (that computer slept, the link was down). It carries what that read saw: the thread's last
 * message (`seen_through_message`) and every question it saw (`seen_questions`, `<message>/<key>`; the open ones were
 * carried into the combined thread, asked again there). Here, at the door's `messages/:id/resolve`, it is skipped, not
 * refused, when the thread moved on since (a message after that one) or holds an open question that read did not see:
 * the person never saw those in the combined thread, and a late archive would hide them. It is skipped too when the
 * person unarchived the thread here after that read (`seen_cursor`, this store's cursor as it was read): an archive
 * from before never undoes their own Unarchive. A write without the fields (the person's own Archive) is never held to
 * this. `again` (a thread archived once and written in since): applied as an Unarchive and an Archive, so it gets a
 * new archive line, as a Combine here does for its own (`combineArchiveAgain`).
 */

import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** Why a Combine's held archive is not applied: the thread moved on, or asks something the Combine never read. */
export type CombineArchiveSkip = "thread_moved_on" | "open_question" | "unarchived";

/** The guard's fields as a Combine sends them, read and checked; null for a write that carries none. */
export function combineGuardOf(body: Record<string, unknown>): { seen: string; questions: Set<string>; cursor: number | null } | null {
  if (body.seen_through_message === undefined) return null;
  if (typeof body.seen_through_message !== "string" || body.seen_through_message === "") {
    throw new InboxError("validation_error", "seen_through_message: a message id.", { field: "seen_through_message" });
  }
  const questions = body.seen_questions ?? [];
  if (!Array.isArray(questions) || questions.some((ref) => typeof ref !== "string")) {
    throw new InboxError("validation_error", "seen_questions: a list of <message>/<key>.", { field: "seen_questions" });
  }
  const cursor = body.seen_cursor ?? null;
  if (cursor !== null && (typeof cursor !== "number" || !Number.isInteger(cursor) || cursor < 0)) {
    throw new InboxError("validation_error", "seen_cursor: this Inbox's cursor as the thread was read.", { field: "seen_cursor" });
  }
  return { seen: body.seen_through_message, questions: new Set(questions as string[]), cursor };
}

/** Why this thread's Combine archive is skipped now, or null to apply it. */
export function combineArchiveSkip(store: InboxStore, messageId: string, body: Record<string, unknown>): CombineArchiveSkip | null {
  const guard = combineGuardOf(body);
  if (!guard) return null;
  const target = store.message(messageId);
  const thread = target ? store.thread(target.thread_id) : null;
  // Gone: the store's own refusal says so when the write is applied.
  if (!thread) return null;
  const seen = store.messageCursor(guard.seen);
  if (seen === null || thread.messages.some((message) => (store.messageCursor(message.id) ?? 0) > seen)) return "thread_moved_on";
  if (guard.cursor !== null && (store.unarchiveSeq(thread.thread_id) ?? 0) > guard.cursor) return "unarchived";
  for (const message of thread.messages) {
    if (message.author.kind !== "agent") continue;
    for (const q of store.questionsOf(message.id)) {
      if (q.state === "open" && !q.orphaned && !guard.questions.has(`${message.id}/${q.key}`)) return "open_question";
    }
  }
  return null;
}

/**
 * A Combine's archive with `again`, about to be applied (not skipped): a thread archived once and written in since is
 * unarchived first, so the Archive that follows writes a new archive line over what came after.
 */
export function combineArchiveAgain(store: InboxStore, messageId: string, body: Record<string, unknown>): void {
  if (body.again !== true || body.resolved === false || !combineGuardOf(body)) return;
  const target = store.message(messageId);
  const root = target ? store.message(target.thread_id) : null;
  if (root?.resolved_at != null) store.resolveThread(root.id, false, "person");
}
