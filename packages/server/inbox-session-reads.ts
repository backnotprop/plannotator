/**
 * When an agent session last looked at an Inbox thread, for send_message's
 * one warning line: a session that writes into a thread it has not looked at
 * for a few hours (or ever) is told the thread's subject, so a thread id it
 * remembered across a context compaction does not file its message in the
 * wrong thread unnoticed (the owner's ask after the misfiled-thread AAR,
 * 2026-10-27). Never blocks a send. Only for a message that names its thread
 * (`reply_to`, or a `thread` name): a message routed to the session's own
 * thread by default goes where the session's earlier messages went.
 *
 * "This session" is the call's `agent_session`, which every connection fills
 * with the host's own session id (the Claude Code mod, Pi, OpenCode, the stdio
 * shim; a Codex thread id). Without one there is no warning.
 *
 * What counts as having looked at a thread:
 *  - read_thread of that thread (a window or `format: "full"`), and a
 *    read_thread list (no id) that showed its row: the subject is what the
 *    rule "call read_thread with no id and match the subject" checks. A list
 *    a connection reads for the session-start text (`_meta` peek) does not
 *    count: the agent did not choose to check.
 *  - wait_for_reply returning a reply (or a 👍) in that thread;
 *  - the person's reply or message delivered to this session (the wake, a
 *    Codex queue), read from the store's delivery records;
 *  - the session's own earlier message in the thread (it wrote there, so it
 *    knew the thread then). Without this a session's own follow-ups into the
 *    thread it started would warn every time. When writing there is the
 *    session's latest contact, the line says so ("You last wrote in this
 *    thread at …"), never that it has not read the thread.
 *
 * Reads are kept in memory, per store (a restart forgets them; deliveries and
 * the session's own messages are in the store and survive it). So after an
 * Inbox restart a session that only ever read a thread may get one warning it
 * did not need: the cheap side to err on.
 */

import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

/** A session that has not looked at a thread for this long is reminded of its subject when it writes there. */
export const INBOX_THREAD_STALE_MS = 3 * 60 * 60 * 1000;

/** At most this many (session, thread) reads kept per store; the oldest go first. */
const MAX_READS = 20_000;

const readsByStore = new WeakMap<InboxStore, Map<string, number>>();

const keyOf = (session: string, threadId: string) => `${session}\u0000${threadId}`;

/** The session looked at the thread now (`at`, epoch ms). No session: nothing to remember. */
export function noteSessionRead(store: InboxStore, session: string | null | undefined, threadId: string, at: number): void {
  const who = session?.trim();
  if (!who || !threadId) return;
  let reads = readsByStore.get(store);
  if (!reads) {
    reads = new Map();
    readsByStore.set(store, reads);
  }
  const key = keyOf(who, threadId);
  // Re-inserted, so the map's order is oldest read first and the cap drops the oldest.
  reads.delete(key);
  reads.set(key, at);
  if (reads.size > MAX_READS) {
    const oldest = reads.keys().next().value;
    if (oldest !== undefined) reads.delete(oldest);
  }
}

const msOf = (iso: string | null | undefined): number | null => {
  if (!iso) return null;
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : null;
};

const later = (a: number | null, b: number | null): number | null => (a === null ? b : b === null ? a : Math.max(a, b));

/** When `session` last read the thread: read_thread, wait_for_reply, or a delivery of the person's words to it. */
function lastRead(store: InboxStore, session: string, messages: readonly InboxMessage[], threadId: string): number | null {
  let last = readsByStore.get(store)?.get(keyOf(session, threadId)) ?? null;
  for (const message of messages) {
    if (message.author.kind !== "person") continue;
    if (message.delivery?.session === session) last = later(last, msOf(message.delivery.at));
    for (const tag of message.tags ?? []) if (tag.session === session && tag.delivery) last = later(last, msOf(tag.delivery.at));
  }
  return last;
}

export interface StaleThread {
  /** When the session last read the thread (ISO), or null: never, as far as this Inbox knows. */
  last_read_at: string | null;
  /** When the session last wrote in the thread before this message (ISO), or null: never. */
  last_wrote_at: string | null;
  subject: string | null;
  thread_name: string | null;
}

/** The session's latest contact with the thread (ISO): a read or its own message, or null for none. */
export function lastContactOf(stale: StaleThread): string | null {
  if (!stale.last_read_at) return stale.last_wrote_at;
  if (!stale.last_wrote_at) return stale.last_read_at;
  return stale.last_wrote_at > stale.last_read_at ? stale.last_wrote_at : stale.last_read_at;
}

/**
 * Whether the message `messageId` that `session` just sent joined a thread
 * the session has not looked at for INBOX_THREAD_STALE_MS. Null when it
 * started the thread, when there is no session, or when the session looked
 * at the thread (or wrote in it before this message) recently enough.
 */
export function staleThreadOf(store: InboxStore, messageId: string, session: string | null | undefined, now: number): StaleThread | null {
  const who = session?.trim();
  if (!who) return null;
  const message = store.message(messageId);
  if (!message || message.thread_id === message.id) return null;
  const threadId = message.thread_id;
  const messages = store.thread(threadId)?.messages ?? [];
  const read = lastRead(store, who, messages, threadId);
  let wrote: number | null = null;
  for (const other of messages) {
    if (other.id === message.id || other.author.kind !== "agent" || other.author.session !== who) continue;
    wrote = later(wrote, msOf(other.created_at));
  }
  const contact = later(read, wrote);
  if (contact !== null && now - contact <= INBOX_THREAD_STALE_MS) return null;
  return {
    last_read_at: read === null ? null : new Date(read).toISOString(),
    last_wrote_at: wrote === null ? null : new Date(wrote).toISOString(),
    subject: store.threadSubject(threadId),
    thread_name: store.message(threadId)?.thread_name ?? null,
  };
}

/**
 * The warning line: "You have not read this thread since <time>; its subject
 * is <subject>." (the owner's words), the time as read_thread prints times.
 * When the session's latest contact was its own message: "You last wrote in
 * this thread at <time>; its subject is <subject>.", so the thread's starter
 * is never told it has not read its own thread.
 */
export function staleThreadText(stale: StaleThread, time: (iso: string) => string): string {
  const subject = stale.subject ? JSON.stringify(stale.subject) : "(none)";
  const name = stale.thread_name ? ` (thread name ${JSON.stringify(stale.thread_name)})` : "";
  const contact = lastContactOf(stale);
  const lead =
    contact && contact === stale.last_wrote_at
      ? `You last wrote in this thread at ${time(contact)}`
      : `You have not read this thread ${stale.last_read_at ? `since ${time(stale.last_read_at)}` : "in this session"}`;
  return `${lead}; its subject is ${subject}${name}.`;
}
