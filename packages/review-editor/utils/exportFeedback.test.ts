import { describe, it, expect } from "bun:test";
import { exportReviewFeedback } from "./exportFeedback";
import type { CodeAnnotation } from "@plannotator/ui/types";
import type { PRMetadata } from "@plannotator/shared/pr-types";

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
  host: "github.com",
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

  it("local mode with diff context: describes mode + base in the header", () => {
    const result = exportReviewFeedback([ann()], undefined, {
      mode: "branch",
      base: "develop",
    });
    expect(result).toContain("**Diff:** Branch diff vs `develop`");
  });

  it("local mode with merge-base: labels committed changes with the base", () => {
    const result = exportReviewFeedback([ann()], undefined, {
      mode: "merge-base",
      base: "release/v2",
    });
    expect(result).toContain("**Diff:** Committed changes vs `release/v2`");
  });

  it("local mode with jj line of work: labels compare target in the header", () => {
    const result = exportReviewFeedback([ann()], undefined, {
      mode: "jj-line",
      base: "main",
    });
    expect(result).toContain("**Diff:** Line of work vs `main`");
  });

  it("local mode with worktree path: appends worktree info", () => {
    const result = exportReviewFeedback([ann()], undefined, {
      mode: "uncommitted",
      worktreePath: "/tmp/feature-wt",
    });
    expect(result).toContain("**Diff:** Uncommitted changes _(worktree: /tmp/feature-wt)_");
  });

  it("PR mode ignores diff context (PR header already carries branches)", () => {
    const result = exportReviewFeedback([ann()], prMeta, {
      mode: "branch",
      base: "develop",
    });
    // The PR-style branches line must appear.
    expect(result).toContain("Branch: `fix/widget` → `main`");
    // The local-mode Diff line must not.
    expect(result).not.toContain("**Diff:**");
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

  it("PR mode: includes stacked diff review scope when provided", () => {
    const result = exportReviewFeedback(
      [ann()],
      prMeta,
      undefined,
      "Full stack diff vs `main`",
    );

    expect(result).toContain("Review scope: Full stack diff vs `main`");
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

  it("multi-PR: annotation headings are one level deeper than file headings", () => {
    const result = exportReviewFeedback([
      ann({ prUrl: "https://github.com/acme/widgets/pull/1", prNumber: 1, prTitle: "PR 1", prRepo: "acme/widgets" }),
      ann({ prUrl: "https://github.com/acme/widgets/pull/2", prNumber: 2, prTitle: "PR 2", prRepo: "acme/widgets", filePath: "src/other.ts" }),
    ]);
    expect(result).toContain("### src/index.ts");
    expect(result).toContain("#### Line 10 (new)");
    expect(result).not.toMatch(/^### Line/m);
  });

  it("single-PR with mismatched prMeta uses annotation PR context", () => {
    const prMetaB: PRMetadata = { ...prMeta, number: 99, url: "https://github.com/acme/widgets/pull/99", title: "different PR" };
    const result = exportReviewFeedback([
      ann({ prUrl: "https://github.com/acme/widgets/pull/42", prNumber: 42, prTitle: "fix: broken widget", prRepo: "acme/widgets" }),
    ], prMetaB);
    expect(result).not.toContain("#99");
    expect(result).toContain("#42");
    expect(result).not.toContain("Multi-PR");
    expect(result).toContain("acme/widgets");
    expect(result).toContain("fix: broken widget");
  });

  it("multi-PR with diffScope: includes review scope line per PR group", () => {
    const result = exportReviewFeedback([
      ann({ prUrl: "https://github.com/acme/widgets/pull/1", prNumber: 1, prTitle: "PR 1", prRepo: "acme/widgets", diffScope: "layer" }),
      ann({ prUrl: "https://github.com/acme/widgets/pull/2", prNumber: 2, prTitle: "PR 2", prRepo: "acme/widgets", filePath: "src/other.ts", diffScope: "full-stack" }),
    ]);
    expect(result).toContain("Review scope: layer");
    expect(result).toContain("Review scope: full-stack");
  });

  it("multi-PR without diffScope: no review scope line", () => {
    const result = exportReviewFeedback([
      ann({ prUrl: "https://github.com/acme/widgets/pull/1", prNumber: 1, prTitle: "PR 1", prRepo: "acme/widgets" }),
      ann({ prUrl: "https://github.com/acme/widgets/pull/2", prNumber: 2, prTitle: "PR 2", prRepo: "acme/widgets", filePath: "src/other.ts" }),
    ]);
    expect(result).not.toContain("Review scope:");
  });

  it("non-stacked annotations have no diffScope in export", () => {
    const result = exportReviewFeedback([ann()], prMeta);
    expect(result).not.toContain("Review scope: layer");
    expect(result).not.toContain("Review scope: full-stack");
  });

  it("single-PR with uniform diffScope: derives scope from annotations, not prReviewScope param", () => {
    const result = exportReviewFeedback([
      ann({ diffScope: "layer" }),
      ann({ filePath: "src/other.ts", diffScope: "layer" }),
    ], prMeta);
    expect(result).toContain("Review scope: layer");
    expect(result).not.toContain("full-stack");
  });

  it("single-PR with mixed diffScope: groups annotations under scope headings", () => {
    const result = exportReviewFeedback([
      ann({ diffScope: "layer", text: "layer finding" }),
      ann({ filePath: "src/other.ts", diffScope: "full-stack", text: "full-stack finding" }),
    ], prMeta);
    // Should have separate scope sections, not comma-joined
    expect(result).not.toContain("layer, full-stack");
    // Each scope should be a heading
    expect(result).toContain("## Layer");
    expect(result).toContain("## Full-stack");
    // Annotations should be under their respective scopes
    const layerIdx = result.indexOf("## Layer");
    const fullStackIdx = result.indexOf("## Full-stack");
    const layerFindingIdx = result.indexOf("layer finding");
    const fullStackFindingIdx = result.indexOf("full-stack finding");
    expect(layerFindingIdx).toBeGreaterThan(layerIdx);
    expect(layerFindingIdx).toBeLessThan(fullStackIdx);
    expect(fullStackFindingIdx).toBeGreaterThan(fullStackIdx);
  });

  it("single-PR with one scope: no scope heading, just scope label in header", () => {
    const result = exportReviewFeedback([
      ann({ diffScope: "full-stack", text: "finding" }),
    ], prMeta);
    expect(result).toContain("Review scope: full-stack");
    // No scope sub-headings when all annotations share the same scope
    expect(result).not.toContain("## Full-stack");
    expect(result).not.toContain("## Layer");
  });

  it("prReviewScope param is ignored when annotations carry diffScope", () => {
    // Simulates Copy All bug: agent ran in layer, user switched to full-stack
    const result = exportReviewFeedback([
      ann({ diffScope: "layer", text: "agent finding" }),
    ], prMeta, undefined, "full-stack");
    // Should use annotation's diffScope, not the passed-in prReviewScope
    expect(result).toContain("Review scope: layer");
    expect(result).not.toContain("Review scope: full-stack");
  });
});
