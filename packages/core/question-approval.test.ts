/**
 * `unansweredQuestions`: the questions a plan approval still waits on.
 *
 * What regresses if this fails: a plan gets approved while a question the
 * agent asked has no answer (or was only skipped), or an approval is refused
 * although every question was answered or settled with `[x]`.
 */
import { describe, expect, test } from "bun:test";
import { findQuestionBlocks, unansweredQuestions, unansweredQuestionsMessage, type QuestionAnswer } from "./question-block";

const plan = [
  "# Plan", //                                     1
  "",
  ":::question", //                                 3
  "Where should losing versions be kept?",
  "",
  "- [ ] Local",
  "- [ ] Remote",
  ":::",
  "",
  ":::question", //                                 10
  "Which database?",
  "",
  "- [x] Postgres",
  "- [ ] SQLite",
  ":::",
  "",
  ":::question-text", //                            17
  "Anything else?",
  ":::",
  "",
].join("\n");

const [where, database, anything] = findQuestionBlocks(plan).map((b) => b.question);

const answer = (key: string, prompt: string, fields: Partial<QuestionAnswer>): QuestionAnswer => ({
  v: 1,
  key,
  kind: "single",
  prompt,
  selected: [],
  ...fields,
});

describe("unansweredQuestions", () => {
  test("without answers every question the agent did not settle waits, in document order", () => {
    expect(unansweredQuestions(plan)).toEqual([
      { key: where.key, number: 1, line: 4, prompt: "Where should losing versions be kept?", status: "open" },
      { key: anything.key, number: 3, line: 18, prompt: "Anything else?", status: "open" },
    ]);
  });

  test("a pick and a written answer clear their questions; the settled one needs none", () => {
    expect(unansweredQuestions(plan, [
      answer(where.key, where.prompt, { selected: ["Remote"] }),
      answer(anything.key, anything.prompt, { kind: "text", text: "No." }),
    ])).toEqual([]);
  });

  test("a skipped question still waits, settled or not", () => {
    const waiting = unansweredQuestions(plan, [
      answer(where.key, where.prompt, { skipped: true }),
      answer(database.key, database.prompt, { skipped: true }),
      answer(anything.key, anything.prompt, { kind: "text", text: "No." }),
    ]);
    expect(waiting.map((q) => [q.number, q.status])).toEqual([[1, "skipped"], [2, "skipped"]]);
  });

  test("a note alone answers nothing, and malformed answers count as absent", () => {
    const waiting = unansweredQuestions(plan, [
      answer(where.key, where.prompt, { note: "Not sure yet" }),
      { key: anything.key, text: "No." },
      null,
    ]);
    expect(waiting.map((q) => q.number)).toEqual([1, 3]);
  });

  test("a plan without questions never waits", () => {
    expect(unansweredQuestions("# Plan\n\nStep one.\n", [])).toEqual([]);
  });

  test("the refusal names each waiting question and marks skipped ones", () => {
    expect(unansweredQuestionsMessage(unansweredQuestions(plan, [answer(where.key, where.prompt, { skipped: true })]))).toBe(
      "Answer every question before approving. Still waiting: Q1. Where should losing versions be kept? (skipped); Q3. Anything else?",
    );
  });
});
