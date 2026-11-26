/**
 * A reply goes to exactly the agents the reply box names, and nobody else (the owner, 2026-11-23: "every time I
 * send a reply now, it goes to both agents, even though it has a single agent selector"). The setting: a thread
 * Claude Code owns, and a Pi session the person added with "Add instead". Through 0.29.3 the store tagged every
 * later reply carrying words to each added session, so a reply to the owner alone woke both.
 *
 * Who receives a reply is read the way a connection is handed it: `pendingReplies(session, { tags: true })` (what
 * its poll gets) and `isFor`. Proved on a real store in a temp dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import type { InboxAuthor, InboxMessage } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_owner", name: null };
const B: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_added", name: null };
const B_TAG = { host: "pi", session: B.session, label: "Pi", wakes: true } as const;

/** The owner asked; the person added Pi to the thread ("Add instead") in their reply; both saw that reply. */
function world() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-chosen-recipient-"));
  roots.push(dir);
  let tick = Date.parse("2026-11-23T09:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date((tick += 1000)) });
  const project = store.ensureProject({ name: "billing-api", root: "/work/billing-api" });
  const asked = store.sendMessage({ project_id: project.id, author: A, body: "Should the retry queue keep its order?", wakes: true }).message;
  const add = store.sendReply(asked.id, { idempotency_key: "add", words: "@Pi work on this with it.", tags: [{ ...B_TAG, joined: true }] }).reply;
  for (const agent of [A, B]) {
    for (const item of store.pendingReplies(agent.session, { tags: true })) store.recordDelivery(item.id, { host: agent.host!, session: agent.session });
  }
  return { store, project, asked, add };
}

/** The sessions a reply reaches: whose connection is handed it, and whom the store counts it for. */
function receivers(store: InboxStore, reply: InboxMessage): string[] {
  return [A.session, B.session].filter((session) => {
    const handed = store.pendingReplies(session, { tags: true }).some((m) => m.id === reply.id);
    expect(store.isFor(reply, session)).toBe(handed);
    return handed;
  });
}

describe("two agents in a thread, one added", () => {
  test("the add itself reaches both, and the added session stays a member", () => {
    const { store, asked, add } = world();
    expect(add.tags).toEqual([{ ...B_TAG, joined: true }]);
    expect(store.addedSessions(asked.thread_id).map((t) => t.session)).toEqual([B.session]);
  });

  test("a reply to the owner with no `to` (the phone, an older window) reaches the owner alone", () => {
    const { store, asked, add } = world();
    const answer = store.sendMessage({ project_id: asked.project_id, author: A, reply_to: add.id, body: "Keeping the order.", wakes: true }).message;
    const reply = store.sendReply(answer.id, { idempotency_key: "r1", words: "Good, and keep the title short." }).reply;
    expect(reply.tags).toBeUndefined();
    expect(receivers(store, reply)).toEqual([A.session]);
    // Still a member: the box offers it next time, and its PR rights stay.
    expect(store.isThreadMember(asked.thread_id, B.session)).toBe(true);
  });

  test("`to` the owner reaches the owner alone", () => {
    const { store, asked } = world();
    const reply = store.sendReply(asked.id, { idempotency_key: "r1", words: "Only for you.", to: { host: A.host, session: A.session } }).reply;
    expect(reply.tags).toBeUndefined();
    expect(receivers(store, reply)).toEqual([A.session]);
  });

  test("`to` the added session reaches it alone, whether it wrote here or not", () => {
    const { store, asked, add } = world();
    // It never wrote: the box aims the words at it with `to` on the owner's message.
    const aimed = store.sendReply(asked.id, { idempotency_key: "r1", words: "Pi, only you.", to: { host: B.host, session: B.session } }).reply;
    expect(receivers(store, aimed)).toEqual([B.session]);
    // It wrote: the box answers its latest message.
    const own = store.sendMessage({ project_id: asked.project_id, author: B, reply_to: add.id, body: "Watching the index.", wakes: true }).message;
    const reply = store.sendReply(own.id, { idempotency_key: "r2", words: "Thanks, Pi." }).reply;
    expect(reply.tags).toBeUndefined();
    expect(receivers(store, reply)).toEqual([B.session]);
  });

  test("a reply naming both (a typed @ or the pill's second tick) reaches both", () => {
    const { store, asked } = world();
    const reply = store.sendReply(asked.id, { idempotency_key: "r1", words: "@Pi and you: ship it.", tags: [B_TAG] }).reply;
    expect(reply.tags?.map((t) => t.session)).toEqual([B.session]);
    expect(receivers(store, reply)).toEqual([A.session, B.session]);
  });

  test("an answer to the added session's question goes to it, never to the owner", () => {
    const { store, asked, add } = world();
    const question = [":::question", "Rebuild the index now?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
    const own = store.sendMessage({ project_id: asked.project_id, author: B, reply_to: add.id, body: question, wakes: true }).message;
    const q = store.questionsOf(own.id)[0]!;
    const answer: QuestionAnswer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["Yes"] };
    const reply = store.sendReply(own.id, { idempotency_key: "r1", questions: [{ key: q.key, revision: 0, answer }] }).reply;
    expect(receivers(store, reply)).toEqual([B.session]);
  });

  test("a hand-off after Add: the new owner gets it, the former owner its one stop notice, the added session nothing", () => {
    const { store, asked } = world();
    const C = { host: "codex", session: "ses_third" };
    const reply = store.sendReply(asked.id, {
      idempotency_key: "h1",
      words: "@Codex this is yours now.",
      handoff: { to: C, label: "Codex", from: { host: A.host, session: A.session, wakes: true, label: "Claude Code" } },
    }).reply;
    // Held for the Undo window: nobody is handed it.
    for (const session of [A.session, B.session, C.session]) expect(store.pendingReplies(session, { tags: true }).some((m) => m.id === reply.id)).toBe(false);
    store.settleHandoffs(0);
    expect(store.pendingReplies(C.session, { tags: true }).map((m) => m.id)).toEqual([reply.id]);
    // The former owner: one item, the notice (its tag is the hand-away one), never the words as its own reply.
    const formerOwner = store.pendingReplies(A.session, { tags: true }).filter((m) => m.id === reply.id);
    expect(formerOwner).toHaveLength(1);
    expect(store.deliveryIdOf(formerOwner[0]!, A.session)).not.toBe(reply.id);
    expect(store.isOwner(formerOwner[0]!, A.session)).toBe(false);
    expect(store.pendingReplies(B.session, { tags: true }).some((m) => m.id === reply.id)).toBe(false);
    expect(store.isFor(store.message(reply.id)!, B.session)).toBe(false);
  });

  test("a hand-off to the added session: it gets the reply as the new owner, the former owner only its notice", () => {
    const { store, asked } = world();
    const reply = store.sendReply(asked.id, {
      idempotency_key: "h1",
      words: "@Pi it is yours now.",
      handoff: { to: { host: B.host, session: B.session }, label: "Pi", from: { host: A.host, session: A.session, wakes: true, label: "Claude Code" } },
    }).reply;
    store.settleHandoffs(0);
    const settled = store.message(reply.id)!;
    expect(store.isOwner(settled, B.session)).toBe(true);
    expect(store.pendingReplies(B.session, { tags: true }).filter((m) => m.id === reply.id)).toHaveLength(1);
    const notice = store.pendingReplies(A.session, { tags: true }).filter((m) => m.id === reply.id);
    expect(notice).toHaveLength(1);
    expect(store.deliveryIdOf(notice[0]!, A.session)).not.toBe(reply.id);
  });

  test("an answer to the owner's question goes to the owner alone", () => {
    const { store, asked, add } = world();
    const question = [":::question", "Keep the order?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");
    const own = store.sendMessage({ project_id: asked.project_id, author: A, reply_to: add.id, body: question, wakes: true }).message;
    const q = store.questionsOf(own.id)[0]!;
    const answer: QuestionAnswer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["No"] };
    const reply = store.sendReply(own.id, { idempotency_key: "r1", words: "And no rush.", questions: [{ key: q.key, revision: 0, answer }] }).reply;
    expect(receivers(store, reply)).toEqual([A.session]);
  });
});
