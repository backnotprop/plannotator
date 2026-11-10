/**
 * Questions inside an attached Markdown file (issue #2828): the store keeps
 * each as a question of its message, after the body's, so it waits on the
 * person like one in the body, and the reply carries its answer under the
 * file's own heading, numbered as the file's cards.
 *
 * What regresses if this fails: a file's question is not counted or not
 * answerable, its key collides with a body question (one pick answering two
 * cards), or the agent cannot tell which file and which question an answer
 * is for.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseInboxQuestionBlocks, splitInboxReplyBody } from "@plannotator/core/inbox-questions";
import type { InboxAttachment, InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };

const PLAN = [
  "---",
  "title: Billing plan",
  "---",
  "# Billing plan",
  "",
  "## Storage",
  "",
  ":::question",
  "Which database should invoices live in?",
  "",
  "- [ ] Postgres",
  "- [ ] SQLite",
  "",
  "Recommended: Postgres",
  ":::",
  "",
  "## Retries",
  "",
  ":::question",
  "Ship the retry behind a flag?",
  "",
  "- [ ] Yes",
  "- [ ] No",
  ":::",
].join("\n");

/** The body asks one question the file also asks: the file's must take another key. */
const BODY = ["The plan is attached; two questions sit in it, beside their sections.", "", ":::question", "Ship the retry behind a flag?", "", "- [ ] Yes", "- [ ] No", ":::"].join("\n");

function attachment(id: string, name: string): InboxAttachment {
  return { id, path: `/work/billing/${name}`, named_path: null, name, kind: "markdown", sent_sha256: "0".repeat(64), size: PLAN.length, sent_at: "", sent_mtime: "2026-11-09T00:00:00.000Z" };
}

function setup(body = BODY) {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-file-questions-"));
  roots.push(dir);
  const store = InboxStore.open(dir);
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const plan = attachment("att_01JAAAAAAAAAAAAAAAAAAAAAAA", "plan.md");
  const sent = store.sendMessage({
    project_id: project.id,
    author: AGENT,
    body,
    attachments: [plan],
    attachment_questions: [{ attachment_id: plan.id, questions: parseInboxQuestionBlocks(PLAN, { frontmatter: true }) }],
  }).message;
  return { store, dir, project, plan, sent, questions: store.questionsOf(sent.id) };
}

const pick = (q: InboxQuestion, label: string): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [label] });

describe("questions inside an attached file", () => {
  test("each is a question of the message, after the body's, with its file and its key in the file; no key is shared", () => {
    const { questions, plan } = setup();
    expect(questions.map((q) => q.prompt)).toEqual(["Ship the retry behind a flag?", "Which database should invoices live in?", "Ship the retry behind a flag?"]);
    const [body, db, flag] = questions as [InboxQuestion, InboxQuestion, InboxQuestion];
    expect(body.attachment ?? null).toBeNull();
    expect(db.attachment).toEqual({ id: plan.id, name: "plan.md", key: db.key });
    // The file's flag question has the body's key in the file: the record takes the next free one.
    expect(flag.attachment!.key).toBe(body.key);
    expect(flag.key).toBe(`${body.key}-2`);
    expect(new Set(questions.map((q) => q.key)).size).toBe(3);
    // Numbered within the file (its cards are Q1 and Q2), with the prompt's line in the file (frontmatter counted).
    expect([db.position, flag.position]).toEqual([0, 1]);
    expect(db.state).toBe("open");
  });

  test("they wait on the person: the thread's row counts them with the body's", () => {
    const { store, sent } = setup();
    const row = store.listRows().find((r) => r.thread_id === sent.thread_id)!;
    expect(row.questions.open).toBe(3);
  });

  test("a file's question alone makes the thread wait, with no question in the body", () => {
    const { store, sent, questions } = setup("The plan is attached.");
    expect(questions.every((q) => q.attachment)).toBe(true);
    expect(store.listRows().find((r) => r.thread_id === sent.thread_id)!.questions.open).toBe(2);
  });

  test("the reply names the file and numbers its questions as the file's cards, at their lines in the file", () => {
    const { store, sent, questions } = setup();
    const [, db, flag] = questions as [InboxQuestion, InboxQuestion, InboxQuestion];
    store.savePicks(sent.id, [
      { key: db.key, revision: 0, answer: pick(db, "Postgres") },
      { key: flag.key, revision: 0, answer: pick(flag, "No") },
    ]);
    const reply = store.sendReply(sent.id, { idempotency_key: "r1", questions: [{ key: db.key, revision: 1 }, { key: flag.key, revision: 1 }] }).reply;
    const lines = reply.body.split("\n");
    expect(lines[0]).toBe("Answered 2 questions.");
    // The body's own question is still open, and the reply says so.
    expect(reply.body).toContain("You have 1 other question open in this thread.");
    const heading = lines.indexOf(`### Your file plan.md, attached to message ${sent.id}`);
    expect(heading).toBeGreaterThan(0);
    const section = lines.slice(heading).join("\n");
    expect(section).toContain("2 of 2 questions answered.");
    expect(section).toContain("#### Q1. Which database should invoices live in? (line 9)");
    expect(section).toContain("#### Q2. Ship the retry behind a flag? (line 20)");
    expect(section).toMatch(/#### Q1\. Which database[^\n]*\nAnswer: Postgres/);
    // The window can still tell the person's words from what the store wrote.
    expect(splitInboxReplyBody(reply.body)).toMatchObject({ answers: true, words: "", rest: "" });
    // Both are sent; the body's stays open.
    expect(store.questionsOf(sent.id).map((q) => q.state)).toEqual(["open", "sent", "sent"]);
  });

  test("answers on the body and on the file: one group each, the body's first", () => {
    const { store, sent, questions } = setup();
    const [body, db] = questions as [InboxQuestion, InboxQuestion];
    store.savePicks(sent.id, [
      { key: body.key, revision: 0, answer: pick(body, "Yes") },
      { key: db.key, revision: 0, answer: pick(db, "SQLite") },
    ]);
    const reply = store.sendReply(sent.id, { idempotency_key: "r2", questions: [{ key: body.key, revision: 1 }, { key: db.key, revision: 1 }] }).reply;
    const own = reply.body.indexOf(`### Your message ${sent.id}`);
    const file = reply.body.indexOf(`### Your file plan.md, attached to message ${sent.id}`);
    expect(own).toBeGreaterThan(0);
    expect(file).toBeGreaterThan(own);
    expect(reply.body.slice(own, file)).toContain("#### Q1. Ship the retry behind a flag?");
    expect(reply.body.slice(file)).toContain("#### Q1. Which database should invoices live in?");
    expect(splitInboxReplyBody(reply.body).answers).toBe(true);
  });

  test("the agent replaces a file's question like any other, by its id", () => {
    const { store, sent, questions } = setup();
    const db = questions[1]!;
    const next = store.sendMessage({
      project_id: sent.project_id,
      author: AGENT,
      body: [":::question", `Replaces: ${sent.id}/${db.key}`, "Which database, now that the queue moved?", "", "- [ ] Postgres", "- [ ] DynamoDB", ":::"].join("\n"),
      reply_to: sent.id,
    }).message;
    const replaced = store.questionsOf(sent.id)[1]!;
    expect(replaced.state).toBe("superseded");
    expect(replaced.superseded_by).toEqual({ message_id: next.id, key: next.questions![0]!.key });
  });

  test("a file the send does not attach asks nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-file-questions-"));
    roots.push(dir);
    const store = InboxStore.open(dir);
    const project = store.ensureProject({ name: "billing", root: "/work/billing" });
    const sent = store.sendMessage({
      project_id: project.id,
      author: AGENT,
      body: "No files.",
      attachment_questions: [{ attachment_id: "att_01JBBBBBBBBBBBBBBBBBBBBBBB", questions: parseInboxQuestionBlocks(PLAN, { frontmatter: true }) }],
    }).message;
    expect(store.questionsOf(sent.id)).toEqual([]);
  });

  test("the questions survive a reopen of the store", () => {
    const { dir, sent, questions } = setup();
    const again = InboxStore.open(dir);
    expect(again.questionsOf(sent.id)).toEqual(questions);
  });
});
