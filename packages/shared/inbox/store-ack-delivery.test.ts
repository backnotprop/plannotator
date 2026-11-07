/**
 * 👍 Looks good reaches the agent (design record "inbox-acknowledge",
 * amended 2026-10-16: "I think we just need to send looks good through").
 * Once the Undo window passes with the ack standing, the store writes the
 * ack's settled line and then one note (a person's reply to the message,
 * `ack_of`, body `inboxAckLine`) that the existing reply delivery hands to
 * the session that wrote the message, exactly once. Proved on a real store
 * in a temp dir, including a replay from disk and a store written before the
 * amendment (its settled acks were never sent and are not sent now).
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { InboxAuthor } from "@plannotator/core/inbox-types";
import { inboxAckLine } from "./connection";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const WINDOW = 10_000;
const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-ack-delivery-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const clock = { now: Date.parse("2026-10-16T15:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

function setup() {
  const opened = open();
  const project = opened.store.ensureProject({ name: "plannotator", root: "/work/plannotator" });
  const sent = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: "Merged #1937. CI is green." }).message;
  return { ...opened, project, sent };
}

const rowOf = (store: InboxStore, threadId: string) => store.listRows().find((r) => r.thread_id === threadId)!;

function messageLines(dir: string): string[] {
  const projects = join(dir, "inbox", "projects");
  const [key] = readdirSync(projects);
  return readFileSync(join(projects, key!, "messages.jsonl"), "utf8").split("\n").filter(Boolean);
}

describe("a 👍 sent through", () => {
  test("inside the window nothing is written for the agent; after it, the ack line then one note, handed to its session once", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true);
    expect(store.settleAcks(WINDOW)).toEqual([]);
    expect(store.pendingReplies("ses_a")).toEqual([]);

    clock.now += WINDOW;
    const before = store.cursor();
    const [settled] = store.settleAcks(WINDOW);
    expect(store.cursor()).toBe(before + 2);
    const noteId = settled!.ack!.note_id!;
    expect(settled!.ack!.settled_seq).toBe(before + 1);
    const note = store.message(noteId)!;
    expect(note).toMatchObject({ author: { kind: "person" }, reply_to: sent.id, thread_id: sent.id, ack_of: sent.id, body: inboxAckLine(sent.id) });
    expect(store.messageCursor(noteId)).toBe(before + 2);

    // The thread as the person and the agent read it: one message, Quiet, 👍 on the row.
    expect(store.thread(sent.id)!.messages.map((m) => m.id)).toEqual([sent.id]);
    const row = rowOf(store, sent.id);
    expect(row).toMatchObject({ section: "quiet", message_count: 1, last_author: "agent", sent: null });
    expect(row.read_at).not.toBeNull();
    expect(row.ack).toMatchObject({ label: "Looks good" });

    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([noteId]);
    expect(store.pendingReplies("ses_b")).toEqual([]);
    expect(store.windowThread(sent.id)!.messages[0]!.ack!.delivered_at).toBeNull();

    clock.now += 1_000;
    store.recordDelivery(noteId, { host: "claude-code", session: "ses_a" });
    expect(store.pendingReplies("ses_a")).toEqual([]);
    const shown = store.windowThread(sent.id)!.messages[0]!.ack!;
    expect(shown.delivered_at).toBe("2026-10-16T15:00:11.000Z");
    expect(shown.seen_at).toBe("2026-10-16T15:00:11.000Z");
    // A second settle writes nothing.
    const lines = store.cursor();
    expect(store.settleAcks(WINDOW)).toEqual([]);
    expect(store.cursor()).toBe(lines);
    expect(rowOf(store, sent.id).section).toBe("quiet");
  });

  test("taken back after it settled and before it went: the note stays in the log and is never handed out", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true);
    clock.now += WINDOW;
    store.settleAcks(WINDOW);
    expect(store.pendingReplies("ses_a")).toHaveLength(1);
    store.ackMessage(sent.id, false);
    expect(store.pendingReplies("ses_a")).toEqual([]);
    // A new 👍 is a new note.
    store.ackMessage(sent.id, true);
    clock.now += WINDOW;
    store.settleAcks(WINDOW);
    const pending = store.pendingReplies("ses_a");
    expect(pending).toHaveLength(1);
    expect(pending[0]!.id).toBe(store.message(sent.id)!.ack!.note_id!);
  });

  test("Move back withdraws a settled 👍 not yet delivered", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true);
    clock.now += WINDOW;
    store.settleAcks(WINDOW);
    store.markRead(sent.id, false);
    expect(store.message(sent.id)!.ack).toBeNull();
    expect(store.pendingReplies("ses_a")).toEqual([]);
  });

  test("replay from disk: the same thread, row and pending, and the delivery kept", () => {
    const { store, clock, dir, sent } = setup();
    store.ackMessage(sent.id, true);
    clock.now += WINDOW;
    store.settleAcks(WINDOW);
    const viewOf = (s: InboxStore) => ({ thread: s.windowThread(sent.id), row: rowOf(s, sent.id), pending: s.pendingReplies("ses_a").map((m) => m.id) });
    const live = viewOf(store);
    expect(viewOf(open(dir).store)).toEqual(live);
    store.recordDelivery(live.pending[0]!, { host: "claude-code", session: "ses_a" });
    const after = viewOf(store);
    const reopened = open(dir).store;
    expect(viewOf(reopened)).toEqual(after);
    expect(reopened.pendingReplies("ses_a")).toEqual([]);
  });

  test("a store written before the amendment: its settled 👍 has no note, nothing is sent and nothing is written", () => {
    const { store, clock, dir, sent } = setup();
    store.ackMessage(sent.id, true);
    clock.now += WINDOW;
    store.settleAcks(WINDOW);
    // Rewrite the file as an older Inbox left it: no note, and the settled ack without `note_id`.
    const projects = join(dir, "inbox", "projects");
    const [key] = readdirSync(projects);
    const file = join(projects, key!, "messages.jsonl");
    const older = messageLines(dir)
      .map((text) => JSON.parse(text) as { record: { ack_of?: string; ack?: Record<string, unknown> | null } })
      .filter((line) => !line.record.ack_of)
      .map((line) => {
        if (line.record.ack) delete line.record.ack.note_id;
        return JSON.stringify(line);
      });
    writeFileSync(file, `${older.join("\n")}\n`);
    const reopened = open(dir).store;
    const cursor = reopened.cursor();
    expect(reopened.pendingReplies("ses_a")).toEqual([]);
    expect(reopened.settleAcks(WINDOW)).toEqual([]);
    expect(reopened.cursor()).toBe(cursor);
    expect(rowOf(reopened, sent.id)).toMatchObject({ section: "quiet", message_count: 1 });
    expect(reopened.windowThread(sent.id)!.messages[0]!.ack!.delivered_at).toBeNull();
  });
});

describe("a 👍 that can no longer go when its window ends", () => {
  test("the person replied inside the window: settled as not sent (replied), no note; the agent gets the reply alone", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true);
    clock.now += 2_000;
    const reply = store.sendReply(sent.id, { idempotency_key: "r1", words: "Actually, one more thing: bump the version too." }).reply!;
    clock.now += WINDOW;
    const before = store.cursor();
    const [settled] = store.settleAcks(WINDOW);
    expect(store.cursor()).toBe(before + 1);
    expect(settled!.ack).toMatchObject({ not_sent: "replied", note_id: null, settled_seq: before + 1 });
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([reply.id]);
    // No agent ever sees it, and reading the thread never marks it seen.
    expect(store.agentThread(sent.id)!.messages[0]!.ack).toBeNull();
    store.markAcksSeen(sent.id);
    expect(store.message(sent.id)!.ack!.seen_at ?? null).toBeNull();
    expect(store.windowThread(sent.id)!.messages[0]!.ack).toMatchObject({ not_sent: "replied", delivered_at: null });
  });

  test("the agent wrote again inside the window: settled as not sent (wrote_again), no note", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true);
    clock.now += 2_000;
    store.sendMessage({ project_id: sent.project_id, author: AGENT, body: "One more question: tag it 0.29?", reply_to: sent.id });
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    expect(settled!.ack).toMatchObject({ not_sent: "wrote_again", note_id: null });
    expect(store.pendingReplies("ses_a")).toEqual([]);
    expect(store.agentThread(sent.id)!.messages[0]!.ack).toBeNull();
    // A replay reads the same.
    expect(store.settleAcks(WINDOW)).toEqual([]);
  });

});

describe("a reaction from the 👍's tray (approval \"inbox-reaction-tray\")", () => {
  test("the note carries the emoji the window closed on, with its name; read_thread shows it too, after a restart", () => {
    const { store, clock, sent, dir } = setup();
    store.ackMessage(sent.id, true, { emoji: "🦄" });
    clock.now += 4_000;
    // Changed inside the Undo window: the one it ends on is the one that goes.
    store.ackMessage(sent.id, true, { emoji: "🚀", label: "Ship it" });
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    const note = store.message(settled!.ack!.note_id!)!;
    expect(note.body).toBe(`The person reacted 🚀 Ship it to your message (${sent.id}). No reply needed unless the reaction asks for one.`);
    expect(note.ack_reaction).toEqual({ emoji: "🚀", label: "Ship it" });
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([note.id]);
    expect(store.agentThread(sent.id)!.messages[0]!.ack).toEqual({ label: "Looks good", at: settled!.ack!.at, reaction: { emoji: "🚀", label: "Ship it" } });
    const reopened = InboxStore.open(dir, { now: () => new Date(clock.now) });
    expect(reopened.agentThread(sent.id)!.messages[0]!.ack).toMatchObject({ reaction: { emoji: "🚀", label: "Ship it" } });
    expect(reopened.message(note.id)!.ack_reaction).toEqual({ emoji: "🚀", label: "Ship it" });
  });

  test("an emoji with no name: the note says the emoji alone; 👍 Looks good keeps today's line and no reaction", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true, { emoji: "🎉" });
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    const note = store.message(settled!.ack!.note_id!)!;
    expect(note.body).toBe(`The person reacted 🎉 to your message (${sent.id}). No reply needed unless the reaction asks for one.`);
    expect(note.ack_reaction).toEqual({ emoji: "🎉" });

    const plain = setup();
    plain.store.ackMessage(plain.sent.id, true, null);
    plain.clock.now += WINDOW;
    const [thumbs] = plain.store.settleAcks(WINDOW);
    const thumbsNote = plain.store.message(thumbs!.ack!.note_id!)!;
    expect(thumbsNote.body).toBe(`The person marked your message 👍 Looks good (${plain.sent.id}). No reply needed unless you have a question.`);
    expect(thumbsNote.ack_reaction).toBeUndefined();
    expect(plain.store.agentThread(plain.sent.id)!.messages[0]!.ack).toEqual({ label: "Looks good", at: thumbs!.ack!.at });
  });

  // Owner, 2026-11-07: "Reaction should go away after sending and only come back when I can send a new one".
  test("once sent it never changes: another emoji is refused after the window, a delivered one can't be taken back or withdrawn by Move back, and no second note is written", () => {
    const { store, clock, sent } = setup();
    store.ackMessage(sent.id, true, { emoji: "🎉" });
    clock.now += WINDOW;
    const [settled] = store.settleAcks(WINDOW);
    const noteId = settled!.ack!.note_id!;
    const notes = () => store.pendingReplies("ses_a").map((m) => m.id);
    const refused = (fn: () => void) => {
      try {
        fn();
      } catch (error) {
        return (error as { code?: string }).code;
      }
      return "not refused";
    };
    // Sent, not yet delivered: another emoji (any path: the tray, the … picker, the API) is refused; the same 👍 again writes nothing.
    expect(refused(() => store.ackMessage(sent.id, true, { emoji: "🧪", label: "Add tests" }))).toBe("ack_sent");
    expect(refused(() => store.ackMessage(sent.id, true, null))).toBe("ack_sent");
    const cursor = store.cursor();
    store.ackMessage(sent.id, true);
    store.ackMessage(sent.id, true, { emoji: "🎉" });
    expect(store.cursor()).toBe(cursor);
    expect(notes()).toEqual([noteId]);

    store.recordDelivery(noteId, { host: "claude-code", session: "ses_a" });
    expect(refused(() => store.ackMessage(sent.id, false))).toBe("ack_sent");
    expect(refused(() => store.ackMessage(sent.id, true, { emoji: "🧪" }))).toBe("ack_sent");
    store.markRead(sent.id, false);
    store.markRead(sent.id, true);
    expect(store.message(sent.id)!.ack).toMatchObject({ note_id: noteId, reaction: { emoji: "🎉" } });
    expect(refused(() => store.ackMessage(sent.id, true, { emoji: "🧪" }))).toBe("ack_sent");
    expect([...store.thread(sent.id)!.messages, ...store.pendingReplies("ses_a")].filter((m) => m.ack_of)).toEqual([]);
    expect(store.agentThread(sent.id)!.messages[0]!.ack).toMatchObject({ reaction: { emoji: "🎉" } });

    // The agent's next message takes a new one.
    const next = store.sendMessage({ project_id: sent.project_id, author: AGENT, body: "Tagged 0.29.", reply_to: sent.id }).message;
    store.ackMessage(next.id, true, { emoji: "🧪", label: "Add tests" });
    expect(store.message(next.id)!.ack).toMatchObject({ reaction: { emoji: "🧪", label: "Add tests" }, settled_seq: null });
  });

  test("another emoji on a marked message changes only the emoji; null is 👍 Looks good again; none keeps it", () => {
    const { store, sent } = setup();
    store.ackMessage(sent.id, true, { emoji: "🦄" });
    const at = store.message(sent.id)!.ack!.at;
    store.ackMessage(sent.id, true, { emoji: "🧪", label: "Add tests" });
    expect(store.message(sent.id)!.ack).toMatchObject({ at, reaction: { emoji: "🧪", label: "Add tests" } });
    const before = store.cursor();
    // The plain call (an older window) leaves the emoji as it is, and writes nothing.
    store.ackMessage(sent.id, true);
    expect(store.cursor()).toBe(before);
    expect(store.message(sent.id)!.ack!.reaction).toEqual({ emoji: "🧪", label: "Add tests" });
    store.ackMessage(sent.id, true, null);
    expect(store.message(sent.id)!.ack!.reaction).toBeUndefined();
    expect(store.message(sent.id)!.ack!.at).toBe(at);
  });
});
