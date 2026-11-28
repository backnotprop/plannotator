/**
 * Plannotator Inbox: the sealed push, version 2 (adr/implementation/inbox-mobile.md,
 * section 4, "Push"; mobile SPEC 1.4 E). The Inbox side: the facts from the store,
 * passed to the pure rules in packages/core/inbox-push.ts, and the envelope sized
 * against Apple's ceiling.
 *
 * The Inbox now also pushes for an agent's new thread and a launched session's
 * failed turn, as the window notifies for them (packages/inbox/notify.ts), to a
 * phone whose app registered through relay 1.1 only. A snoozed thread never
 * pushes; it pushes when it comes back with a question open.
 */

import { encryptWithKey } from "@plannotator/core/crypto";
import { inboxPushFallbacks, inboxPushKind, inboxPushPlaintext, inboxPushSealText, type InboxPushInput, type InboxPushKind, type InboxPushPlaintext } from "@plannotator/core/inbox-push";
import { isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { displayInboxSubject, INBOX_SCRIPT_AUTHOR_NAME, inboxAgentName, inboxRowArchived, inboxScriptAuthor, inboxRowWaitsOnPerson, type InboxListRow } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export { APNS_BODY_LIMIT, apnsBody, type InboxPushAction, type InboxPushKind, type InboxPushPlaintext, type InboxPushQuestion } from "@plannotator/core/inbox-push";

/** Sections whose rows hold up an agent's work. */
const HOLDS_UP = new Set(["stopped", "holding"]);

/**
 * The summary for one agent message, or null when it pushes nothing: plain
 * news in an existing thread, a person's message, any message in a thread
 * that is snoozed now, or a kind `wanted` turns down (no phone takes it).
 * The kind is worked out from the message alone first; only a message that
 * pushes reads `rows` (the list's rows as the window places them, launched
 * sessions decorated) for the badge and `time_sensitive`.
 */
export function inboxPushSummary(
  store: InboxStore,
  messageId: string,
  rows: () => readonly InboxListRow[],
  wanted: (kind: InboxPushKind) => boolean = () => true,
): InboxPushPlaintext | null {
  const message = store.message(messageId);
  if (!message || message.author.kind !== "agent") return null;
  const snoozed = store.snoozedThreads();
  if (snoozed.has(message.thread_id)) return null;
  const facts: InboxPushInput = {
    thread_id: message.thread_id,
    message_id: message.id,
    subject: "",
    project: "",
    agent: "",
    questions: store.questionsOf(messageId),
    permission: isInboxPermissionSession(message.author.session),
    turn_error: message.turn_error === true && message.resolved_at === null,
    review: Boolean(message.guide),
    replaces: store.supersededBy(messageId).length > 0,
    new_thread: message.id === message.thread_id && message.started_by_person !== true && message.resolved_at === null,
    badge: 0,
  };
  const kind = inboxPushKind(facts);
  if (!kind || !wanted(kind)) return null;
  const listed = rows();
  const own = listed.find((row) => row.thread_id === message.thread_id);
  return inboxPushPlaintext({
    ...facts,
    subject: store.threadSubject(message.thread_id) ?? displayInboxSubject(message.subject) ?? "",
    project: store.project(message.project_id)?.name ?? "",
    // A person reads it on the phone's lock screen: "Script" for a script's post, as the window's notification says.
    agent: inboxScriptAuthor(message.author) ? INBOX_SCRIPT_AUTHOR_NAME : inboxAgentName(message.author),
    badge: listed.filter((row) => !snoozed.has(row.thread_id) && !inboxRowArchived(row) && inboxRowWaitsOnPerson(row)).length,
    holds_up: own !== undefined && HOLDS_UP.has(own.section),
  });
}

/**
 * The fullest summary that fits Apple's 4096 bytes, sealed: the summary, then
 * each rung of `inboxPushFallbacks`, each padded to a fixed size
 * (`inboxPushSealText`) so the envelope's length tells nothing of the words.
 */
export async function sizedPushEnvelope(summary: InboxPushPlaintext, key: string): Promise<string> {
  const tries = [summary, ...inboxPushFallbacks(summary)];
  for (const plaintext of tries) {
    const text = inboxPushSealText(plaintext);
    if (text !== null) return encryptWithKey(text, key);
  }
  return encryptWithKey(JSON.stringify(tries.at(-1)), key);
}
