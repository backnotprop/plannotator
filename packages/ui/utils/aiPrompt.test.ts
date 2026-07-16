import { describe, test, expect } from "bun:test";
import { buildReviewContextPreamble } from "./aiPrompt.ts";
import { buildDefaultPrompt } from "../hooks/useAIChat.ts";

describe("buildReviewContextPreamble", () => {
  const command =
    "Changeset: the code changes against the base branch 'main'.\nRun `git diff main..HEAD` to inspect the changes.";
  const pasted = "Code changes:\n\n```diff\ndiff --git a/foo.ts\n+x\n```";

  test("no context → empty string", () => {
    expect(buildReviewContextPreamble(undefined, { changed: true })).toBe("");
    expect(buildReviewContextPreamble("", { changed: true })).toBe("");
    expect(buildReviewContextPreamble("   ", { changed: false })).toBe("");
  });

  test("changed → full context (command)", () => {
    expect(buildReviewContextPreamble(command, { changed: true })).toBe(command);
  });

  test("changed → full context even when pasted (e.g. switched to full-stack mid-chat)", () => {
    expect(buildReviewContextPreamble(pasted, { changed: true })).toContain("```diff");
  });

  test("unchanged + pasted → short reminder, never re-pastes the diff", () => {
    const out = buildReviewContextPreamble(pasted, { changed: false });
    expect(out).not.toContain("```");
    expect(out).not.toContain("diff --git");
    expect(out.toLowerCase()).toContain("still reviewing");
  });

  test("unchanged + command → restates the (short) command", () => {
    // Command contexts are short and the agent benefits from the reminder of
    // exactly what to run, so they are restated rather than dropped.
    expect(buildReviewContextPreamble(command, { changed: false })).toContain(
      "git diff main..HEAD",
    );
  });
});

describe("buildDefaultPrompt with contextPreamble", () => {
  test("prepends the preamble before the question", () => {
    const out = buildDefaultPrompt({ prompt: "why is this async?", contextPreamble: "CTX" });
    expect(out.startsWith("CTX")).toBe(true);
    expect(out).toContain("why is this async?");
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("why is this async?"));
  });

  test("preamble leads the file/line note too", () => {
    const out = buildDefaultPrompt({
      prompt: "explain",
      contextPreamble: "CTX",
      filePath: "src/a.ts",
      lineStart: 3,
      lineEnd: 5,
      side: "new",
    });
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("Re: src/a.ts"));
  });

  test("preamble leads the viewing note", () => {
    const out = buildDefaultPrompt({
      prompt: "q",
      contextPreamble: "CTX",
      viewing: { scope: "file", filePath: "src/b.ts" },
    });
    expect(out.indexOf("CTX")).toBeLessThan(out.indexOf("currently viewing src/b.ts"));
  });

  test("no preamble → unchanged behavior", () => {
    expect(buildDefaultPrompt({ prompt: "hi" })).toBe("hi");
    expect(buildDefaultPrompt({ prompt: "hi", contextPreamble: "   " })).toBe("hi");
  });
});
