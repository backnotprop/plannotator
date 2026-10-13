/**
 * `by_reply` on a QuestionAnswer: the Inbox's Send skipped the question
 * because the person left it unanswered. The validator keeps it only beside
 * `skipped: true`, and the answers section says how to read such a skip.
 * And the prompt an Inbox answer carries: cut whole, and checked against
 * the question with the same cut (or an older client's plain one).
 */
import { expect, test } from "bun:test";
import { capQuestionPrompt, formatQuestionAnswersSection, parseQuestionAnswer, type QuestionExportItem } from "./question-block";
import { checkInboxAnswer, inboxSkipAnswer, parseInboxQuestionBlocks } from "./inbox-questions";

const BASE = { v: 1, key: "q-0123abcd", kind: "single", prompt: "Cards or a table?", selected: [] };

test("parseQuestionAnswer keeps by_reply only on a skip, and refuses a non-boolean", () => {
  expect(parseQuestionAnswer({ ...BASE, skipped: true, by_reply: true })).toMatchObject({ skipped: true, by_reply: true });
  expect(parseQuestionAnswer({ ...BASE, by_reply: true })?.by_reply).toBeUndefined();
  expect(parseQuestionAnswer({ ...BASE, skipped: true, by_reply: "yes" })).toBeNull();
});

test("the Inbox takes a long prompt cut whole, and the plain 400-unit cut an older client made", () => {
  // The 400th code unit of the prompt is the first half of an emoji.
  const prompt = `${"p".repeat(399)}😀 more words`;
  const [record] = parseInboxQuestionBlocks([":::question", prompt, "", "- [ ] Yes", "- [ ] No", ":::"].join("\n"));
  const answer = (cut: string) => ({ v: 1, key: record!.key, kind: "single", prompt: cut, selected: ["Yes"] });
  expect(checkInboxAnswer(record!, answer(capQuestionPrompt(prompt)), "q").ok).toBe(true);
  expect(checkInboxAnswer(record!, answer(prompt.slice(0, 400)), "q").ok).toBe(true);
  expect(checkInboxAnswer(record!, answer("another question"), "q").ok).toBe(false);
  // A skip the Inbox writes keeps the whole-character cut.
  expect(inboxSkipAnswer(record!, { byReply: true }).prompt).toBe("p".repeat(399));
});

test("the answers section names a reply's skips apart from a Skip the reviewer pressed", () => {
  const items: QuestionExportItem[] = [
    { key: "q-0123abcd", number: 1, prompt: "Cards or a table?", recommendedLabels: [], settled: false },
    { key: "q-4567cdef", number: 2, prompt: "Sort overdue first?", recommendedLabels: [], settled: false },
  ];
  const section = formatQuestionAnswersSection(items, [
    { ...BASE, kind: "single", skipped: true, by_reply: true },
    { ...BASE, key: "q-4567cdef", prompt: "Sort overdue first?", kind: "single", skipped: true },
  ] as never);
  expect(section).toContain("0 of 2 questions answered. 1 was not answered in this reply; treat it as skipped, and ask again if you still need it.");
  expect(section).toContain("### Q1. Cards or a table?\nSkipped (not answered in this reply)\n");
  expect(section).toContain("### Q2. Sort overdue first?\nSkipped\n");
});
