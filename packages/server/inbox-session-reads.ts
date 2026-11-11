/** Reads are kept in memory per store (a restart forgets them), so after a restart a session may get one warning it did not need: the cheap side to err on. */

import type { InboxMessage } from "@plannotator/core/inbox-types";
import type { InboxStore } from "@plannotator/shared/inbox/store";

export const INBOX_THREAD_STALE_MS = 3 * 60 * 60 * 1000;

const MAX_READS = 20_000;

const readsByStore = new WeakMap<InboxStore, Map<string, number>>();

const keyOf = (session: string, threadId: string) => `${session}\u0000${threadId}`;

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
  last_read_at: string | null;
  last_wrote_at: string | null;
  subject: string | null;
  thread_name: string | null;
}

export function lastContactOf(stale: StaleThread): string | null {
  if (!stale.last_read_at) return stale.last_wrote_at;
  if (!stale.last_wrote_at) return stale.last_read_at;
  return stale.last_wrote_at > stale.last_read_at ? stale.last_wrote_at : stale.last_read_at;
}

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

export function sessionLastSawThread(store: InboxStore, session: string, threadId: string): string | null {
  const messages = store.thread(threadId)?.messages ?? [];
  let seen = lastRead(store, session, messages, threadId);
  for (const message of messages) {
    if (message.author.kind === "agent" && message.author.session === session) seen = later(seen, msOf(message.created_at));
  }
  return seen === null ? null : new Date(seen).toISOString();
}
