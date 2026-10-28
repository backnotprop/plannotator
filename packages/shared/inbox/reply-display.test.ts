/**
 * The window shows the person their own sent reply in their words
 * (`splitInboxReplyBody`, core), while the stored body and what agents get
 * stay as the store wrote them. Proved on replies a real store writes, so a
 * change to `composeInboxReplyBody` that the splitter no longer reads fails
 * here: the first line, the still-open line and the answers section (one
 * message, several messages) come out, the feedback stays after, and the
 * words agree with what the folded line and search read.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { QUESTION_ANSWERS_HEADING } from "@plannotator/core/question-block";
import { splitInboxReplyBody } from "@plannotator/core/inbox-questions";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";
import { inboxSearchReplyText } from "./search";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const A: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const question = (prompt: string) => [":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function open() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-reply-display-"));
  roots.push(dir);
  let tick = Date.parse("2026-10-24T15:00:00.000Z");
  const store = InboxStore.open(dir, { now: () => new Date((tick += 1000)) });
  const project = store.ensureProject({ name: "plannotator", root: "/work/plannotator" });
  return { store, project };
}
const pick = (q: InboxQuestion, label = "Yes"): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });

test("words, answers on one message and feedback: the words alone, the rest after, the body as stored", () => {
  const { store, project } = open();
  const asked = store.sendMessage({ project_id: project.id, author: A, body: [question("Ship it?"), question("Tell the team?")].join("\n\n") }).message;
  const [ship] = store.questionsOf(asked.id);
  const reply = store.sendReply(asked.id, {
    idempotency_key: "k",
    words: "Looks right to me.\n\nOne more thing: keep the old flag.",
    questions: [{ key: ship!.key, revision: 0, answer: pick(ship!) }],
    feedback: "# Feedback on the attached files\n\n## notes.md\n\n> Say which plan.",
  }).reply;
  // What the agent gets is unchanged: the first line, the still-open line and the answers section.
  expect(reply.body.startsWith("Answered 1 question.\n\n")).toBe(true);
  expect(reply.body).toContain(`## ${QUESTION_ANSWERS_HEADING}`);
  expect(reply.body).toContain("You have 1 other question open in this thread.");
  const parts = splitInboxReplyBody(reply.body);
  expect(parts).toEqual({
    words: "Looks right to me.\n\nOne more thing: keep the old flag.",
    answers: true,
    rest: "# Feedback on the attached files\n\n## notes.md\n\n> Say which plan.",
    changed: true,
  });
  expect(inboxSearchReplyText(reply.body)).toContain("keep the old flag");
  expect(inboxSearchReplyText(reply.body)).not.toContain("Answered");
});

test("answers on two messages of one session (one reply): the grouped section comes out whole", () => {
  const { store, project } = open();
  const first = store.sendMessage({ project_id: project.id, author: A, body: question("Use the table?") }).message;
  const second = store.sendMessage({ project_id: project.id, author: A, reply_to: first.id, body: [question("Behind a flag?"), question("Voided too?")].join("\n\n") }).message;
  const [table] = store.questionsOf(first.id);
  const [flag, voided] = store.questionsOf(second.id);
  const reply = store.sendReply(second.id, {
    idempotency_key: "k2",
    words: "Thanks!",
    questions: [
      { message_id: first.id, key: table!.key, revision: 0, answer: pick(table!) },
      { key: flag!.key, revision: 0, answer: pick(flag!, "No") },
    ],
    skip: [voided!.key],
  }).reply;
  expect(reply.body).toContain(`### Your message ${first.id}`);
  const parts = splitInboxReplyBody(reply.body);
  expect(parts.words).toBe("Thanks!");
  expect(parts.answers).toBe(true);
  expect(parts.rest).toBe("");
  expect(store.questionsOf(second.id).find((q) => q.key === voided!.key)?.sent_reply_id).toBe(reply.id);
});

test("answers alone: no words at all", () => {
  const { store, project } = open();
  const asked = store.sendMessage({ project_id: project.id, author: A, body: question("Ship it?") }).message;
  const [ship] = store.questionsOf(asked.id);
  const reply = store.sendReply(asked.id, { idempotency_key: "k3", questions: [{ key: ship!.key, revision: 0, answer: pick(ship!) }] }).reply;
  expect(splitInboxReplyBody(reply.body)).toEqual({ words: "", answers: true, rest: "", changed: true });
});

test("words only, questions still open: the still-open line comes out, the feedback after it stays", () => {
  const { store, project } = open();
  const asked = store.sendMessage({ project_id: project.id, author: A, body: question("Ship it?") }).message;
  const reply = store.sendReply(asked.id, { idempotency_key: "k4", words: "Give me a minute.", feedback: "## notes.md\n\n> Fine." }).reply;
  expect(reply.body).toContain("still open. Don't re-ask it");
  expect(splitInboxReplyBody(reply.body)).toEqual({ words: "Give me a minute.", answers: false, rest: "## notes.md\n\n> Fine.", changed: true });
});

test("text the store did not shape stays as it is", () => {
  expect(splitInboxReplyBody("Just words.\n\n## Answers to your questions\n\nnot the grammar")).toEqual({
    words: "Just words.\n\n## Answers to your questions\n\nnot the grammar",
    answers: false,
    rest: "",
    changed: false,
  });
  // A first line alone is the store's only when a blank line (or the end) follows it.
  expect(splitInboxReplyBody("Answered 2 questions.\nand then some").changed).toBe(false);
});
