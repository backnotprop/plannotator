import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { QuestionAnswer } from "@plannotator/core/question-block";
import type { InboxAuthor, InboxQuestion } from "@plannotator/core/inbox-types";
import { InboxStore } from "./store";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const AGENT: Extract<InboxAuthor, { kind: "agent" }> = { kind: "agent", host: "claude-code", session: "ses_a", name: null };
const question = (prompt: string, choices: string[]) => [":::question", prompt, "", ...choices.map((c) => `- [ ] ${c}`), ":::"].join("\n");
const BODY = [question("Which layout?", ["Cards", "Table"]), "", question("Sort overdue first?", ["Yes", "No"])].join("\n");

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "plannotator-inbox-skip-note-"));
  roots.push(dir);
  const store = InboxStore.open(dir, { now: () => new Date("2026-10-13T10:00:00.000Z") });
  const project = store.ensureProject({ name: "billing", root: "/work/billing" });
  const asked = store.sendMessage({ project_id: project.id, author: AGENT, body: BODY }).message;
  const [first, second] = store.questionsOf(asked.id) as InboxQuestion[];
  return { store, asked, first: first!, second: second! };
}

const answer = (q: InboxQuestion, extra: Partial<QuestionAnswer>): QuestionAnswer => ({ v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [], ...extra });

describe("a note on a question card rides the Send", () => {
  test("Skip plus a note, and Skip them: the reply says Skipped and gives the note; the other question is skipped by the reply", () => {
    const { store, asked, first, second } = setup();
    const [saved] = store.savePicks(asked.id, [{ key: first.key, revision: 0, answer: answer(first, { skipped: true, note: "Ask me after the design review" }) }]);
    const result = store.sendReply(asked.id, { idempotency_key: "k-1", questions: [{ key: first.key, revision: saved!.revision }], skip: [second.key] });
    expect(result.reply.body).toContain("### Q1. Which layout? (line 2)\nSkipped\nNote: Ask me after the design review\n");
    expect(result.reply.body).toContain("### Q2. Sort overdue first? (line 9)\nSkipped by the person");
    expect(result.questions.map((q) => [q.state, q.answer?.note ?? null])).toEqual([
      ["sent", "Ask me after the design review"],
      ["sent", null],
    ]);
    expect(store.pendingReplies("ses_a").map((m) => m.body)).toEqual([result.reply.body]);
  });

  test("a note alone with Skip them: the note goes, the other question is skipped by the reply", () => {
    const { store, asked, first, second } = setup();
    const [saved] = store.savePicks(asked.id, [{ key: first.key, revision: 0, answer: answer(first, { note: "Leaning to cards" }) }]);
    const result = store.sendReply(asked.id, { idempotency_key: "k-1", questions: [{ key: first.key, revision: saved!.revision }], skip: [first.key, second.key] });
    expect(result.reply.body).toContain("### Q1. Which layout? (line 2)\nNote: Leaning to cards");
    expect(result.questions.map((q) => q.state)).toEqual(["sent", "sent"]);
  });

  test("a note alone, the default (Keep open): the note goes, the other question stays open", () => {
    const { store, asked, first } = setup();
    const [saved] = store.savePicks(asked.id, [{ key: first.key, revision: 0, answer: answer(first, { note: "Leaning to cards" }) }]);
    const result = store.sendReply(asked.id, { idempotency_key: "k-1", questions: [{ key: first.key, revision: saved!.revision }] });
    expect(result.reply.body).toContain("Note: Leaning to cards");
    expect(result.reply.body).toContain("You have 1 other question open in this thread. It stays open; the person will answer it in the Inbox. Don't re-ask it.");
    expect(result.questions.map((q) => q.state)).toEqual(["sent", "open"]);
  });
});
