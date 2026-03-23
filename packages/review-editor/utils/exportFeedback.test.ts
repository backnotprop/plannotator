import { describe, it, expect } from "bun:test";
import { exportReviewFeedback } from "./exportFeedback";
import type { CodeAnnotation } from "@plannotator/ui/types";
import type { PRMetadata } from "@plannotator/shared/pr-provider";

const ann = (overrides: Partial<CodeAnnotation> = {}): CodeAnnotation => ({
  id: "1",
  type: "comment",
  filePath: "src/index.ts",
  lineStart: 10,
  lineEnd: 10,
  side: "new",
  text: "This looks wrong",
  createdAt: Date.now(),
  ...overrides,
});

const prMeta: PRMetadata = {
  platform: "github",
  owner: "acme",
  repo: "widgets",
  number: 42,
  title: "fix: broken widget",
  author: "alice",
  baseBranch: "main",
  headBranch: "fix/widget",
  baseSha: "abc123",
  headSha: "def456",
  url: "https://github.com/acme/widgets/pull/42",
};

describe("exportReviewFeedback", () => {
  it("local mode: uses generic header, no PR content", () => {
    const result = exportReviewFeedback([ann()]);
    expect(result).toStartWith("# Code Review Feedback\n\n");
    // Must not leak any PR-specific content
    expect(result).not.toContain("PR Review");
    expect(result).not.toContain("github.com");
    expect(result).not.toContain("Branch:");
    expect(result).not.toContain("acme");
  });

  it("local mode with null prMetadata: same as no prMetadata", () => {
    const result = exportReviewFeedback([ann()], null);
    expect(result).toStartWith("# Code Review Feedback\n\n");
    expect(result).not.toContain("PR Review");
  });

  it("local mode with undefined prMetadata: same as no prMetadata", () => {
    const result = exportReviewFeedback([ann()], undefined);
    expect(result).toStartWith("# Code Review Feedback\n\n");
    expect(result).not.toContain("PR Review");
  });

  it("PR mode: includes all PR context fields", () => {
    const result = exportReviewFeedback([ann()], prMeta);
    expect(result).toStartWith("# PR Review: acme/widgets#42\n\n");
    expect(result).toContain("**fix: broken widget**");
    expect(result).toContain("Branch: `fix/widget` → `main`");
    expect(result).toContain("https://github.com/acme/widgets/pull/42");
    // Must not contain the generic local header
    expect(result).not.toContain("# Code Review Feedback");
  });

  it("PR mode: annotations still render after PR header", () => {
    const result = exportReviewFeedback([ann({ text: "needs fix" })], prMeta);
    // PR header comes first, then file/line annotations
    const headerIdx = result.indexOf("PR Review:");
    const annotationIdx = result.indexOf("needs fix");
    expect(headerIdx).toBeLessThan(annotationIdx);
    expect(result).toContain("## src/index.ts");
    expect(result).toContain("### Line 10 (new)");
  });

  it("no annotations: returns generic empty regardless of prMetadata", () => {
    expect(exportReviewFeedback([], prMeta)).toBe("# Code Review\n\nNo feedback provided.");
    expect(exportReviewFeedback([], null)).toBe("# Code Review\n\nNo feedback provided.");
    expect(exportReviewFeedback([])).toBe("# Code Review\n\nNo feedback provided.");
  });

  it("groups annotations by file", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "a.ts", lineStart: 5, lineEnd: 5, text: "first" }),
      ann({ filePath: "b.ts", lineStart: 1, lineEnd: 1, text: "second" }),
    ]);
    expect(result).toContain("## a.ts");
    expect(result).toContain("## b.ts");
  });

  it("sorts annotations by line number within a file", () => {
    const result = exportReviewFeedback([
      ann({ lineStart: 20, lineEnd: 20, text: "later" }),
      ann({ lineStart: 5, lineEnd: 5, text: "earlier" }),
    ]);
    const earlierIdx = result.indexOf("earlier");
    const laterIdx = result.indexOf("later");
    expect(earlierIdx).toBeLessThan(laterIdx);
  });

  it("puts file-scoped annotations before line annotations", () => {
    const result = exportReviewFeedback([
      ann({ lineStart: 1, lineEnd: 1, text: "line comment" }),
      ann({ scope: "file", text: "file comment" }),
    ]);
    const fileIdx = result.indexOf("File Comment");
    const lineIdx = result.indexOf("Line 1");
    expect(fileIdx).toBeLessThan(lineIdx);
  });

  it("renders line ranges", () => {
    const result = exportReviewFeedback([
      ann({ lineStart: 10, lineEnd: 15 }),
    ]);
    expect(result).toContain("### Lines 10-15 (new)");
  });

  it("renders single lines", () => {
    const result = exportReviewFeedback([
      ann({ lineStart: 7, lineEnd: 7 }),
    ]);
    expect(result).toContain("### Line 7 (new)");
  });

  it("renders suggested code", () => {
    const result = exportReviewFeedback([
      ann({ suggestedCode: "const x = 1;" }),
    ]);
    expect(result).toContain("**Suggested code:**");
    expect(result).toContain("const x = 1;");
  });

  it("includes side indicator", () => {
    const result = exportReviewFeedback([
      ann({ side: "old", lineStart: 3, lineEnd: 3 }),
    ]);
    expect(result).toContain("### Line 3 (old)");
  });

  it("contains exactly one top-level heading so integrations can use the output directly", () => {
    const result = exportReviewFeedback([ann()]);
    const headingMatches = result.match(/^# /gm) || [];
    expect(headingMatches).toHaveLength(1);
  });

  it("contains exactly one top-level heading in PR mode", () => {
    const result = exportReviewFeedback([ann()], prMeta);
    const headingMatches = result.match(/^# /gm) || [];
    expect(headingMatches).toHaveLength(1);
  });
});
