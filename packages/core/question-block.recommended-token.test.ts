/**
 * A `Recommended:` line that is only a choice label's leading letter or
 * number (`Recommended: A` for `- [ ] A · Yes`) names that choice when the
 * token is followed by ` · ` and exactly one choice has it.
 *
 * What regresses if this fails: the card draws the bare token as a stray
 * extra option (the agent's own answer, `suggestedText`) and marks no choice,
 * or a token shared by two choices picks one of them.
 */
import { describe, expect, test } from "bun:test";
import { parseQuestionBlock, type ParsedQuestion } from "./question-block";

const block = (choices: string[], line: string) =>
  ["Ship the change?", "", ...choices, "", line].join("\n");

const recommendedOf = (q: ParsedQuestion) => q.choices.filter((c) => c.recommended).map((c) => c.label);

describe("a Recommended: line names a choice by its leading token and a middle dot", () => {
  for (const kind of ["question", "question-multi"] as const) {
    describe(kind, () => {
      test("`A` names `A · Yes`", () => {
        const q = parseQuestionBlock(kind, block(["- [ ] A · Yes", "- [ ] B · Change it (say how)"], "Recommended: A"))!;
        expect(recommendedOf(q)).toEqual(["A · Yes"]);
        expect(q.suggestedText).toBeUndefined();
      });

      test("`2` names `2 · Later`", () => {
        const q = parseQuestionBlock(kind, block(["- [ ] 1 · Now", "- [ ] 2 · Later"], "Recommended: 2"))!;
        expect(recommendedOf(q)).toEqual(["2 · Later"]);
        expect(q.suggestedText).toBeUndefined();
      });

      test("two labels starting `A ·`: neither is named, the line stays a suggested answer", () => {
        const q = parseQuestionBlock(kind, block(["- [ ] A · Yes", "- [ ] A · Yes, later"], "Recommended: A"))!;
        expect(recommendedOf(q)).toEqual([]);
        expect(q.suggestedText).toBe("A");
      });

      test("`Apple` does not name `A · Yes`", () => {
        const q = parseQuestionBlock(kind, block(["- [ ] A · Yes", "- [ ] B · No"], "Recommended: Apple"))!;
        expect(recommendedOf(q)).toEqual([]);
        expect(q.suggestedText).toBe("Apple");
      });

      test("the full label still names it", () => {
        const q = parseQuestionBlock(kind, block(["- [ ] A · Yes", "- [ ] B · No"], "Recommended: B · No"))!;
        expect(recommendedOf(q)).toEqual(["B · No"]);
        expect(q.suggestedText).toBeUndefined();
      });

      test("a word followed by ` · ` is not a token: `Fast` stays a suggested answer for `Fast · cheap`", () => {
        const q = parseQuestionBlock(kind, block(["- [ ] Fast · cheap", "- [ ] Slow · safe"], "Recommended: Fast"))!;
        expect(recommendedOf(q)).toEqual([]);
        expect(q.suggestedText).toBe("Fast");
      });

      // Written without spaces: a spaced ` — ` splits the label from its description.
      for (const [sep, written, label] of [
        [":", "Unpin it: the toast says so", "Unpin it: the toast says so"],
        ["—", "Unpin it—the toast says so", "Unpin it—the toast says so"],
        ["(", "Unpin it (the toast says so)", "Unpin it (the toast says so)"],
      ] as const) {
        test(`the \`${sep}\` prefix rule is unchanged`, () => {
          const q = parseQuestionBlock(kind, block([`- [ ] ${written}`, "- [ ] Keep it"], "Recommended: Unpin it"))!;
          expect(recommendedOf(q)).toEqual([label]);
          expect(q.suggestedText).toBeUndefined();
        });
      }
    });
  }
});
