/**
 * Rule 11 for a Combine's archive (approval "inbox-combine-across-computers"; inbox-combine-far.ts): a linked
 * computer's Combine archives a thread of this Inbox through its outbox, so the archive may land long after the
 * Combine read the thread (that computer slept, the link was down). It carries what that read saw: the thread's last
 * message (`seen_through_message`) and every question it saw (`seen_questions`, `<message>/<key>`; the open ones were
 * carried into the combined thread, asked again there). Here, at the door's `messages/:id/resolve`, it is skipped, not
 * refused, when the thread moved on since (a message after that one) or holds an open question that read did not see:
 * the person never saw those in the combined thread, and a late archive would hide them. A write without the fields (the person's own Archive)
 * is never held to this.
 */

import { InboxError } from "@plannotator/shared/inbox/schema";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** Why a Combine's held archive is not applied: the thread moved on, or asks something the Combine never read. */
export type CombineArchiveSkip = "thread_moved_on" | "open_question";

/** The guard's fields as a Combine sends them, read and checked; null for a write that carries none. */
export function combineGuardOf(body: Record<string, unknown>): { seen: string; questions: Set<string> } | null {
  if (body.seen_through_message === undefined) return null;
  if (typeof body.seen_through_message !== "string" || body.seen_through_message === "") {
    throw new InboxError("validation_error", "seen_through_message: a message id.", { field: "seen_through_message" });
  }
  const questions = body.seen_questions ?? [];
  if (!Array.isArray(questions) || questions.some((ref) => typeof ref !== "string")) {
    throw new InboxError("validation_error", "seen_questions: a list of <message>/<key>.", { field: "seen_questions" });
  }
  return { seen: body.seen_through_message, questions: new Set(questions as string[]) };
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
  for (const message of thread.messages) {
    if (message.author.kind !== "agent") continue;
    for (const q of store.questionsOf(message.id)) {
      if (q.state === "open" && !q.orphaned && !guard.questions.has(`${message.id}/${q.key}`)) return "open_question";
    }
  }
  return null;
}
