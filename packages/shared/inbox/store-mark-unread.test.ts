/**
 * Mark unread (the owner's ask, 2026-10-31: "I need a way to mark a message
 * unread"): the store's rules, proved on a real store in a temp dir, a replay
 * from disk included. The latest agent message is new again, so the row is
 * New and bold; a standing Mark read is cleared without reopening what it set
 * aside; nothing is written to the thread (no note: the agent is not told);
 * nothing is written at all where there is nothing to make unread.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-markunread-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const clock = { now: Date.parse("2026-10-31T15:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const QUESTION = ["Which layout should the invoice list use?", "", ":::question", "Which layout?", "", "- [ ] Cards", "- [ ] A dense table", ":::"].join("\n");

function setup(dir?: string) {
  const opened = open(dir);
  const project = opened.store.ensureProject({ name: "billing", root: "/work/billing" });
  const first = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: "Started on the invoice list." }).message;
  const update = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: "Update: the list renders now.", reply_to: first.id }).message;
  return { ...opened, project, first, update };
}

const rowOf = (store: InboxStore, threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;

describe("Mark unread", () => {
  test("a thread read by opening it goes back to New, bold, with only its latest agent message new; a replay keeps it", () => {
    const { store, dir, first } = setup();
    store.markSeen(first.id);
    expect(rowOf(store, first.id)).toMatchObject({ section: "quiet", unread: false, unseen: 0 });

    const row = store.markUnread(first.id);
    expect(row).toMatchObject({ section: "new", unread: true, unseen: 1, read_at: null, sent: null });
    // Nothing sent: no message written to the thread.
    expect(store.thread(first.id)!.messages).toHaveLength(2);

    const again = InboxStore.open(dir);
    expect(rowOf(again, first.id)).toMatchObject({ section: "new", unread: true, unseen: 1 });
    // The next look reads it again.
    expect(again.markSeen(first.id)).toMatchObject({ section: "quiet", unread: false });
  });

  test("a Mark read is cleared, but the questions it set aside stay closed, and the agent is still told once", () => {
    const { store, project, clock } = setup();
    const asked = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: QUESTION }).message;
    store.markRead(asked.id, true);
    expect(rowOf(store, asked.id)).toMatchObject({ section: "quiet", read_at: "2026-10-31T15:00:00.000Z" });

    const row = store.markUnread(asked.id);
    expect(row).toMatchObject({ section: "new", unread: true, unseen: 1, read_at: null });
    expect(store.questionsOf(asked.id).map((q) => [q.state, q.set_aside_at !== null])).toEqual([["closed", true]]);
    expect(store.thread(asked.id)!.messages).toHaveLength(1);

    // The set-aside note still goes after the Undo window: the agent is not left waiting on a closed question.
    clock.now += 10_000;
    const notes = store.tellSetAside(asked.id, 10_000);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain(INBOX_SET_ASIDE_HEADING);
    // The note is not a look: the row stays New and bold.
    expect(rowOf(store, asked.id)).toMatchObject({ section: "new", unread: true });
    // With no Mark read left, Move back has nothing to undo: the question stays closed.
    store.markRead(asked.id, false);
    expect(store.questionsOf(asked.id).map((q) => q.state)).toEqual(["closed"]);
  });

  test("writes nothing where there is nothing to make unread", () => {
    const { store, project, first, update } = setup();
    // Already new.
    let cursor = store.cursor();
    expect(store.markUnread(first.id)).toMatchObject({ section: "new", unread: true });
    expect(store.cursor()).toBe(cursor);
    // The person's reply after the latest agent message (a reply is a look): Sent stays Sent.
    store.sendReply(update.id, { words: "Looks right.", idempotency_key: "k1", questions: [] });
    cursor = store.cursor();
    expect(store.markUnread(first.id)).toMatchObject({ section: "sent", unread: false });
    expect(store.cursor()).toBe(cursor);
    // A thread the person started, no agent message yet.
    const mine = store.startPersonThread({ project_id: project.id, body: "Can you look at the totals?", to: { host: "claude-code", session: "ses_a" }, idempotency_key: "p1" }).message;
    cursor = store.cursor();
    store.markUnread(mine.id);
    expect(store.cursor()).toBe(cursor);
  });

  test("an archived thread refuses, as Mark read does; an unknown one is not found", () => {
    const { store, first } = setup();
    store.resolveThread(first.id, true);
    expect(() => store.markUnread(first.id)).toThrow(InboxError);
    try {
      store.markUnread(first.id);
    } catch (cause) {
      expect((cause as InboxError).code).toBe("thread_resolved");
    }
    expect(() => store.markUnread("msg_nope")).toThrow(InboxError);
  });
});
