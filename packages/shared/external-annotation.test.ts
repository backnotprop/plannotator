/**
 * Scope-aware review annotation validation: line requires a file and line,
 * file requires a file, general requires neither — so a general (review-level)
 * finding submits cleanly while a broken line finding is still rejected.
 */
import { describe, expect, test } from "bun:test";
import { transformReviewInput } from "./external-annotation";

function ok(body: unknown) {
  const r = transformReviewInput(body);
  if ("error" in r) throw new Error(`expected ok, got error: ${r.error}`);
  return r.annotations;
}

describe("transformReviewInput — scope-aware location requirements", () => {
  test("general: accepted with no filePath and no line", () => {
    const [a] = ok({ source: "claude", scope: "general", text: "overall approach is off" });
    expect(a.scope).toBe("general");
    expect(a.filePath).toBe("");
    expect(a.lineStart).toBe(0);
    expect(a.lineEnd).toBe(0);
  });

  test("file: requires filePath, line optional and defaults to 0", () => {
    const [a] = ok({ source: "claude", scope: "file", filePath: "src/a.ts", text: "whole file" });
    expect(a.scope).toBe("file");
    expect(a.filePath).toBe("src/a.ts");
    expect(a.lineStart).toBe(0);

    const missingFile = transformReviewInput({ source: "claude", scope: "file", text: "x" });
    expect("error" in missingFile && missingFile.error).toContain("filePath");
  });

  test("line: still strictly requires filePath, lineStart, lineEnd", () => {
    const [a] = ok({ source: "claude", scope: "line", filePath: "src/a.ts", lineStart: 3, lineEnd: 5, text: "x" });
    expect(a.scope).toBe("line");
    expect(a.lineStart).toBe(3);

    const noLine = transformReviewInput({ source: "claude", scope: "line", filePath: "src/a.ts", text: "x" });
    expect("error" in noLine && noLine.error).toContain("lineStart");
  });

  test("default scope is line and keeps the strict line rule", () => {
    const noLine = transformReviewInput({ source: "claude", filePath: "src/a.ts", text: "x" });
    expect("error" in noLine && noLine.error).toContain("lineStart");
  });

  test("an unknown scope is rejected", () => {
    const r = transformReviewInput({ source: "claude", scope: "review", text: "x" });
    expect("error" in r && r.error).toContain("invalid scope");
  });
});
