import { describe, expect, test } from "bun:test";
import { resolveReviewScopedAgentCwd } from "./review";

describe("resolveReviewScopedAgentCwd", () => {
  test("uses the current PR pool checkout in PR mode", () => {
    const worktreePool = {
      resolve: (url: string) => url === "https://example.com/pr/2" ? "/tmp/pr-2" : undefined,
    };

    expect(resolveReviewScopedAgentCwd({
      isPRMode: true,
      prUrl: "https://example.com/pr/2",
      worktreePool,
      agentCwd: "/tmp/original-pr",
      currentDiffType: "uncommitted",
      gitContextCwd: "/repo",
    })).toBe("/tmp/pr-2");
  });

  test("falls back to the mutable local PR checkout when the pool has no entry", () => {
    const worktreePool = {
      resolve: () => undefined,
    };

    expect(resolveReviewScopedAgentCwd({
      isPRMode: true,
      prUrl: "https://example.com/pr/other-repo",
      worktreePool,
      agentCwd: "/tmp/original-pr",
      currentDiffType: "uncommitted",
      gitContextCwd: "/repo",
    })).toBe("/tmp/original-pr");
  });

  test("does not invent local access for PR pool misses without an agent cwd", () => {
    const worktreePool = {
      resolve: () => undefined,
    };

    expect(resolveReviewScopedAgentCwd({
      isPRMode: true,
      prUrl: "https://example.com/pr/other-repo",
      worktreePool,
      currentDiffType: "uncommitted",
      gitContextCwd: "/repo",
    })).toBeUndefined();
  });

  test("keeps non-PR local review fallback behavior", () => {
    expect(resolveReviewScopedAgentCwd({
      isPRMode: false,
      agentCwd: "/tmp/local-review",
      currentDiffType: "uncommitted",
      gitContextCwd: "/repo",
    })).toBe("/tmp/local-review");

    expect(resolveReviewScopedAgentCwd({
      isPRMode: false,
      currentDiffType: "uncommitted",
      gitContextCwd: "/repo",
    })).toBe("/repo");
  });
});
