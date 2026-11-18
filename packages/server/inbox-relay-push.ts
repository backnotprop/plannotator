/**
 * Plannotator Inbox: the sealed push, version 2 (adr/implementation/inbox-mobile.md,
 * section 4, "Push"; mobile SPEC 1.4 E). The Inbox side: the facts from the store,
 * passed to the pure rules in packages/core/inbox-push.ts, and the envelope sized
 * against Apple's ceiling.
 *
 * The Inbox now also pushes for an agent's new thread and a launched session's
 * failed turn, as the window notifies for them (packages/inbox/notify.ts). A
 * snoozed thread never pushes.
 */

import { encryptWithKey } from "@plannotator/core/crypto";
import { inboxPushFallbacks, inboxPushFits, inboxPushPlaintext, type InboxPushPlaintext } from "@plannotator/core/inbox-push";
import { isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { displayInboxSubject, inboxAgentName, inboxRowArchived, inboxRowWaitsOnPerson, type InboxListRow } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export { APNS_BODY_LIMIT, apnsBody, type InboxPushAction, type InboxPushKind, type InboxPushPlaintext, type InboxPushQuestion } from "@plannotator/core/inbox-push";

/** Sections whose rows hold up an agent's work. */
const HOLDS_UP = new Set(["stopped", "holding"]);

/**
 * The summary for one agent message, or null when it pushes nothing: plain
 * news in an existing thread, a person's message, or any message in a thread
 * that is snoozed now. `rows` are the list's rows as the window places them
 * (launched sessions decorated), for the badge and `time_sensitive`.
 */
export function inboxPushSummary(store: InboxStore, messageId: string, rows: () => readonly InboxListRow[]): InboxPushPlaintext | null {
  const message = store.message(messageId);
  if (!message || message.author.kind !== "agent") return null;
  const snoozed = store.snoozedThreads();
  if (snoozed.has(message.thread_id)) return null;
  const listed = rows();
  const own = listed.find((row) => row.thread_id === message.thread_id);
  return inboxPushPlaintext({
    thread_id: message.thread_id,
    message_id: message.id,
    subject: store.threadSubject(message.thread_id) ?? displayInboxSubject(message.subject) ?? "",
    project: store.project(message.project_id)?.name ?? "",
    agent: inboxAgentName(message.author),
    questions: store.questionsOf(messageId),
    permission: isInboxPermissionSession(message.author.session),
    turn_error: message.turn_error === true && message.resolved_at === null,
    review: Boolean(message.guide),
    replaces: store.supersededBy(messageId).length > 0,
    new_thread: message.id === message.thread_id && message.started_by_person !== true && message.resolved_at === null,
    badge: listed.filter((row) => !snoozed.has(row.thread_id) && !inboxRowArchived(row) && inboxRowWaitsOnPerson(row)).length,
    holds_up: own !== undefined && HOLDS_UP.has(own.section),
  });
}

/** The fullest summary whose APNs body fits Apple's 4096 bytes: the summary, then each rung of `inboxPushFallbacks`. */
export async function sizedPushEnvelope(summary: InboxPushPlaintext, key: string): Promise<string> {
  const tries = [summary, ...inboxPushFallbacks(summary)];
  for (const plaintext of tries) {
    const envelope = await encryptWithKey(JSON.stringify(plaintext), key);
    if (inboxPushFits(envelope)) return envelope;
  }
  return encryptWithKey(JSON.stringify(tries.at(-1)), key);
}
