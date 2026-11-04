/**
 * Hashtags (prototype "board-hashtags"): the person's `#Shape` in a thread puts
 * the thread's card in Shape, and a card an agent makes later for that thread
 * starts in it. A tag naming nothing, or an agent's tag, changes nothing.
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
