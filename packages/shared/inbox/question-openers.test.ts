/**
 * send_message's warning about a question block that never opened (the
 * owner, 2026-11-02: an agent wrote `:::question {#bar}`, the person saw a
 * question they could not answer, and the result said only `questions: []`).
 * The failures this guards: the warning goes missing for an opener with text
 * after its name, names the wrong line or directive, or nags a correct block,
 * another directive name, or an example inside a code fence.
 */
import { describe, expect, test } from "bun:test";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { questionOpenersWithText, questionOpenersWithTextText } from "./question-openers";

describe("questionOpenersWithText", () => {
  test("an opener with text after its name is named by its line and the directive as written, and opens no question", () => {
    const body = [
      "Two calls to make.", // 1
      "", // 2
      ":::question {#bar}", // 3
      "Which bar?", // 4
      "- [ ] Top", // 5
      "- [ ] Bottom", // 6
      ":::", // 7
      "", // 8
      ":::question-multi foo", // 9
      "Which checks?", // 10
      "- [ ] Lint", // 11
      ":::", // 12
      "", // 13
      ":::Question-Text{#why}", // 14
      "Why?", // 15
      ":::", // 16
    ].join("\n");
    // The parser opened none of them: this is the mistake, not a reading of it.
    expect(parseInboxQuestionBlocks(body)).toEqual([]);
    expect(questionOpenersWithText(body)).toEqual([
      { line: 3, directive: ":::question" },
      { line: 9, directive: ":::question-multi" },
      { line: 14, directive: ":::Question-Text" },
    ]);
  });

  test("the warning is the owner's text, one line per opener", () => {
    expect(questionOpenersWithTextText([{ line: 3, directive: ":::question" }, { line: 9, directive: ":::question-multi" }])).toBe(
      "\nLine 3 starts with `:::question` but has text after it, so the person sees it as plain text and can't answer it. Put `:::question` alone on its line and send the question again." +
        "\nLine 9 starts with `:::question-multi` but has text after it, so the person sees it as plain text and can't answer it. Put `:::question-multi` alone on its line and send the question again.",
    );
    expect(questionOpenersWithTextText([])).toBe("");
  });

  test("no warning for correct blocks, other directive names, or an example in a code fence", () => {
    const body = [
      ":::question",
      "Which bar?",
      "- [ ] Top",
      ":::",
      "  :::question-multi  ",
      "Which checks?",
      "- [ ] Lint",
      ":::",
      ":::questions {#x}",
      ":::question-other foo",
      "> :::question {#quoted}",
      "Write it like this, not `:::question {#x}`:",
      "```markdown",
      ":::question {#example}",
      "```",
      "````",
      "```",
      ":::question-text nested example",
      "````",
    ].join("\n");
    expect(parseInboxQuestionBlocks(body)).toHaveLength(2);
    expect(questionOpenersWithText(body)).toEqual([]);
    expect(questionOpenersWithText("No blocks here.")).toEqual([]);
  });

  test("after a code fence closes, an opener with text is named again, by its line in the body", () => {
    const body = ["```", ":::question {#example}", "```", ":::question {#real}", "Which?", ":::"].join("\r\n");
    expect(questionOpenersWithText(body)).toEqual([{ line: 4, directive: ":::question" }]);
  });
});
