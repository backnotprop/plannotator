/**
 * New thread from this message, in the store: the ask (`author_only`, the words of
 * packages/core/inbox-reply-quote.ts) reaches only the session that wrote the message, never a session the person
 * added to the thread; the agent reads those words alone, with no "still open" line; and a `#tag` in the agent's
 * quoted words is not filed as the person's (no card moves, no thread is listed under it, and a card made later does
 * not start there). Each test uses its own temp data dir.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { isNewThreadFromMessageAsk, NEW_THREAD_FROM_MESSAGE_WORDS } from "@plannotator/core/inbox-reply-quote";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const CLAUDE = { kind: "agent", host: "claude-code", session: "ses_claude", name: "Claude Code" } as const;
const PERSON: InboxAuthor = { kind: "person" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-new-thread-ask-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  return { store, project };
}

test("the ask reaches only the message's own session, not a session the person added to the thread", () => {
  const { store, project } = world();
  const first = store.sendMessage({ project_id: project.id, author: CLAUDE, body: "The retry worker is done." }).message;
  // The person adds Codex to the thread ("Add instead").
  store.sendReply(first.id, { words: "Codex, look too.", idempotency_key: "k1", tags: [{ host: "codex", session: "ses_codex", wakes: true, joined: true }] as never });
  expect(store.addedSessions(first.thread_id).map((t) => t.session)).toEqual(["ses_codex"]);
  const later = store.sendMessage({ project_id: project.id, author: CLAUDE, body: "Fixed the retry loop.", reply_to: first.id }).message;
  // A reply goes only to the agents the reply box names: a plain reply does not reach the added session either.
  const plain = store.sendReply(later.id, { words: "Thanks.", idempotency_key: "k2" }).reply;
  expect(store.isFor(plain, "ses_codex")).toBe(false);
  const ask = store.sendReply(later.id, { words: NEW_THREAD_FROM_MESSAGE_WORDS("Fixed the retry loop.", later.id), idempotency_key: "k3", author_only: true }).reply;
  expect(store.isFor(ask, "ses_claude")).toBe(true);
  expect(store.isFor(ask, "ses_codex")).toBe(false);
  expect((ask.tags ?? []).map((t) => t.session)).toEqual([]);
});

test("a #tag in the agent's quoted words is not the person's: no card moves, the listing is unchanged, a later card starts nowhere", () => {
  const { store, project } = world();
  const billing = store.createInitiative({ name: "Billing", by: PERSON });
  const asked = store.sendMessage({ project_id: project.id, author: CLAUDE, body: "Fixed the #billing retry." }).message;
  const { card } = store.createCard({ project_id: project.id, by: CLAUDE, title: "Retry", threads: [asked.thread_id] });
  const words = NEW_THREAD_FROM_MESSAGE_WORDS("Fixed the #billing retry.", asked.id);
  expect(isNewThreadFromMessageAsk(words)).toBe(true);
  // The agent's own first line lists the thread already; the ask adds nothing.
  const listed = store.initiativeThreads()[billing.id];
  store.sendReply(asked.id, { words, idempotency_key: "k1", author_only: true });
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  expect(store.initiativeThreads()[billing.id]).toEqual(listed);
  const later = store.createCard({ project_id: project.id, by: CLAUDE, title: "Later", threads: [asked.thread_id] }).card;
  expect(store.cardWire(later).initiative).toBeNull();
  // Guard: the person's own words with the tag still file it.
  store.sendReply(asked.id, { words: "This is #billing work.", idempotency_key: "k2" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(billing.id);
});

test("on a message with an open question the agent reads the approved words alone, no \"still open\" line", () => {
  const { store, project } = world();
  const asked = store.sendMessage({ project_id: project.id, author: CLAUDE, body: "Keep ids how long?\n\n:::question\nStore processed event ids for how long?\n\n- [ ] 3 days\n- [ ] 30 days\n:::" }).message;
  const words = NEW_THREAD_FROM_MESSAGE_WORDS("Keep ids how long?", asked.id);
  expect(store.sendReply(asked.id, { words, idempotency_key: "k1", author_only: true }).reply.body).toBe(words);
  // Guard: a plain reply there carries the line.
  expect(store.sendReply(asked.id, { words: "Thinking.", idempotency_key: "k2" }).reply.body).not.toBe("Thinking.");
});

test("the recognizer matches the ask with or without first words, and not the person's own words", () => {
  expect(isNewThreadFromMessageAsk(NEW_THREAD_FROM_MESSAGE_WORDS("", "msg_01ABC"))).toBe(true);
  expect(isNewThreadFromMessageAsk(NEW_THREAD_FROM_MESSAGE_WORDS("Some #tag words", "msg_01ABC"))).toBe(true);
  expect(isNewThreadFromMessageAsk("Move this message of yours to a new thread, it is #billing work.")).toBe(false);
});
