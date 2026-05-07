import { describe, expect, test } from "bun:test";
import type { GitContext } from "@plannotator/shared/review-core";
import { resolveInitialDiffType } from "./vcs";

function context(overrides: Partial<GitContext>): GitContext {
  return {
    currentBranch: "feature",
    defaultBranch: "main",
    diffOptions: [
      { id: "uncommitted", label: "Uncommitted changes" },
      { id: "merge-base", label: "Committed changes" },
    ],
    worktrees: [],
    availableBranches: { local: [], remote: [] },
    vcsType: "git",
    ...overrides,
  };
}

describe("resolveInitialDiffType", () => {
  test("preserves configured Git diff modes when available", () => {
    expect(resolveInitialDiffType(context({}), "merge-base")).toBe("merge-base");
  });

  test("uses p4-default for P4 contexts", () => {
    expect(resolveInitialDiffType(context({ vcsType: "p4" }), "merge-base")).toBe("p4-default");
  });

  test("ignores saved Git defaults for jj contexts", () => {
    const jjContext = context({
      defaultBranch: "trunk()",
      diffOptions: [
        { id: "jj-current", label: "Current change" },
        { id: "jj-line", label: "Line of work" },
        { id: "jj-all", label: "All files" },
      ],
      vcsType: "jj",
    });

    expect(resolveInitialDiffType(jjContext, "all")).toBe("jj-current");
    expect(resolveInitialDiffType(jjContext, "merge-base")).toBe("jj-current");
    expect(resolveInitialDiffType(jjContext, "unstaged")).toBe("jj-current");
  });

  test("falls back to the first available option for unknown non-jj modes", () => {
    expect(resolveInitialDiffType(context({}), "jj-current")).toBe("uncommitted");
  });
});
