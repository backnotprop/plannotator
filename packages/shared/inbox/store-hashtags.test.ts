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

const tagged = (store: InboxStore) => Object.fromEntries(Object.entries(store.initiativeThreads()).map(([id, read]) => [id, read.threads]));

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
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  store.sendReply(asked.id, { words: "Nice, part of #Nope", idempotency_key: "k1" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  store.sendReply(asked.id, { words: "Ship it, part of #Shape now.", idempotency_key: "k2" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(shape.id);
  expect(store.cardHistory(card.id).filter((e) => e.kind === "initiative")).toEqual([{ at: expect.any(String), by: PERSON, kind: "initiative", initiative: shape.id }]);
  store.sendReply(asked.id, { words: "Actually #Shape, no: #code-review", idempotency_key: "k3" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBe(review.id);
});

test("a card an agent makes later for a thread the person tagged starts in that initiative", () => {
  const { store, project, shape } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Want me to take the empty states?" }).message;
  store.sendReply(asked.id, { words: "Yes, it is #Shape work.", idempotency_key: "k1" });
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Empty states", threads: [asked.thread_id] });
  expect(store.cardWire(card).initiative).toBe(shape.id);
  const other = store.sendMessage({ project_id: project.id, author: AGENT, body: "Another thing", thread: "other" }).message;
  const plain = store.createCard({ project_id: project.id, by: AGENT, title: "Other", threads: [other.thread_id] }).card;
  expect(store.cardWire(plain).initiative).toBeNull();
});

test("at create the person's tag wins over an agent's name or \"\", and no initiative is made for the name", () => {
  const { store, project, shape, review } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Take the empty states?" }).message;
  store.sendReply(asked.id, { words: "Yes, #Shape work.", idempotency_key: "k1" });
  const threads = [asked.thread_id];
  for (const initiative_name of ["Billing", "Code review", ""]) {
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: `Named ${initiative_name}`, threads, initiative_name });
    expect([initiative_name, store.cardWire(card).initiative]).toEqual([initiative_name, shape.id]);
    expect(store.cardHistory(card.id).filter((entry) => entry.kind === "initiative").map((entry) => entry.by.kind)).toEqual(["person"]);
  }
  expect(store.initiatives().map((i) => i.name).sort()).toEqual(["Code review", "Shape"]);
  expect(() => store.createCard({ project_id: project.id, by: AGENT, title: "Long", threads, initiative_name: "x".repeat(41) })).toThrow();
  const picked = store.createCard({ project_id: project.id, by: PERSON, title: "Mine", threads, initiative: review.id }).card;
  expect(store.cardWire(picked).initiative).toBe(review.id);
  store.deleteInitiative(shape.id);
  const after = store.createCard({ project_id: project.id, by: AGENT, title: "After", threads, initiative_name: "Billing" }).card;
  expect(store.initiative(store.cardWire(after).initiative!)!.name).toBe("Billing");
});

test("after create the last change wins: an agent's say over the tag, the person's next tag over the say", () => {
  const { store, project, shape, review } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Take it?" }).message;
  store.sendReply(asked.id, { words: "Yes, #Shape work.", idempotency_key: "k1" });
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Empty states", threads: [asked.thread_id] });
  const initiativeOf = (id: string) => store.cardWire(store.card(id)!).initiative;
  expect(initiativeOf(card.id)).toBe(shape.id);
  store.updateCard(card.id, { by: AGENT, initiative_name: "Code review" });
  expect(initiativeOf(card.id)).toBe(review.id);
  store.updateCard(card.id, { by: AGENT, initiative_name: "" });
  expect(initiativeOf(card.id)).toBeNull();
  store.sendReply(asked.id, { words: "Back in #Shape please.", idempotency_key: "k2" });
  expect(initiativeOf(card.id)).toBe(shape.id);

  const later = store.createCard({ project_id: project.id, by: AGENT, title: "Plain" }).card;
  store.updateCard(later.id, { by: AGENT, threads: [asked.thread_id] });
  expect(initiativeOf(later.id)).toBe(shape.id);
});

test("initiativeThreads: every thread a message tags an initiative in, agent's or person's, latest first; code is no tag; it survives a reload", () => {
  const { dir, store, project, shape, review } = world();
  const a = store.sendMessage({ project_id: project.id, author: AGENT, body: "Takes are up for #Shape.", thread: "a" }).message;
  const b = store.sendMessage({ project_id: project.id, author: AGENT, body: "Use `#Shape` in code: not a tag.", thread: "b" }).message;
  const c = store.sendMessage({ project_id: project.id, author: AGENT, body: "Hover cards next.", thread: "c" }).message;
  store.sendReply(c.id, { words: "This is #code-review work.", idempotency_key: "k1" });
  store.sendReply(b.id, { words: "And #Shape too", idempotency_key: "k2" });
  expect(tagged(store)).toEqual({ [shape.id]: [b.thread_id, a.thread_id], [review.id]: [c.thread_id] });
  const reopened = InboxStore.open(dir);
  expect(tagged(reopened)).toEqual(tagged(store));
});

test("a tag in code, inline or fenced, is no tag: the card stays where it is and the thread is not indexed", () => {
  const { store, project } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Which one?", thread: "code" }).message;
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Code", threads: [asked.thread_id] });
  store.sendReply(asked.id, { words: "Grep for `#Shape` and\n```\n#Shape\n```", idempotency_key: "k1" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  expect(tagged(store)).toEqual({});
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
  expect(tagged(store)).toEqual({});
  const a = store.sendMessage({ project_id: project.id, author: AGENT, body: "Started on #ShapeV2 notes.", thread: "a" }).message;
  expect(tagged(store)).toEqual({});
  store.renameInitiative(shape.id, "Shape v2");
  expect(tagged(store)).toEqual({ [shape.id]: [a.thread_id] });
  const b = store.sendMessage({ project_id: project.id, author: AGENT, body: "More #shape-v2 work", thread: "b" }).message;
  expect(tagged(store)).toEqual({ [shape.id]: [b.thread_id, a.thread_id] });
  store.sendReply(a.id, { words: "Back to #ShapeV2", idempotency_key: "k1" });
  expect(tagged(store)).toEqual({ [shape.id]: [a.thread_id, b.thread_id] });
  store.deleteThread(b.thread_id);
  expect(tagged(store)).toEqual({ [shape.id]: [a.thread_id] });
  store.deleteInitiative(shape.id);
  expect(tagged(store)).toEqual({});
});

test("review fix 3: the read is bounded: the latest few threads no card of it links, and how many there are in all", () => {
  const { store, project, shape } = world();
  const ids = Array.from({ length: 30 }, (_, i) => store.sendMessage({ project_id: project.id, author: AGENT, body: `Note ${i} #Shape`, thread: `t${i}` }).message.thread_id);
  const latest = [...ids].reverse();
  const linked = new Set([latest[0]!, latest[2]!]);
  const read = store.initiativeThreads({ limit: 4, linked: (id) => (id === shape.id ? linked : undefined) });
  expect(read[shape.id]).toEqual({ threads: [latest[1], latest[3], latest[4], latest[5]], total: 28 });
  store.sendMessage({ project_id: project.id, author: AGENT, body: "Again #Shape", thread: "t10" });
  expect(store.initiativeThreads({ limit: 2, linked: () => linked })[shape.id]).toEqual({ threads: [ids[10], latest[1]], total: 28 });
});

test("only the person's own words tag: quoted feedback or a pick's text with #Shape moves no card, now or for a card made later", () => {
  const { store, project } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Plan is up.", thread: "words" }).message;
  const { card } = store.createCard({ project_id: project.id, by: AGENT, title: "Plan", threads: [asked.thread_id] });
  store.sendReply(asked.id, { words: "Looks fine.", feedback: "# Feedback on your messages\n\n## Plan\n\n> part of #Shape\n\nKeep this.", idempotency_key: "k1" });
  expect(store.cardWire(store.card(card.id)!).initiative).toBeNull();
  const later = store.createCard({ project_id: project.id, by: AGENT, title: "Plan, part 2", threads: [asked.thread_id] }).card;
  expect(store.cardWire(later).initiative).toBeNull();
});

test("a thread two cards link: the person's tag puts both in it", () => {
  const { store, project, shape } = world();
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Two parts.", thread: "two" }).message;
  const one = store.createCard({ project_id: project.id, by: AGENT, title: "Part 1", threads: [asked.thread_id] }).card;
  const two = store.createCard({ project_id: project.id, by: AGENT, title: "Part 2", threads: [asked.thread_id] }).card;
  store.sendReply(asked.id, { words: "Both are #Shape", idempotency_key: "k1" });
  expect([one, two].map((c) => store.cardWire(store.card(c.id)!).initiative)).toEqual([shape.id, shape.id]);
});

test("review fix 4: the person's own headings and fenced comments never hide a tag they typed, now or for a card made later", () => {
  const { store, project, shape } = world();
  const auth = store.createInitiative({ name: "Auth", by: PERSON });
  const cases: [string, (asked: { id: string; thread_id: string }) => void, string][] = [
    ["heading", (asked) => store.sendReply(asked.id, { words: "## Plan\n\nThis belongs to #Shape", idempotency_key: "k-h" }), shape.id],
    ["fence", (asked) => store.sendReply(asked.id, { words: "Run:\n\n```sh\n# install\nnpm i\n```\n\nthen #Shape", idempotency_key: "k-f" }), shape.id],
    [
      "new message",
      (asked) => store.sendNewMessage(asked.thread_id, { body: "# Bug: login breaks\n\nThe redirect loops. #Auth", to: { host: "claude-code", session: "ses_a" }, idempotency_key: "k-n" }),
      auth.id,
    ],
  ];
  for (const [name, send, expected] of cases) {
    const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: "Status?", thread: name }).message;
    const { card } = store.createCard({ project_id: project.id, by: AGENT, title: name, threads: [asked.thread_id] });
    send(asked);
    expect([name, store.cardWire(store.card(card.id)!).initiative]).toEqual([name, expected]);
    const later = store.createCard({ project_id: project.id, by: AGENT, title: `${name} later`, threads: [asked.thread_id] }).card;
    expect([name, store.cardWire(later).initiative]).toEqual([name, expected]);
  }
});
