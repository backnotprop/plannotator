/**
 * A Send pressed again after its answer was lost (the window gave the request up: packages/inbox/apiWrite.ts) is safe
 * only because the Inbox answers a key it has seen with what it wrote, and writes nothing. The window keeps the key
 * across that retry; these are the store's halves: a reply, a new message in a thread, and a new thread, each sent
 * twice under one key, the second time after the Inbox reopened from disk (a restart between the two presses) and
 * after the agent wrote again. One message each, and the retry's answer is the first one.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const TO = { host: "claude-code", session: "ses_a" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-send-retry-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "fern-api", root: "/work/fern-api" });
  const asked = store.sendMessage({ project_id: project.id, author: A, body: "The schema change is ready. Merge it?" }).message;
  return { dir, store, project, asked };
}

const personMessages = (store: InboxStore, threadId: string) => store.thread(threadId)!.messages.filter((m) => m.author.kind === "person");

test("a reply sent again under its key, after a restart and a new agent message, is the first reply: nothing written twice", () => {
  const { dir, store, asked } = setup();
  const first = store.sendReply(asked.id, { idempotency_key: "k-reply", words: "Merge it, then tag 2.4.", questions: [] });
  expect(first.replayed).toBe(false);
  store.sendMessage({ project_id: asked.project_id, author: A, reply_to: asked.id, body: "Merging now." });
  const again = InboxStore.open(dir).sendReply(asked.id, { idempotency_key: "k-reply", words: "Merge it, then tag 2.4.", questions: [] });
  expect(again.replayed).toBe(true);
  expect(again.reply.id).toBe(first.reply.id);
  expect(personMessages(InboxStore.open(dir), asked.thread_id).length).toBe(1);
});

test("a new message in a thread sent again under its key is the first one", () => {
  const { dir, store, asked } = setup();
  const first = store.sendNewMessage(asked.thread_id, { body: "Also bump the client.", to: TO, idempotency_key: "k-new" });
  // Even with the session gone by the retry (the server passes `to: null`), the key answers what it wrote.
  const again = InboxStore.open(dir).sendNewMessage(asked.thread_id, { body: "Also bump the client.", to: null, idempotency_key: "k-new" });
  expect(again.replayed).toBe(true);
  expect(again.message.id).toBe(first.message.id);
  expect(personMessages(InboxStore.open(dir), asked.thread_id).length).toBe(1);
});

test("a new thread sent again under its key is the first thread", () => {
  const { dir, store, project } = setup();
  const first = store.startPersonThread({ project_id: project.id, body: "Write the migration guide.", to: TO, idempotency_key: "k-thread" });
  const again = InboxStore.open(dir).startPersonThread({ project_id: project.id, body: "Write the migration guide.", to: TO, idempotency_key: "k-thread" });
  expect(again.replayed).toBe(true);
  expect(again.message.id).toBe(first.message.id);
  // The agent's thread and this one: no second thread with the same words.
  expect(InboxStore.open(dir).threadIds().length).toBe(2);
});
