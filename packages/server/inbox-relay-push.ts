/**
 * Plannotator Inbox: the sealed push, version 2 (adr/implementation/inbox-mobile.md,
 * section 4, "Push"; mobile SPEC 1.4 E).
 *
 * What one agent message pushes to a paired phone, and how it is sized. The
 * summary is sealed under the phone's device key: the relay and Apple see the
 * generic alert only, so every field here (the kind, the badge, the actions)
 * is for the phone's notification extension alone.
 *
 * Version 2 is additive to version 1 (`v` stays 1): `kind`, `badge`,
 * `time_sensitive` and `actions` are new keys, and the Inbox now also pushes
 * for an agent's new thread and a launched session's failed turn, as the
 * window notifies for them (packages/inbox/notify.ts). A snoozed thread never
 * pushes. An app that knows only version 1 reads the same `question` and
 * opens the thread for the rest.
 */

import { encryptWithKey } from "@plannotator/core/crypto";
import { INBOX_PERMISSION_AUTO, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL, isInboxPermissionSession } from "@plannotator/core/inbox-permission";
import { displayInboxSubject, inboxAgentName, inboxRowArchived, inboxRowWaitsOnPerson, type InboxListRow } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** Apple's ceiling on a push body (section 4, "Push"). */
export const APNS_BODY_LIMIT = 4096;

/**
 * The body the relay sends to APNs around an envelope, byte for byte as
 * apps/relay/src/apns.ts `apnsBody` writes it: the push is sized against it.
 */
export function apnsBody(envelope: string): string {
  return JSON.stringify({ aps: { alert: { title: "Plannotator", body: "New in your Inbox" }, "mutable-content": 1, sound: "default" }, e: envelope });
}

/**
 * Why a push was sent. `run_ended` is named for the phone's generated types
 * but not sent by this Inbox yet (a started agent's run ending notifies
 * nowhere today).
 */
export type InboxPushKind = "question" | "review" | "new_thread" | "permission" | "turn_error" | "run_ended" | "replaced";

/** One button the lock screen may offer: `choice.<n>` answers `question.choices[n]` with one Send. */
export interface InboxPushAction {
  id: string;
  /** Dropped first when the push is too large: the phone reads it from `question.choices[n]`. */
  label?: string;
}

export interface InboxPushQuestion {
  key: string;
  revision: number;
  prompt: string;
  context: string | null;
  choices: { label: string; recommended: boolean }[];
}

/** The push summary a phone decrypts (section 4, "Push"). */
export interface InboxPushPlaintext {
  v: 1;
  /** Pushes and down items share the device key: the reader checks the type, so a relay cannot pass one off as the other. */
  type: "push";
  thread_id: string;
  message_id: string;
  subject?: string;
  project?: string;
  agent?: string;
  question?: InboxPushQuestion | null;
  kind?: InboxPushKind;
  /** The rows that wait on the person now (the app's badge). */
  badge?: number;
  /** The thread holds up work: the agent stopped on the person, a `Holds up:` line, or a permission prompt. */
  time_sensitive?: boolean;
  actions?: InboxPushAction[];
}

/** A permission prompt's choices one tap cannot answer from a lock screen: a mode switch (Full asks to confirm first) and the hand-off to Terminal. */
const NOT_ONE_TAP = new Set([INBOX_PERMISSION_AUTO, INBOX_PERMISSION_FULL, INBOX_PERMISSION_TERMINAL]);
/** Apple shows at most four actions on a notification. */
const ACTIONS_MAX = 4;

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
  if (store.snoozedThreads().has(message.thread_id)) return null;
  const questions = store.questionsOf(messageId);
  const permission = questions.length > 0 && isInboxPermissionSession(message.author.session);
  const failed = message.turn_error === true && message.resolved_at === null;
  const supersedes = store.supersededBy(messageId).length > 0;
  const fresh = message.id === message.thread_id && message.started_by_person !== true && message.resolved_at === null;
  const kind: InboxPushKind | null = permission
    ? "permission"
    : failed
      ? "turn_error"
      : message.guide
        ? "review"
        : questions.length > 0
          ? "question"
          : supersedes
            ? "replaced"
            : fresh
              ? "new_thread"
              : null;
  if (!kind) return null;

  // Only an open question is ever offered for a lock-screen answer (an action item, `kind: "action"`, pushes like one but has no lock-screen Done).
  const open = questions.filter((q) => q.state === "open" && q.kind !== "action");
  const only = open.length === 1 && open[0]!.kind === "single" ? open[0]! : null;
  // A permission prompt offers only what one tap can answer; any other question offers all its choices.
  const offered = only ? (permission ? only.choices.filter((choice) => !NOT_ONE_TAP.has(choice.label)) : only.choices) : [];
  const question: InboxPushQuestion | null =
    only && offered.length > 0 && offered.length <= ACTIONS_MAX
      ? {
          key: only.key,
          revision: only.revision,
          prompt: only.prompt,
          context: only.context || null,
          choices: offered.map((choice) => ({ label: choice.label, recommended: choice.recommended })),
        }
      : null;
  // Drawn recommended first; each names its choice by index, whatever the order.
  const actions = question
    ? question.choices
        .map((choice, index) => ({ id: `choice.${index}`, label: choice.label, recommended: choice.recommended }))
        .sort((a, b) => Number(b.recommended) - Number(a.recommended))
        .map(({ id, label }) => ({ id, label }))
    : [];

  const snoozed = store.snoozedThreads();
  const listed = rows();
  const waiting = listed.filter((row) => !snoozed.has(row.thread_id) && !inboxRowArchived(row) && inboxRowWaitsOnPerson(row));
  const own = listed.find((row) => row.thread_id === message.thread_id);
  return {
    v: 1,
    type: "push",
    thread_id: message.thread_id,
    message_id: message.id,
    subject: store.threadSubject(message.thread_id) ?? displayInboxSubject(message.subject) ?? "",
    project: store.project(message.project_id)?.name ?? "",
    agent: inboxAgentName(message.author),
    question,
    kind,
    badge: waiting.length,
    time_sensitive: kind === "permission" || (own !== undefined && HOLDS_UP.has(own.section)),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/**
 * The fullest summary whose APNs body fits Apple's 4096 bytes. The ladder:
 * the actions without their labels, then without `question.context`, then
 * without the question (and so without actions), then the ids with the kind,
 * the badge and `time_sensitive` alone.
 */
export async function sizedPushEnvelope(summary: InboxPushPlaintext, key: string): Promise<string> {
  const { v, type, thread_id, message_id, kind, badge, time_sensitive } = summary;
  const idsOnly: InboxPushPlaintext = { v, type, thread_id, message_id, ...(kind ? { kind } : {}), ...(badge !== undefined ? { badge } : {}), ...(time_sensitive !== undefined ? { time_sensitive } : {}) };
  const tries: InboxPushPlaintext[] = [summary];
  let step = summary;
  if (step.actions?.some((action) => action.label !== undefined)) tries.push((step = { ...step, actions: step.actions.map(({ id }) => ({ id })) }));
  if (step.question?.context) tries.push((step = { ...step, question: { ...step.question, context: null } }));
  if (step.question) {
    const { actions: _dropped, ...rest } = step;
    tries.push((step = { ...rest, question: null }));
  }
  tries.push(idsOnly);
  for (const plaintext of tries) {
    const envelope = await encryptWithKey(JSON.stringify(plaintext), key);
    if (Buffer.byteLength(apnsBody(envelope)) <= APNS_BODY_LIMIT) return envelope;
  }
  return encryptWithKey(JSON.stringify(idsOnly), key);
}
