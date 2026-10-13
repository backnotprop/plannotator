import { describe, expect, test } from "bun:test";
import { findQuestionBlocks, parseQuestionBlock, questionKey } from "./question-block";

const BODY = (decisionLine: string | null, where: "under" | "end" = "under") => {
  const lines = ["Where should losing conflict versions be kept?", ""];
  if (decisionLine && where === "under") lines.push(decisionLine, "");
  lines.push(
    "Last-write-wins silently drops the loser unless we keep it somewhere.",
    "",
    "- [ ] Local only — cheap",
    "- [ ] Server-side per user",
    "",
    "Recommended: Local only",
  );
  if (decisionLine && where === "end") lines.push("", decisionLine);
  return lines.join("\n");
};

describe("Decision: when answered", () => {
  test("flags the question and stays out of the context", () => {
    const q = parseQuestionBlock("question", BODY("Decision: when answered"))!;
    expect(q.decisionOnAnswer).toBe(true);
    expect(q.context).not.toContain("when answered");
    expect(q.context).toContain("Last-write-wins");
  });

  test("is accepted anywhere after the prompt, case-insensitive, with a trailing period", () => {
    for (const line of ["decision: When Answered.", "DECISION:   when answered"]) {
      const q = parseQuestionBlock("question", BODY(line, "end"))!;
      expect(q.decisionOnAnswer).toBe(true);
      expect(q.context).not.toMatch(/when answered/i);
    }
  });

  test("adding or removing the flag never changes the key", () => {
    const plain = parseQuestionBlock("question", BODY(null))!;
    const flagged = parseQuestionBlock("question", BODY("Decision: when answered"))!;
    expect(flagged.key).toBe(plain.key);
    expect(plain.decisionOnAnswer).toBeUndefined();
  });

  test("a Decision line before the prompt is the prompt", () => {
    const q = parseQuestionBlock("question", `Decision: when answered\n\nWhich store?\n\n- [ ] A\n- [ ] B`)!;
    expect(q.prompt).toBe("Decision: when answered");
    expect(q.decisionOnAnswer).toBeUndefined();
    expect(q.context).toContain("Which store?");
  });

  test("only the first flag line is read; a repeat stays prose", () => {
    const q = parseQuestionBlock("question", BODY("Decision: when answered") + "\n\nDecision: when answered")!;
    expect(q.decisionOnAnswer).toBe(true);
    expect(q.context).toContain("Decision: when answered");
  });

  test("other Decision values stay context prose", () => {
    for (const line of [
      "Decision: pending",
      "Decision: [Keep it](javascript:alert(1))",
      "Decision: [Keep it](/relative)",
      "Decision: see [this](https://x.test) and more",
    ]) {
      const q = parseQuestionBlock("question", BODY(line))!;
      expect(q.decisionOnAnswer).toBeUndefined();
      expect(q.decision).toBeUndefined();
      expect(q.context).toContain(line);
    }
  });

  test("an indented Decision line under a choice continues that choice", () => {
    const q = parseQuestionBlock("question", "Which?\n\n- [ ] A\n  Decision: when answered\n- [ ] B")!;
    expect(q.decisionOnAnswer).toBeUndefined();
    expect(q.choices[0].description).toBe("Decision: when answered");
  });
});

describe("Decision: [statement](url)", () => {
  const LINK = "Decision: [Keep losing versions locally for 30 days](https://ws.example/w/1/decisions/dec_1)";

  test("parses the link and keeps it out of the context and the key", () => {
    const q = parseQuestionBlock("question", BODY(LINK, "end"))!;
    expect(q.decision).toEqual({
      statement: "Keep losing versions locally for 30 days",
      url: "https://ws.example/w/1/decisions/dec_1",
    });
    expect(q.context).not.toContain("Decision:");
    expect(q.key).toBe(parseQuestionBlock("question", BODY(null))!.key);
  });

  test("the link wins over the flag, in either order", () => {
    for (const body of [
      BODY("Decision: when answered") + `\n\n${LINK}`,
      BODY(LINK) + "\n\nDecision: when answered",
    ]) {
      const q = parseQuestionBlock("question", body)!;
      expect(q.decision?.url).toBe("https://ws.example/w/1/decisions/dec_1");
      expect(q.decisionOnAnswer).toBeUndefined();
      expect(q.context).not.toContain("Decision:");
    }
  });
});

describe("findQuestionBlocks", () => {
  const DOC = [
    "# Plan", //                                   1
    "",
    ":::question", //                              3
    "Where should losing versions be kept?",
    "",
    "- [ ] Local",
    "- [ ] Server",
    ":::", //                                      8
    "",
    "```markdown", //                              10
    ":::question",
    "Not a question, it is in a fence?",
    ":::",
    "```",
    "",
    ":::question-text", //                         16
    "Where should losing versions be kept?",
    ":::", //                                      18
    "",
    ":::question", //                              20
    "Where should losing versions be kept?",
    "",
    "- [ ] Local",
    ":::", //                                      24
  ].join("\n");

  test("locates each block by its opening and closing lines with its exact text", () => {
    const found = findQuestionBlocks(DOC);
    expect(found.map((b) => [b.directiveKind, b.startLine, b.endLine])).toEqual([
      ["question", 3, 8],
      ["question-text", 16, 18],
      ["question", 20, 24],
    ]);
    expect(found[0].text).toBe(DOC.split("\n").slice(2, 8).join("\n"));
  });

  test("repeated prompts get the same -2 suffix the UI index gives them", () => {
    const [first, text, third] = findQuestionBlocks(DOC);
    const base = questionKey("single", "Where should losing versions be kept?");
    expect(first.key).toBe(base);
    expect(text.key).toBe(questionKey("text", "Where should losing versions be kept?"));
    expect(third.key).toBe(`${base}-2`);
  });

  test("an unclosed block runs to the last line", () => {
    const found = findQuestionBlocks("intro\n\n:::question\nWhich?\n\n- [ ] A\n");
    expect(found).toHaveLength(1);
    expect(found[0].startLine).toBe(3);
    expect(found[0].endLine).toBe(7);
    expect(found[0].text).toBe(":::question\nWhich?\n\n- [ ] A\n");
  });

  test("lines count from the top of the file when frontmatter is stripped", () => {
    const found = findQuestionBlocks("---\ntitle: x\n---\n\n:::question\nWhich?\n:::\n");
    expect(found[0].startLine).toBe(5);
    expect(found[0].text).toBe(":::question\nWhich?\n:::");
  });
});
