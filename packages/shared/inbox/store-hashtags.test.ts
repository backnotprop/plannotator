/**
 * Hashtags (approval "board-hashtags"): the person's `#Shape` in a thread puts
 * the thread's card in Shape (the last tag wins), and a card an agent makes or
 * links later for that thread starts in it. An agent's tag, a tag naming
 * nothing, and a tag in code change nothing. The store's tag index (in memory,
 * never on disk) follows every write, a rename and a delete.
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

const AGENT = { kind: "agent", host: "claude-code", session: "ses_a", name: "Claude Code" } as const;
const PERSON: InboxAuthor = { kind: "person" };

function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-hashtags-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "app", root: "/work/app" });
  const shape = store.createInitiative({ name: "Shape", by: PERSON });
  const review = store.createInitiative({ name: "Code review", by: PERSON });
  return { dir, store, project, shape, review };
}

test("the person's #Shape in a reply puts the thread's card in Shape; an agent's tag and a tag naming nothing do not", () => {
  const { store, project, shape, review } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "PR is up. #CodeReview" }).message;
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Sign-in fix", threads: [asked.thread_id] });
  // The agent's own tag: nothing.
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  store.sendReply(asked.id, { words: "Nice, part of #Nope", idempotency_key: "k1" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  store.sendReply(asked.id, { words: "Ship it, part of #Shape now.", idempotency_key: "k2" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(shape.id);
  expect(store.cardHistory(card.id).filter((e) => e.kind === "initiative")).toEqual([{ at: expect.any(String), by: PERSON, kind: "initiative", initiative: shape.id }]);
  // The last tag wins; `#code-review` names "Code review".
  store.sendReply(asked.id, { words: "Actually #Shape, no: #code-review", idempotency_key: "k3" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(review.id);
});

test("a card an agent makes later for a thread the person tagged starts in that initiative", () => {
  const { store, project, shape } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Want me to take the empty states?" }).message;
  store.sendReply(asked.id, { words: "Yes, it is #Shape work.", idempotency_key: "k1" });
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Empty states", threads: [asked.thread_id] });
  expect(store.cardWire(card).initiative).toBe(shape.id);
  // A thread with no tag: none.
  const other = store.sendMessage({ project_id: project.id, author: AGENT, body: "Another thing", thread: "other" }).message;
  const plain = store.createCard({ project_id: project.id, by: AGENT, title: "Other", threads: [other.thread_id] }).card;
  expect(store.cardWire(plain).initiative).toBeNull();
});

test("initiativeThreads: every thread a message tags an initiative in, agent's or person's, latest first; code is no tag; it survives a reload", () => {
  const { dir, store, project, shape, review } = world();
  const a = store.sendMessage({ project_id: project.id, author: AGENT, body: "Takes are up for #Shape.", thread: "a" }).message;
  const b = store.sendMessage({ project_id: project.id, author: AGENT, body: "Use `#Shape` in code: not a tag.", thread: "b" }).message;
  const c = store.sendMessage({ project_id: project.id, author: AGENT, body: "Hover cards next.", thread: "c" }).message;
  store.sendReply(c.id, { words: "This is #code-review work.", idempotency_key: "k1" });
  store.sendReply(b.id, { words: "And #Shape too", idempotency_key: "k2" });
  expect(store.initiativeThreads()).toEqual({ [shape.id]: [b.thread_id, a.thread_id], [review.id]: [c.thread_id] });
  const reopened = InboxStore.open(dir);
  expect(reopened.initiativeThreads()).toEqual(store.initiativeThreads());
});

test("a tag in code, inline or fenced, is no tag: the card stays where it is and the thread is not indexed", () => {
  const { store, project } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Which one?", thread: "code" }).message;
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Code", threads: [asked.thread_id] });
  store.sendReply(asked.id, { words: "Grep for `#Shape` and\n```\n#Shape\n```", idempotency_key: "k1" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  expect(store.initiativeThreads()).toEqual({});
});

test("a thread the person tagged, linked later to a card in none, puts that card in it; a cancelled card is never moved", () => {
  const { store, project, shape } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Status?", thread: "late" }).message;
  const { card: cancelled } = store.createCard({ project_id: project.id, by: AGENT, title: "Old", threads: [asked.thread_id] });
  store.updateCard(cancelled.id, { by: AGENT, column: "dropped", reason: "superseded" });
  store.sendReply(asked.id, { words: "#Shape", idempotency_key: "k1" });
  expect(store.cardWire(store.card(cancelled.id)!).initiative).toBeNull();
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Later", initiative: null });
  expect(store.cardWire(card).initiative).toBeNull();
  store.updateCard(card.id, { by: AGENT, threads: [asked.thread_id] });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(shape.id);
});

test("the tag index follows each write without a reload, a rename without a rebuild, and a deleted thread", () => {
  const { store, project, shape } = world();
  expect(store.initiativeThreads()).toEqual({});
  const a = store.sendMessage({ project_id: project.id, author: AGENT, body: "Started on #ShapeV2 notes.", thread: "a" }).message;
  // No initiative is named ShapeV2 yet: indexed under its key, listed under none.
  expect(store.initiativeThreads()).toEqual({});
  store.renameInitiative(shape.id, "Shape v2");
  expect(store.initiativeThreads()).toEqual({ [shape.id]: [a.thread_id] });
  const b = store.sendMessage({ project_id: project.id, author: AGENT, body: "More #shape-v2 work", thread: "b" }).message;
  expect(store.initiativeThreads()).toEqual({ [shape.id]: [b.thread_id, a.thread_id] });
  // A newer tag in an older thread moves it first.
  store.sendReply(a.id, { words: "Back to #ShapeV2", idempotency_key: "k1" });
  expect(store.initiativeThreads()).toEqual({ [shape.id]: [a.thread_id, b.thread_id] });
  store.deleteThread(b.thread_id);
  expect(store.initiativeThreads()).toEqual({ [shape.id]: [a.thread_id] });
  store.deleteInitiative(shape.id);
  expect(store.initiativeThreads()).toEqual({});
});
