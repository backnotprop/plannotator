import { describe, expect, test } from "bun:test";
import { parseInboxQuestionBlocks } from "@plannotator/core/inbox-questions";
import { QUESTION_OPENERS_WITH_TEXT_MAX, questionOpenersWithText, questionOpenersWithTextText } from "./question-openers";

describe("questionOpenersWithText", () => {
  test("an opener with text after its name is named by its line and the directive as written, and opens no question", () => {
    const body = [
      "Two calls to make.",
      "",
      ":::question {#bar}",
      "Which bar?",
      "- [ ] Top",
      "- [ ] Bottom",
      ":::",
      "",
      ":::question-multi foo",
      "Which checks?",
      "- [ ] Lint",
      ":::",
      "",
      ":::Question-Text{#why}",
      "Why?",
      ":::",
    ].join("\n");
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

  test("a stray ``` inside an HTML block or a directive's body hides nothing after it, as the parser reads it", () => {
    const afterHtml = ["<div>", "```", "</div>", "", ":::question {#x}", "Which?", ":::"].join("\n");
    expect(parseInboxQuestionBlocks(afterHtml)).toEqual([]);
    expect(questionOpenersWithText(afterHtml)).toEqual([{ line: 5, directive: ":::question" }]);
    const afterNote = [":::note", "```", ":::", ":::question {#x}", "Which?", ":::"].join("\n");
    expect(parseInboxQuestionBlocks(afterNote)).toEqual([]);
    expect(questionOpenersWithText(afterNote)).toEqual([{ line: 4, directive: ":::question" }]);
  });

  test("an opener with text inside another directive's body, an HTML block or display math is not named (alone on its line it would open nothing there either)", () => {
    const body = [
      ":::note",
      ":::question {#in-note}",
      ":::",
      "",
      "<div>",
      ":::question-multi in html",
      "</div>",
      "",
      "$$",
      ":::question-text in math",
      "$$",
    ].join("\n");
    expect(questionOpenersWithText(body)).toEqual([]);
  });

  test("past the cap, the first openers are named and the rest counted on a line of its own", () => {
    const openers = Array.from({ length: QUESTION_OPENERS_WITH_TEXT_MAX + 2 }, (_, i) => ({ line: i * 4 + 1, directive: ":::question" }));
    const text = questionOpenersWithTextText(openers);
    const lines = text.split("\n").slice(1);
    expect(lines).toHaveLength(QUESTION_OPENERS_WITH_TEXT_MAX + 1);
    expect(lines.filter((line) => line.endsWith("send the question again."))).toHaveLength(QUESTION_OPENERS_WITH_TEXT_MAX);
    expect(lines.at(-1)).toBe("And 2 more lines like these.");
    expect(questionOpenersWithTextText(openers.slice(0, QUESTION_OPENERS_WITH_TEXT_MAX), 1).split("\n").at(-1)).toBe("And 1 more line like this.");
  });
});
