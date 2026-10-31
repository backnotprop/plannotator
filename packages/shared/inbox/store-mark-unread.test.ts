/**
 * Mark unread (the owner's ask, 2026-10-31: "I need a way to mark a message
 * unread"): the store's rules, proved on a real store in a temp dir, a replay
 * from disk included. The latest agent message is new again, so the row is
 * New and bold; a standing Mark read is left alone, so Move back still
 * reopens what it set aside; a look capped at `through_seq` is the exact Undo;
 * nothing is written to the thread (no note: the agent is not told); nothing
 * is written at all where there is nothing to make unread.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { markProjectRead, unmarkProjectRead } from "./project-batch";
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

/** A thread with one question, marked read: the question closed, the row in Quiet. */
function markedRead() {
  const opened = setup();
  const asked = opened.store.sendMessage({ project_id: opened.project.id, author: { ...AGENT, session: "ses_b" }, body: QUESTION }).message;
  opened.store.markRead(asked.id, true);
  expect(rowOf(opened.store, asked.id)).toMatchObject({ section: "quiet", read_at: "2026-10-31T15:00:00.000Z" });
  return { ...opened, asked };
}

const questionStates = (store: InboxStore, threadId: string) => store.questionsOf(threadId).map((q) => q.state);

describe("Mark unread", () => {
  test("a thread read by opening it goes back to New, bold, with only its latest agent message new; a replay keeps it", () => {
    const { store, dir, first } = setup();
    store.markSeen(first.id);
    expect(rowOf(store, first.id)).toMatchObject({ section: "quiet", unread: false, unseen: 0 });

    const { thread: row, wrote } = store.markUnread(first.id);
    expect(wrote).toBe(true);
    expect(row).toMatchObject({ section: "new", unread: true, unseen: 1, read_at: null, sent: null });
    // Nothing sent: no message written to the thread.
    expect(store.thread(first.id)!.messages).toHaveLength(2);

    const again = InboxStore.open(dir);
    expect(rowOf(again, first.id)).toMatchObject({ section: "new", unread: true, unseen: 1 });
    // The next look reads it again.
    expect(again.markSeen(first.id)).toMatchObject({ section: "quiet", unread: false });
  });

  test("on a thread marked read the row is New and bold, its question stays closed, and the agent is still told once", () => {
    const { store, asked, clock } = markedRead();

    const { thread: row } = store.markUnread(asked.id);
    expect(row).toMatchObject({ section: "new", unread: true, unseen: 1 });
    expect(store.questionsOf(asked.id).map((q) => [q.state, q.set_aside_at !== null])).toEqual([["closed", true]]);
    expect(store.thread(asked.id)!.messages).toHaveLength(1);

    // The set-aside note still goes after the Undo window: the agent is not left waiting on a closed question.
    clock.now += 10_000;
    const notes = store.tellSetAside(asked.id, 10_000);
    expect(notes).toHaveLength(1);
    expect(notes[0]!.body).toContain(INBOX_SET_ASIDE_HEADING);
    // The note is not a look: the row stays New and bold.
    expect(rowOf(store, asked.id)).toMatchObject({ section: "new", unread: true });
  });

  test("Move back after a Mark unread reopens the question the Mark read closed, a replay included", () => {
    const { store, dir, asked } = markedRead();
    store.markUnread(asked.id);

    const replayed = InboxStore.open(dir);
    replayed.markRead(asked.id, false);
    expect(questionStates(replayed, asked.id)).toEqual(["open"]);
    expect(rowOf(replayed, asked.id)).toMatchObject({ section: "waiting", unread: true, read_at: null });
  });

  test("Move back after a Mark unread, once the agent was told, tells it the question is open again", () => {
    const { store, asked } = markedRead();
    store.markUnread(asked.id);
    store.tellSetAside(asked.id, 0);
    store.markRead(asked.id, false);
    expect(questionStates(store, asked.id)).toEqual(["open"]);
    expect(store.thread(asked.id)!.messages.filter((m) => (m.reopened?.length ?? 0) > 0)).toHaveLength(1);
  });

  test("the next look after a Mark unread puts the row back as read, and Move back still reopens", () => {
    const { store, asked } = markedRead();
    const readAt = rowOf(store, asked.id).read_at;
    store.markUnread(asked.id);
    expect(store.markSeen(asked.id)).toMatchObject({ section: "quiet", unread: false, read_at: readAt });
    store.markRead(asked.id, false);
    expect(questionStates(store, asked.id)).toEqual(["open"]);
  });

  test("Mark read after a Mark unread only gives the look back: the standing Mark read keeps what it closed", () => {
    const { store, asked } = markedRead();
    const readSeq = store.message(asked.id)!.person_read_seq;
    store.markUnread(asked.id);
    expect(store.markRead(asked.id, true)).toMatchObject({ section: "quiet", unread: false });
    expect(store.message(asked.id)!.person_read_seq).toBe(readSeq);
    store.markRead(asked.id, false);
    expect(questionStates(store, asked.id)).toEqual(["open"]);
  });

  test("Mark all as read takes the row as a look; its Undo makes it unread again, never a Move back", () => {
    const { store, project, first, asked } = markedRead();
    store.markSeen(first.id);
    store.markUnread(asked.id);
    const batch = markProjectRead(store, project.id);
    expect(batch).toEqual({ read: [], looked: [asked.id] });
    expect(rowOf(store, asked.id)).toMatchObject({ section: "quiet", unread: false });
    unmarkProjectRead(store, project.id, batch.read, batch.looked);
    expect(rowOf(store, asked.id)).toMatchObject({ section: "new", unread: true });
    expect(questionStates(store, asked.id)).toEqual(["closed"]);
  });

  describe("Undo (a look capped at `through_seq`)", () => {
    const mirror = (store: InboxStore, id: string) => {
      const { person_seen_seq, person_read_seq, person_read_at, person_seen_before_read } = store.message(id)!;
      return { person_seen_seq, person_read_seq, person_read_at, person_seen_before_read };
    };

    test("puts back exactly what was there: the look and the Mark read, so Move back still reopens", () => {
      const { store, asked } = markedRead();
      const before = mirror(store, asked.id);
      const { through_seq } = store.markUnread(asked.id);
      store.markSeen(asked.id, through_seq);
      expect(mirror(store, asked.id)).toEqual(before);
      expect(rowOf(store, asked.id)).toMatchObject({ section: "quiet", unread: false });
      store.markRead(asked.id, false);
      expect(questionStates(store, asked.id)).toEqual(["open"]);
    });

    test("a question that arrived during the toast stays open and new, on a thread that was marked read", () => {
      const { store, project, asked } = markedRead();
      const { through_seq } = store.markUnread(asked.id);
      const next = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: QUESTION, reply_to: asked.id }).message;

      store.markSeen(asked.id, through_seq);
      expect(questionStates(store, next.id)).toEqual(["open"]);
      expect(rowOf(store, asked.id)).toMatchObject({ section: "waiting", unread: true, unseen: 1 });
    });

    test("a message that arrived during the toast stays new, on a thread read by opening it", () => {
      const { store, project, first, update } = setup();
      store.markSeen(first.id);
      const { through_seq } = store.markUnread(first.id);
      store.sendMessage({ project_id: project.id, author: AGENT, body: "Update: the totals are in.", reply_to: update.id });

      store.markSeen(first.id, through_seq);
      expect(rowOf(store, first.id)).toMatchObject({ section: "new", unread: true, unseen: 1 });
    });
  });

  test("writes nothing, and says so, where there is nothing to make unread", () => {
    const { store, project, first, update } = setup();
    // Already new.
    let cursor = store.cursor();
    expect(store.markUnread(first.id)).toMatchObject({ wrote: false, thread: { section: "new", unread: true } });
    expect(store.cursor()).toBe(cursor);
    // The person's reply after the latest agent message (a reply is a look): Sent stays Sent.
    store.sendReply(update.id, { words: "Looks right.", idempotency_key: "k1", questions: [] });
    cursor = store.cursor();
    expect(store.markUnread(first.id)).toMatchObject({ wrote: false, thread: { section: "sent", unread: false } });
    expect(store.cursor()).toBe(cursor);
    // A thread the person started, no agent message yet.
    const mine = store.startPersonThread({ project_id: project.id, body: "Can you look at the totals?", to: { host: "claude-code", session: "ses_a" }, idempotency_key: "p1" }).message;
    cursor = store.cursor();
    expect(store.markUnread(mine.id).wrote).toBe(false);
    expect(store.cursor()).toBe(cursor);
  });

  test("a second Mark unread on a thread marked read writes nothing", () => {
    const { store, asked } = markedRead();
    store.markUnread(asked.id);
    const cursor = store.cursor();
    expect(store.markUnread(asked.id).wrote).toBe(false);
    expect(store.cursor()).toBe(cursor);
  });

  test("an archived thread refuses, one that came back too; an unknown one is not found", () => {
    const { store, project, first, update } = setup();
    store.resolveThread(first.id, true);
    const refused = (id: string) => {
      try {
        store.markUnread(id);
      } catch (cause) {
        return (cause as InboxError).code;
      }
      return null;
    };
    expect(refused(first.id)).toBe("thread_resolved");
    store.sendMessage({ project_id: project.id, author: AGENT, body: "Back with news.", reply_to: update.id });
    expect(refused(first.id)).toBe("thread_resolved");
    expect(refused("msg_nope")).toBe("thread_not_found");
  });
});
