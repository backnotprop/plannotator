/**
 * Removing an agent from a thread (approval "inbox-remove-agent-from-thread", the owner 2026-11-23: "I need a way to
 * remove an agent from a thread after it's been involved."). The setting: "Stripe 409s" in billing-svc, started by
 * billing-api (Claude Code); the person added webhooks (Codex) with "Add instead", and webhooks wrote last.
 *
 * Who receives something is read the way a connection is handed it: `pendingReplies(session, { tags: true })` (what
 * its poll gets). The person's default reply is made the way the window makes it: an answer to the message the words
 * answer by default (`inboxWordsDefault`, the window's `wordsMessage`). Proved on a real store in a temp dir.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { inboxCanRemove, inboxHolderOf, inboxWordsDefault, type InboxAuthor, type InboxMessage } from "@plannotator/core/inbox-types";
import { reaskThreadAll } from "./reask-all";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const API: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_billing_api", name: null };
const HOOKS: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "codex", session: "ses_webhooks", name: null };
const HOOKS_TAG = { host: "codex", session: HOOKS.session, label: "Codex", wakes: true } as const;
const QUESTION = [":::question", "Replay the 14 refunds now?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function open(dir: string) {
  let tick = Date.parse("2026-11-23T15:00:00.000Z");
  return InboxStore.open(dir, { now: () => new Date((tick += 1000)) });
}

/** billing-api asked; the person added webhooks; webhooks answered (with an open question); everything was delivered. */
function world(options: { hooksAsks?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-remove-agent-"));
  roots.push(dir);
  const store = open(dir);
  const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
  const asked = store.sendMessage({ project_id: project.id, author: API, subject: "Stripe 409s", body: "Stripe answers 409 on refunds with a reused key.", wakes: true }).message;
  const add = store.sendReply(asked.id, { idempotency_key: "add", words: "@Codex check the webhook side with it.", tags: [{ ...HOOKS_TAG, joined: true }] }).reply;
  const hooks = store.sendMessage({ project_id: project.id, author: HOOKS, reply_to: add.id, body: options.hooksAsks ? QUESTION : "The webhook retries reuse the old key.", wakes: true }).message;
  deliverAll(store);
  return { dir, store, project, asked, add, hooks, thread: asked.thread_id };
}

function deliverAll(store: InboxStore) {
  for (const agent of [API, HOOKS]) {
    for (const item of store.pendingReplies(agent.session!, { tags: true })) store.recordDelivery(item.id, { host: agent.host!, session: agent.session! });
  }
}

const messagesOf = (store: InboxStore, thread: string) => store.thread(thread)!.messages;
const participants = (store: InboxStore, thread: string) => store.participantsOf(messagesOf(store, thread)).map((p) => p.session);
/** Whose connection is handed `message` now. */
const receivers = (store: InboxStore, message: InboxMessage) => [API.session!, HOOKS.session!].filter((s) => store.pendingReplies(s, { tags: true }).some((m) => m.id === message.id));
/** The person's reply with nothing aimed: to the message the words answer by default, as the window sends it. */
function defaultReply(store: InboxStore, thread: string, key: string, words = "Hold the replays until 4 PM.") {
  const target = inboxWordsDefault(messagesOf(store, thread), () => false)!;
  return store.sendReply(target.id, { idempotency_key: key, words }).reply;
}

describe("Remove an agent from a thread", () => {
  test("before: webhooks wrote last, so the person's plain reply goes to it", () => {
    const { store, thread } = world();
    expect(participants(store, thread)).toEqual([API.session, HOOKS.session]);
    expect(receivers(store, defaultReply(store, thread, "r"))).toEqual([HOOKS.session!]);
  });

  test("after: it is out of the participants and the row, never the owner or the default, and receives nothing", () => {
    const { store, thread } = world();
    store.removeFromThread(thread, HOOKS.session!);
    expect(participants(store, thread)).toEqual([API.session]);
    // The list row names one agent again (a row lists its agents only when there are two or more).
    expect((store.listRows().find((r) => r.thread_id === thread)!.participants ?? []).map((p) => p.session)).not.toContain(HOOKS.session);
    expect(store.threadOwner(thread)?.session).toBe(API.session);
    expect(store.addedSessions(thread)).toEqual([]);
    const reply = defaultReply(store, thread, "r");
    expect(receivers(store, reply)).toEqual([API.session!]);
    // Its own messages stay as they were.
    expect(messagesOf(store, thread).filter((m) => m.author.kind === "agent" && m.author.session === HOOKS.session)).toHaveLength(1);
  });

  test("a reply sent to it before the removal stays sent (nothing is taken back)", () => {
    const { store, thread, hooks } = world();
    const before = store.sendReply(hooks.id, { idempotency_key: "r0", words: "Look at the dedupe table too." }).reply;
    store.removeFromThread(thread, HOOKS.session!);
    expect(receivers(store, before)).toEqual([HOOKS.session!]);
  });

  test("the Inbox's own notes wait while it is out, and go once the person writes to it again", () => {
    const { store, thread, hooks } = world({ hooksAsks: true });
    store.removeFromThread(thread, HOOKS.session!);
    store.markRead(thread, true);
    const notes = store.tellSetAside(thread, 0).filter((n) => n.reply_to === hooks.id);
    expect(notes).toHaveLength(1);
    expect(receivers(store, notes[0]!)).toEqual([]);
    store.sendReply(hooks.id, { idempotency_key: "back", words: "Never mind, go ahead." });
    expect(receivers(store, notes[0]!)).toEqual([HOOKS.session!]);
  });

  test("its own post lands but it stays out", () => {
    const { store, thread, add } = world();
    store.removeFromThread(thread, HOOKS.session!);
    const post = store.sendMessage({ project_id: messagesOf(store, thread)[0]!.project_id, author: HOOKS, reply_to: add.id, body: "Replays are done.", wakes: true }).message;
    expect(post.thread_id).toBe(thread);
    expect(store.removedFrom(thread).has(HOOKS.session!)).toBe(true);
    expect(participants(store, thread)).toEqual([API.session]);
    expect(receivers(store, defaultReply(store, thread, "r"))).toEqual([API.session!]);
  });

  describe("writing to it again brings it back and clears the mark", () => {
    const back = (store: InboxStore, thread: string) => {
      expect(store.removedFrom(thread).has(HOOKS.session!)).toBe(false);
      expect(participants(store, thread)).toEqual([API.session, HOOKS.session]);
    };
    test("an @ tag (or Tag another agent)", () => {
      const { store, thread, asked } = world();
      store.removeFromThread(thread, HOOKS.session!);
      const reply = store.sendReply(asked.id, { idempotency_key: "t", words: "@Codex hold the replays.", tags: [HOOKS_TAG] }).reply;
      expect(receivers(store, reply)).toEqual([API.session!, HOOKS.session!]);
      back(store, thread);
    });
    test("picking it in the list (`to`)", () => {
      const { store, thread, asked } = world();
      store.removeFromThread(thread, HOOKS.session!);
      const reply = store.sendReply(asked.id, { idempotency_key: "t", words: "Only you.", to: { host: HOOKS.host, session: HOOKS.session! } }).reply;
      expect(receivers(store, reply)).toEqual([HOOKS.session!]);
      back(store, thread);
    });
    test("Reply on one of its messages", () => {
      const { store, thread, hooks } = world();
      store.removeFromThread(thread, HOOKS.session!);
      const reply = store.sendReply(hooks.id, { idempotency_key: "t", words: "Which key?" }).reply;
      expect(receivers(store, reply)).toEqual([HOOKS.session!]);
      back(store, thread);
    });
    test("answering its open question (it stays answerable, and the answer goes to it)", () => {
      const { store, thread, hooks } = world({ hooksAsks: true });
      store.removeFromThread(thread, HOOKS.session!);
      const q = store.questionsOf(hooks.id)[0]!;
      expect(q.state).toBe("open");
      const answer: QuestionAnswer = { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: ["No"] };
      const reply = store.sendReply(hooks.id, { idempotency_key: "t", questions: [{ key: q.key, revision: 0, answer }] }).reply;
      expect(receivers(store, reply)).toEqual([HOOKS.session!]);
      back(store, thread);
    });
  });

  test("the starting agent can be removed: the thread passes to the latest agent still in it", () => {
    const { store, thread } = world();
    store.removeFromThread(thread, API.session!);
    expect(participants(store, thread)).toEqual([HOOKS.session]);
    expect(store.threadOwner(thread)?.session).toBe(HOOKS.session);
    // A later post of billing-api's does not take the thread back.
    const root = messagesOf(store, thread)[0]!;
    store.sendMessage({ project_id: root.project_id, author: API, reply_to: root.id, body: "Done on my side.", wakes: true });
    expect(store.threadOwner(thread)?.session).toBe(HOOKS.session);
    expect(receivers(store, defaultReply(store, thread, "r"))).toEqual([HOOKS.session!]);
  });

  test("the last agent cannot be removed, nor one that is not in the thread", () => {
    const { store, thread } = world();
    store.removeFromThread(thread, HOOKS.session!);
    expect(() => store.removeFromThread(thread, API.session!)).toThrow(expect.objectContaining({ code: "last_agent" }));
    expect(() => store.removeFromThread(thread, "ses_stranger")).toThrow(expect.objectContaining({ code: "not_in_thread" }));
    expect(participants(store, thread)).toEqual([API.session]);
  });

  test("a second press writes nothing; Undo restores exactly what was there", () => {
    const { store, thread } = world();
    const before = JSON.stringify(messagesOf(store, thread)[0]!.removed ?? null);
    const first = store.removeFromThread(thread, HOOKS.session!).removal;
    expect(store.removeFromThread(thread, HOOKS.session!).removal).toEqual(first);
    expect(messagesOf(store, thread)[0]!.removed).toHaveLength(1);
    store.undoRemoveFromThread(thread, HOOKS.session!);
    expect(JSON.stringify(messagesOf(store, thread)[0]!.removed ?? null)).toBe(before);
    expect(participants(store, thread)).toEqual([API.session, HOOKS.session]);
    expect(receivers(store, defaultReply(store, thread, "r"))).toEqual([HOOKS.session!]);
  });

  test("a reply queued for it before the removal is still delivered, and Send now still sends it", () => {
    const { store, thread, hooks } = world();
    const queued = store.sendReply(hooks.id, { idempotency_key: "q", words: "Check the dedupe table." }).reply;
    store.removeFromThread(thread, HOOKS.session!);
    // Send now after the removal: allowed, and it is still that agent's to take.
    expect(store.requestDeliverNow(queued.id).deliver_now_at).toBeTruthy();
    expect(receivers(store, queued)).toEqual([HOOKS.session!]);
    store.recordDelivery(queued.id, { host: HOOKS.host!, session: HOOKS.session! });
    expect(store.message(queued.id)!.delivery).toBeTruthy();
    expect(receivers(store, queued)).toEqual([]);
    // Delivering what was sent before does not bring it back.
    expect(store.removedFrom(thread).has(HOOKS.session!)).toBe(true);
  });

  test("Re-ask all leaves a removed agent's open questions alone: it is not asked and stays removed", () => {
    const { store, thread, hooks } = world({ hooksAsks: true });
    store.removeFromThread(thread, HOOKS.session!);
    const result = reaskThreadAll(store, thread, "k1", () => true);
    expect(result.asked).toEqual([]);
    expect(messagesOf(store, thread).filter((m) => m.author.kind === "person" && m.reply_to === hooks.id)).toEqual([]);
    expect(store.removedFrom(thread).has(HOOKS.session!)).toBe(true);
    // Not removed, the same press asks it.
    const other = world({ hooksAsks: true });
    expect(reaskThreadAll(other.store, other.thread, "k1", () => true).asked.map((a) => a.session)).toEqual([HOOKS.session]);
  });

  test("Remove and the owner count the same agents: one whose only post is a routine's change line holds nothing", () => {
    const root = { id: "m1", thread_id: "m1", reply_to: null, author: { kind: "agent", session: API.session } };
    const change = { id: "m2", thread_id: "m1", reply_to: "m1", author: { kind: "agent", session: "ses_routine" }, scheduled_change: { kind: "paused" } };
    expect(inboxCanRemove([root, change], API.session!)).toBe(false);
    expect(inboxHolderOf(change)).toBeNull();
    const words = { ...change, id: "m3", scheduled_change: undefined };
    expect(inboxCanRemove([root, change, words], API.session!)).toBe(true);
  });

  test("the owner passes to the latest live agent still in the thread, else the latest", () => {
    const { store, thread, asked, hooks } = world();
    const PI: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "pi", session: "ses_pi", name: null };
    store.sendReply(asked.id, { idempotency_key: "pi", words: "@Pi too.", tags: [{ host: "pi", session: PI.session!, label: "Pi", wakes: true }] });
    const project = messagesOf(store, thread)[0]!.project_id;
    store.sendMessage({ project_id: project, author: PI, reply_to: asked.id, body: "Queue looks fine.", wakes: true });
    store.sendMessage({ project_id: project, author: HOOKS, reply_to: hooks.id, body: "Retries replayed.", wakes: true });
    store.removeFromThread(thread, HOOKS.session!);
    // Pi wrote after billing-api, but has ended: billing-api, live, owns it.
    expect(store.threadOwner(thread, (s) => s === API.session)?.session).toBe(API.session);
    // Neither live (or no liveness known): the latest still in it.
    expect(store.threadOwner(thread, () => false)?.session).toBe(PI.session);
    expect(store.threadOwner(thread)?.session).toBe(PI.session);
  });

  test("the mark survives a restart", () => {
    const { dir, store, thread } = world();
    store.removeFromThread(thread, HOOKS.session!);
    const again = open(dir);
    expect(again.removedFrom(thread).has(HOOKS.session!)).toBe(true);
    expect(again.participantsOf(again.thread(thread)!.messages).map((p) => p.session)).toEqual([API.session]);
    expect(again.addedSessions(thread)).toEqual([]);
  });

  test("a plain participant (only tagged, never added) is removed the same way", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-remove-agent-"));
    roots.push(dir);
    const store = open(dir);
    const project = store.ensureProject({ name: "billing-svc", root: "/work/billing-svc" });
    const asked = store.sendMessage({ project_id: project.id, author: API, subject: "Stripe 409s", body: "Which key wins?", wakes: true }).message;
    store.sendReply(asked.id, { idempotency_key: "ask", words: "@Codex what do you see?", tags: [HOOKS_TAG] });
    expect(participants(store, asked.thread_id)).toEqual([API.session, HOOKS.session]);
    store.removeFromThread(asked.thread_id, HOOKS.session!);
    expect(participants(store, asked.thread_id)).toEqual([API.session]);
  });
});
