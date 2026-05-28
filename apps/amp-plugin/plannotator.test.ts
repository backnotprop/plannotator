import { describe, expect, test } from "bun:test";
import {
  extractTextFromThreadMessage,
  findFirstPositionalArg,
  formatAnnotationFeedback,
  isNoActionFeedback,
  parseAnnotateDecision,
  splitCommandArgs,
} from "./plannotator";

describe("Amp Plannotator plugin helpers", () => {
  test("extracts visible assistant text blocks", () => {
    const text = extractTextFromThreadMessage({
      role: "assistant",
      id: "m-1",
      content: [
        { type: "thinking", thinking: "hidden reasoning" },
        { type: "text", text: "First paragraph." },
        { type: "tool_use", id: "tool-1", name: "bash", input: {} },
        { type: "text", text: "Second paragraph." },
      ],
    });

    expect(text).toBe("First paragraph.\n\nSecond paragraph.");
  });

  test("parses structured annotate decisions", () => {
    expect(parseAnnotateDecision('{"decision":"approved"}')).toEqual({ decision: "approved" });
    expect(parseAnnotateDecision("")).toEqual({ decision: "dismissed" });
    expect(parseAnnotateDecision("plain feedback")).toBeNull();
  });

  test("wraps actionable annotation feedback for Amp thread append", () => {
    expect(
      formatAnnotationFeedback(
        { decision: "annotated", feedback: "Comment: tighten this section." },
        { kind: "message" },
      ),
    ).toBe(
      "# Message Annotations\n\nComment: tighten this section.\n\nPlease address the annotation feedback above.",
    );
  });

  test("wraps file annotation feedback with target path", () => {
    expect(
      formatAnnotationFeedback(
        { decision: "annotated", feedback: "Comment: tighten this section." },
        { kind: "file", filePath: "docs/plan.md" },
      ),
    ).toBe(
      "# Markdown Annotations\n\nFile: docs/plan.md\n\nComment: tighten this section.\n\nPlease address the annotation feedback above.",
    );
  });

  test("detects non-action outputs", () => {
    expect(isNoActionFeedback("Review session closed without feedback.")).toBe(true);
    expect(isNoActionFeedback("Code review completed — no changes requested.")).toBe(true);
    expect(isNoActionFeedback("Please fix this bug.")).toBe(false);
  });

  test("splits review target arguments without invoking a shell", () => {
    expect(splitCommandArgs("--git https://github.com/org/repo/pull/1")).toEqual([
      "--git",
      "https://github.com/org/repo/pull/1",
    ]);
    expect(splitCommandArgs('"https://example.com/a path"')).toEqual([
      "https://example.com/a path",
    ]);
  });

  test("finds annotate target after flags", () => {
    expect(findFirstPositionalArg(["--no-jina", "https://example.com"])).toBe("https://example.com");
    expect(findFirstPositionalArg(["--browser", "Google Chrome", "docs/plan.md"])).toBe("docs/plan.md");
  });
});
