/**
 * A reply with no answers leaves the questions open (approval
 * "inbox-words-only-reply", 2026-10-13): what the agent gets when the person
 * replies with words or annotations and answers nothing, proved on a real
 * store in a temp dir. A reply that answers at least one question is
 * unchanged ("Answered 1 question, skipped 2.").
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { inboxWakeText } from "./connection";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

const question = (prompt: string, choices: string[]) => [":::question", prompt, "", ...choices.map((c) => `- [ ] ${c}`), ":::"].join("\n");

const THREE = [
  "Before I build the invoice list:",
  "",
  question("Which layout should the invoice list use?", ["Cards", "A dense table"]),
  "",
  question("Should overdue invoices sort to the top?", ["Yes", "No"]),
  "",
  question("Show paid invoices?", ["Yes", "No"]),
].join("\n");

const STILL_OPEN_3 = "No questions answered yet; all 3 are still open. Don't re-ask them; the person will answer in the Inbox.";

function setup(body = THREE) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-words-only-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date("2026-10-13T10:00:00.000Z") });
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body }).message;
  const questions = store.questionsOf(asked.id) as InboxQuestion[];
  return { store, project, asked, questions };
}

const pickFor = (q: InboxQuestion, label: string): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });

describe("a reply that answers nothing", () => {
  test("words only: the words, then the still-open line; every question stays open and the agent is handed it", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { words: "Got it, I'll answer after lunch.", idempotency_key: "k-1", skip_unanswered: false });
    expect(result.reply.body).toBe(`Got it, I'll answer after lunch.\n\n${STILL_OPEN_3}`);
    expect(result.reply.body).not.toContain("Skipped");
    expect(result.reply.body).not.toContain("Answers to your questions");
    expect(result.questions.map((q) => q.state)).toEqual(["open", "open", "open"]);
    expect(store.pendingReplies("ses_a").map((m) => m.body)).toEqual([result.reply.body]);
    // The wake carries the new body verbatim, under its unchanged header.
    const wake = inboxWakeText({ subject: "Before I build the invoice list", id: result.reply.id, body: result.reply.body });
    expect(wake.endsWith(`\n\n${result.reply.body}`)).toBe(true);
  });

  test("without skip_unanswered (the phone door, an older window, the MCP): the same words-only reply", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { words: "Got it.", idempotency_key: "k-1" });
    expect(result.reply.body).toBe(`Got it.\n\n${STILL_OPEN_3}`);
  });

  test("annotations only: the line, then the annotations' feedback, nothing else", () => {
    const { store, asked } = setup();
    const feedback = "# Feedback on the attached files\n\n## notes.md\n\nTighten the intro.";
    const result = store.sendReply(asked.id, { feedback, idempotency_key: "k-1", skip_unanswered: false });
    expect(result.reply.body).toBe(`${STILL_OPEN_3}\n\n${feedback}`);
    expect(result.questions.every((q) => q.state === "open")).toBe(true);
  });

  test("words and annotations: the words, the line, then the feedback", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { words: "See my notes.", feedback: "Feedback text", idempotency_key: "k-1" });
    expect(result.reply.body).toBe(`See my notes.\n\n${STILL_OPEN_3}\n\nFeedback text`);
  });

  test("one question: the line in the singular", () => {
    const { store, asked } = setup(question("Ship it today?", ["Yes", "No"]));
    const result = store.sendReply(asked.id, { words: "Later.", idempotency_key: "k-1" });
    expect(result.reply.body).toBe("Later.\n\nNo question answered yet; it is still open. Don't re-ask it; the person will answer in the Inbox.");
  });

  test("a pick saved but not in this reply still counts as open", () => {
    const { store, asked, questions } = setup();
    store.savePicks(asked.id, [{ key: questions[0]!.key, revision: 0, answer: pickFor(questions[0]!, "Cards") }]);
    const result = store.sendReply(asked.id, { words: "More soon.", idempotency_key: "k-1" });
    expect(result.reply.body).toBe(`More soon.\n\n${STILL_OPEN_3}`);
    expect(result.questions.map((q) => q.state)).toEqual(["picked", "open", "open"]);
  });

  test("after an earlier reply answered one: the line counts the ones still open", () => {
    const { store, asked, questions } = setup();
    store.sendReply(asked.id, { idempotency_key: "k-1", questions: [{ key: questions[0]!.key, revision: 0, answer: pickFor(questions[0]!, "Cards") }] });
    const result = store.sendReply(asked.id, { words: "The rest tomorrow.", idempotency_key: "k-2" });
    expect(result.reply.body).toBe(
      "The rest tomorrow.\n\nNo new answers in this reply; 2 questions are still open. Don't re-ask them; the person will answer in the Inbox.",
    );
  });

  test("a message with no questions, or none left open: the words alone", () => {
    const plain = setup("Nightly build is green.");
    expect(plain.store.sendReply(plain.asked.id, { words: "Thanks.", idempotency_key: "k-1" }).reply.body).toBe("Thanks.");
    const closed = setup();
    closed.store.markRead(closed.asked.id, true);
    expect(closed.store.sendReply(closed.asked.id, { words: "Thanks.", idempotency_key: "k-1" }).reply.body).toBe("Thanks.");
  });

  test("the person switched to skip: today's skip-all reply, no still-open line", () => {
    const { store, asked } = setup();
    const result = store.sendReply(asked.id, { words: "Redo the design.", idempotency_key: "k-1", skip_unanswered: true });
    expect(result.reply.body.split("\n")[0]).toBe("Skipped 3 questions.");
    expect(result.reply.body).not.toContain("still open");
  });
});

describe("a session asked, then posted a plain update (the words go to the update)", () => {
  test("same session: the reply to the update counts the questions the session asked earlier", () => {
    const { store, project, asked } = setup();
    const update = store.sendMessage({ project_id: project.id, author: AGENT, reply_to: asked.id, body: "Update: the list builds now." }).message;
    const result = store.sendReply(update.id, { words: "Still deciding.", idempotency_key: "k-1", skip_unanswered: false });
    expect(result.reply.body).toBe(`Still deciding.\n\n${STILL_OPEN_3}`);
    expect(store.questionsOf(asked.id).map((q) => q.state)).toEqual(["open", "open", "open"]);
    // The phone door and older windows send no skip_unanswered: the same body.
    expect(store.sendReply(update.id, { words: "Later.", idempotency_key: "k-2" }).reply.body).toBe(`Later.\n\n${STILL_OPEN_3}`);
  });

  test("another session posted the update: its reply says nothing about the first session's questions", () => {
    const { store, project, asked } = setup();
    const other = { ...AGENT, host: "pi", session: "ses_b" };
    const update = store.sendMessage({ project_id: project.id, author: other, reply_to: asked.id, body: "Nightly build is green." }).message;
    const result = store.sendReply(update.id, { words: "Thanks.", idempotency_key: "k-1" });
    expect(result.reply.body).toBe("Thanks.");
  });

  test("same session, a question in the update too: the line counts both messages' questions", () => {
    const { store, project, asked } = setup();
    const update = store.sendMessage({ project_id: project.id, author: AGENT, reply_to: asked.id, body: question("Deploy tonight?", ["Yes", "No"]) }).message;
    const result = store.sendReply(update.id, { words: "Later.", idempotency_key: "k-1" });
    expect(result.reply.body).toBe("Later.\n\nNo questions answered yet; all 4 are still open. Don't re-ask them; the person will answer in the Inbox.");
  });

  test("a partial answer on the update is byte-identical to before: its own questions only, no still-open line", () => {
    const { store, project, asked } = setup();
    const update = store.sendMessage({ project_id: project.id, author: AGENT, reply_to: asked.id, body: question("Deploy tonight?", ["Yes", "No"]) }).message;
    const q = store.questionsOf(update.id)[0]!;
    const result = store.sendReply(update.id, { words: "Yes.", idempotency_key: "k-1", questions: [{ key: q.key, revision: 0, answer: pickFor(q, "Yes") }] });
    expect(result.reply.body.split("\n\n").slice(0, 2)).toEqual(["Answered 1 question.", "Yes."]);
    expect(result.reply.body).toContain("1 of 1 question answered.");
    expect(result.reply.body).not.toContain("still open");
  });
});

describe("a reply that answers at least one question is unchanged", () => {
  test("partial with skip: first line, words, the answers section; no still-open line", () => {
    const { store, asked, questions } = setup();
    const result = store.sendReply(asked.id, {
      words: "Table, please.",
      idempotency_key: "k-1",
      questions: [{ key: questions[0]!.key, revision: 0, answer: pickFor(questions[0]!, "A dense table") }],
      skip_unanswered: true,
    });
    const body = result.reply.body;
    expect(body.split("\n\n").slice(0, 2)).toEqual(["Answered 1 question, skipped 2.", "Table, please."]);
    expect(body).toContain("## Answers to your questions\n\n1 of 3 questions answered. 2 were not answered in this reply;");
    expect(body).not.toContain("still open");
    expect(result.questions.map((q) => q.state)).toEqual(["sent", "sent", "sent"]);
  });

  test("partial with Keep open: first line and the section with Unanswered; no still-open line", () => {
    const { store, asked, questions } = setup();
    const result = store.sendReply(asked.id, {
      idempotency_key: "k-1",
      questions: [{ key: questions[0]!.key, revision: 0, answer: pickFor(questions[0]!, "Cards") }],
      skip_unanswered: false,
    });
    expect(result.reply.body.split("\n")[0]).toBe("Answered 1 question.");
    expect(result.reply.body).toContain("### Unanswered");
    expect(result.reply.body).not.toContain("still open");
    expect(result.questions.map((q) => q.state)).toEqual(["sent", "open", "open"]);
  });
});
