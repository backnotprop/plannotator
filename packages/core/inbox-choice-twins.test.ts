/**
 * Questions stored before the Inbox refused choices that read the same
 * (`inbox-choice-twins.ts`) still read their answers by the exact label:
 * a pick of "ship it." beside a recommended "Ship it" is kept as picked and
 * never called the recommendation.
 *
 * What regresses if this fails: the reply tells the agent the person took
 * its recommendation when they picked the other choice.
 */
import { expect, test } from "bun:test";
import { checkInboxAnswer, inboxAnswerTookRecommendation, parseInboxQuestionBlocks } from "./inbox-questions";

test("an older question whose choices read the same: each pick stays itself, only the recommended one is the recommendation", () => {
  const body = [":::question", "Ship it?", "", "- [ ] Ship it", "- [ ] ship it.", "", "Recommended: Ship it", ":::"].join("\n");
  const q = parseInboxQuestionBlocks(body)[0]!;
  const record = { key: q.key, kind: q.kind, prompt: q.prompt, parsed: q.parsed };
  expect(q.parsed.choices.map((c) => [c.label, c.recommended])).toEqual([["Ship it", true], ["ship it.", false]]);
  const took = q.parsed.choices.map((c) => {
    const checked = checkInboxAnswer(record, { v: 1, key: q.key, kind: q.kind, prompt: q.prompt, selected: [c.label] }, "answer");
    if (!checked.ok) throw new Error(JSON.stringify(checked.refusal));
    expect(checked.answer.selected).toEqual([c.label]);
    return inboxAnswerTookRecommendation(record, checked.answer);
  });
  expect(took).toEqual([true, false]);
});
