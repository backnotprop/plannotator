/**
 * Mark read and the Send that skips (design record "inbox-mark-read",
 * approved 2026-10-11, with the owner's later decision that Mark read closes
 * the questions it leaves): the store's rules, proved on a real store in a
 * temp dir, including a replay from disk and a store written before either
 * existed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { INBOX_REOPENED_HEADING, INBOX_SET_ASIDE_HEADING } from "@plannotator/core/inbox-questions";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxError } from "./schema";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** A store under a temp dir on a clock the test moves. */
function open(dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-markread-"))) {
  if (!roots.includes(dir)) roots.push(dir);
  const clock = { now: Date.parse("2026-10-11T15:00:00.000Z") };
  const store = InboxStore.open(dir, { now: () => new Date(clock.now) });
  return { store, dir, clock };
}

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

const THREE = [
  "The invoice list needs a layout before I build it.",
  "",
  ":::question",
  "Which layout should the invoice list use?",
  "",
  "Stopped: the list cannot be built without this.",
  "",
  "Decision: when answered",
  "",
  "- [ ] Cards",
  "- [ ] A dense table",
  ":::",
  "",
  ":::question",
  "Should overdue invoices sort to the top?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
  "",
  ":::question-text",
  "Anything the empty state should say?",
  ":::",
].join("\n");

function setup(dir?: string) {
  const opened = open(dir);
  const project = opened.store.ensureProject({ name: "billing", root: "/work/billing" });
  const asked = opened.store.sendMessage({ project_id: project.id, author: AGENT, body: THREE }).message;
  const questions = opened.store.questionsOf(asked.id) as [InboxQuestion, InboxQuestion, InboxQuestion];
  return { ...opened, project, asked, questions };
}

function pickFor(q: InboxQuestion, label: string): QuestionAnswer {
  return { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] };
}

function rowOf(store: InboxStore, threadId: string) {
  return store.listRows().find((r) => r.thread_id === threadId)!;
}

describe("Mark read", () => {
  test("moves the thread to Quiet and closes every waiting question as a skip; a pick saved is kept for Undo", () => {
    const { store, asked, questions } = setup();
    store.savePicks(asked.id, [{ key: questions[1].key, revision: 0, answer: pickFor(questions[1], "Yes") }]);
    expect(rowOf(store, asked.id).section).toBe("stopped");

    const row = store.markRead(asked.id, true);
    expect(row.section).toBe("quiet");
    expect(row.read_at).toBe("2026-10-11T15:00:00.000Z");
    expect(row.unseen).toBe(0); // a Mark read is a look
    expect(row.questions).toMatchObject({ open: 0, picked: 0, stopped: false });
    for (const q of store.questionsOf(asked.id)) {
      expect(q.state).toBe("closed");
      expect(q.answer).toMatchObject({ skipped: true, selected: [] });
      expect(q.answer!.by_reply).toBeUndefined();
      expect(q.set_aside_at).toBe("2026-10-11T15:00:00.000Z");
      expect(q.decision_id).toBeNull();
    }
    // Nothing is sent: no message was written.
    expect(store.thread(asked.id)!.messages).toHaveLength(1);
    // A pick on a closed question is refused until Move back.
    expect(() => store.savePicks(asked.id, [{ key: questions[0].key, revision: 1, answer: pickFor(questions[0], "Cards") }])).toThrow(InboxError);
  });

  test("Undo reopens the questions exactly as they were, the saved pick included", () => {
    const { store, asked, questions } = setup();
    store.savePicks(asked.id, [{ key: questions[1].key, revision: 0, answer: pickFor(questions[1], "Yes") }]);
    store.markRead(asked.id, true);
    const back = store.markRead(asked.id, false);
    expect(back.section).toBe("stopped");
    expect(back.read_at).toBeNull();
    const [q1, q2, q3] = store.questionsOf(asked.id);
    expect([q1!.state, q2!.state, q3!.state]).toEqual(["open", "picked", "open"]);
    expect(q2!.answer?.selected).toEqual(["Yes"]);
    expect(q1!.answer).toBeNull();
    expect(q2!.set_aside_at).toBeNull();
  });

  test("an agent's next message brings the thread back; the closed questions stay closed", () => {
    const { store, project, asked } = setup();
    store.markRead(asked.id, true);
    store.sendMessage({ project_id: project.id, author: AGENT, body: "A new question.\n\n:::question\nShip it today?\n\n- [ ] Yes\n- [ ] No\n:::", reply_to: asked.id });
    const row = rowOf(store, asked.id);
    expect(row.read_at).toBeNull();
    expect(row.section).toBe("waiting");
    expect(row.questions.open).toBe(1);
    expect(store.questionsOf(asked.id).every((q) => q.state === "closed")).toBe(true);
  });

  test("a thread with only news goes to Quiet too, and the person's own reply ends the read", () => {
    const { store, project } = setup();
    const news = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: "The nightly build is green." }).message;
    expect(rowOf(store, news.id).section).toBe("new");
    expect(store.markRead(news.id, true).section).toBe("quiet");
    // Undo takes back the look the Mark read counted: the news is news again.
    expect(store.markRead(news.id, false)).toMatchObject({ section: "new", unseen: 1 });
    expect(store.markRead(news.id, true).section).toBe("quiet");
    store.sendReply(news.id, { words: "Thanks.", idempotency_key: "k-1" });
    const row = rowOf(store, news.id);
    expect(row.read_at).toBeNull();
    expect(row.section).toBe("sent");
  });

  test("an archived thread refuses; archive beats read in the list", () => {
    const { store, asked } = setup();
    store.markRead(asked.id, true);
    store.resolveThread(asked.id, true);
    expect(rowOf(store, asked.id).read_at).toBeNull();
    expect(() => store.markRead(asked.id, true)).toThrow(InboxError);
  });

  test("the asking agent is told once, after the Undo window: one note per asking message, a reply to it", () => {
    const { store, clock, asked } = setup();
    store.markRead(asked.id, true);
    // Inside the Undo window: nothing goes.
    expect(store.tellSetAside(asked.id, 8_000)).toEqual([]);
    expect(store.setAsideDue(8_000)).toEqual([]);
    clock.now += 8_000;
    expect(store.setAsideDue(8_000)).toEqual([asked.id]);
    const notes = store.tellSetAside(asked.id, 8_000);
    expect(notes).toHaveLength(1);
    const note = notes[0]!;
    expect(note).toMatchObject({ author: { kind: "person" }, reply_to: asked.id, thread_id: asked.id });
    expect(note.body.split("\n")[0]).toBe(INBOX_SET_ASIDE_HEADING);
    expect(note.body).toContain("- Q1. Which layout should the invoice list use?");
    expect(note.body).toContain("- Q3. Anything the empty state should say?");
    expect(note.set_aside).toHaveLength(3);
    // Delivered like a reply: the asking session's connection is handed it.
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toEqual([note.id]);
    // The note does not end the read, and pushes nothing new to the top.
    expect(rowOf(store, asked.id)).toMatchObject({ section: "quiet", last_author: "person" });
    // Once: no second note for the same Mark read.
    expect(store.tellSetAside(asked.id, 8_000)).toEqual([]);
    expect(store.setAsideDue(0)).toEqual([]);
  });

  test("an Undo inside the window tells nothing", () => {
    const { store, clock, asked } = setup();
    store.markRead(asked.id, true);
    clock.now += 3_000;
    store.markRead(asked.id, false);
    clock.now += 10_000;
    expect(store.setAsideDue(8_000)).toEqual([]);
    expect(store.tellSetAside(asked.id, 8_000)).toEqual([]);
  });

  test("a replay from disk reads the same rows, questions and notes", () => {
    const { store, dir, clock, asked } = setup();
    store.markRead(asked.id, true);
    clock.now += 9_000;
    store.tellSetAside(asked.id, 8_000);
    const again = InboxStore.open(dir);
    expect(again.listRows()).toEqual(store.listRows());
    expect(again.questionsOf(asked.id)).toEqual(store.questionsOf(asked.id));
    expect(again.setAsideDue(0)).toEqual([]);
  });

  test("a store written before Mark read replays unchanged: no read_at, the same sections", () => {
    const { store, dir, asked, project } = setup();
    const news = store.sendMessage({ project_id: project.id, author: { ...AGENT, session: "ses_b" }, body: "Nightly build is green." }).message;
    const before = store.listSections().map((s) => [s.id, s.threads.map((t) => t.thread_id)]);
    // Nothing a pre-Mark-read Inbox would not have written.
    const folder = join(dir, "inbox", "projects", readdirSync(join(dir, "inbox", "projects"))[0]!);
    const text = readFileSync(join(folder, "messages.jsonl"), "utf8") + readFileSync(join(folder, "questions.jsonl"), "utf8");
    expect(text).not.toContain("person_read");
    expect(text).not.toContain("set_aside");
    const again = InboxStore.open(dir);
    expect(again.listSections().map((s) => [s.id, s.threads.map((t) => t.thread_id)])).toEqual(before);
    expect(again.listRows().every((r) => r.read_at === null)).toBe(true);
    expect(before).toEqual([
      ["stopped", [asked.id]],
      ["holding", []],
      ["waiting", []],
      ["new", [news.id]],
      ["sent", []],
      ["quiet", []],
    ]);
  });
});

describe("a Send skips what it leaves unanswered", () => {
  test("words only: every open question is sent as a skip by_reply, and the reply says so", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { words: "Redo the design.", idempotency_key: "k-1", skip_unanswered: true });
    const body = result.reply.body;
    expect(body.split("\n")[0]).toBe("Skipped 3 questions.");
    expect(body).toContain("Redo the design.");
    expect(body).toContain("0 of 3 questions answered. 3 were not answered in this reply; treat them as skipped, and ask again if you still need them.");
    expect(body.match(/Skipped \(not answered in this reply\)/g)).toHaveLength(3);
    for (const q of result.questions) {
      expect(q.state).toBe("sent");
      expect(q.answer).toMatchObject({ skipped: true, by_reply: true });
      expect(q.sent_reply_id).toBe(result.reply.id);
    }
    expect(rowOf(store, asked.id).section).toBe("sent");
  });

  test("with a pick: the pick is the answer, the rest are skipped", () => {
    const { store, asked, questions } = setup();
    const result = store.sendReply(asked.id, {
      idempotency_key: "k-1",
      questions: [{ key: questions[0].key, revision: 0, answer: pickFor(questions[0], "A dense table") }],
      skip_unanswered: true,
    });
    expect(result.reply.body.split("\n")[0]).toBe("Answered 1 question, skipped 2.");
    expect(result.questions.map((q) => q.state)).toEqual(["sent", "sent", "sent"]);
    expect(result.questions[0]!.answer?.skipped).toBeUndefined();
  });

  test("without skip_unanswered (Keep open, an older window, the MCP) the questions stay open", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { words: "Redo the design.", idempotency_key: "k-1" });
    // The words, then the line that keeps the agent from asking again
    // (approval "inbox-words-only-reply", store-words-only-reply.test.ts).
    expect(result.reply.body).toBe(
      "Redo the design.\n\nNo questions answered yet; all 3 are still open. Don't re-ask them; the person will answer in the Inbox.",
    );
    expect(result.questions.map((q) => q.state)).toEqual(["open", "open", "open"]);
    expect(rowOf(store, asked.id).section).toBe("stopped");
  });

  test("a skip alone is a Send: nothing written by the person is needed", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { idempotency_key: "k-1", skip_unanswered: true });
    expect(result.reply.body.split("\n")[0]).toBe("Skipped 3 questions.");
  });

  test("a skip-only Send on a message with nothing left open is nothing_to_send, not a validation error", () => {
    const { store, asked } = setup();
    store.markRead(asked.id, true);
    expect(() => store.sendReply(asked.id, { idempotency_key: "k-1", skip_unanswered: true })).toThrow(expect.objectContaining({ code: "nothing_to_send" }));
    expect(() => store.sendReply(asked.id, { idempotency_key: "k-2" })).toThrow(expect.objectContaining({ code: "validation_error" }));
  });
});

describe("Undo after the agent was told", () => {
  test("an Undo after the set-aside note sends one reopened note; a later Mark read may tell again", () => {
    const { store, clock, asked } = setup();
    store.markRead(asked.id, true);
    clock.now += 10_000;
    expect(store.tellSetAside(asked.id, 10_000)).toHaveLength(1);
    store.markRead(asked.id, false);
    const reopened = store.thread(asked.id)!.messages.at(-1)!;
    expect(reopened).toMatchObject({ author: { kind: "person" }, reply_to: asked.id });
    expect(reopened.body.split("\n")[0]).toBe(INBOX_REOPENED_HEADING);
    expect(reopened.body).toContain("- Q2. Should overdue invoices sort to the top?");
    expect(reopened.reopened).toHaveLength(3);
    // The asking session is handed it like any reply.
    expect(store.pendingReplies("ses_a").map((m) => m.id)).toContain(reopened.id);
    expect(store.questionsOf(asked.id).every((q) => q.state === "open")).toBe(true);
    // Marked read again: the agent is told again, once.
    store.markRead(asked.id, true);
    clock.now += 10_000;
    expect(store.tellSetAside(asked.id, 10_000)).toHaveLength(1);
    expect(store.tellSetAside(asked.id, 10_000)).toEqual([]);
  });

  test("an Undo before the note went writes no reopened note", () => {
    const { store, asked } = setup();
    store.markRead(asked.id, true);
    store.markRead(asked.id, false);
    expect(store.thread(asked.id)!.messages).toHaveLength(1);
  });
});
