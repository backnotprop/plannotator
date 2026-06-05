import { describe, it, expect } from "bun:test";
import { exportReviewFeedback } from "./exportFeedback";
import type { CodeAnnotation } from "@plannotator/ui/types";

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

describe("exportReviewFeedback - workspace mode", () => {
  it("workspace mode: uses generic header, no PR content (same as local mode)", () => {
    // In workspace mode, prMetadata is explicitly undefined even if workspace exists
    const result = exportReviewFeedback([ann()], undefined);
    expect(result).toStartWith("# Code Review Feedback\n\n");
    expect(result).not.toContain("PR Review");
    expect(result).not.toContain("github.com");
    expect(result).not.toContain("Branch:");
  });

  it("groups annotations by repo-prefixed file paths", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "repo-a/src/index.ts", lineStart: 5, text: "first" }),
      ann({ filePath: "repo-b/src/index.ts", lineStart: 1, text: "second" }),
    ]);
    // Different repos with same relative path should be separate groups
    expect(result).toContain("## repo-a/src/index.ts");
    expect(result).toContain("## repo-b/src/index.ts");
  });

  it("sorts annotations by line number within each repo-prefixed file", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "repo-a/src/index.ts", lineStart: 20, text: "later" }),
      ann({ filePath: "repo-a/src/index.ts", lineStart: 5, text: "earlier" }),
      ann({ filePath: "repo-b/src/index.ts", lineStart: 15, text: "middle in repo-b" }),
    ]);
    const earlierIdx = result.indexOf("earlier");
    const laterIdx = result.indexOf("later");
    const middleInRepoB = result.indexOf("middle in repo-b");
    expect(earlierIdx).toBeLessThan(laterIdx);
    // Both repo-a annotations should come before repo-b (alphabetical by path)
    expect(laterIdx).toBeLessThan(middleInRepoB);
  });

  it("handles nested repo labels with overlapping paths", () => {
    // Tests the longest-prefix matching behavior from resolveWorkspaceFilePath
    const result = exportReviewFeedback([
      ann({ filePath: "apps/api/src/server.ts", text: "in nested repo" }),
      ann({ filePath: "apps/web/src/app.ts", text: "in sibling repo" }),
      ann({ filePath: "apps/src/main.ts", text: "in parent repo" }),
    ]);
    expect(result).toContain("## apps/api/src/server.ts");
    expect(result).toContain("## apps/web/src/app.ts");
    expect(result).toContain("## apps/src/main.ts");
  });

  it("handles deeply nested repo labels", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "packages/shared/utils/helpers/string.ts", text: "deep path" }),
    ]);
    expect(result).toContain("## packages/shared/utils/helpers/string.ts");
    expect(result).toContain("### Line 10 (new)");
  });

  it("groups multiple annotations on same repo-prefixed file together", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "repo-a/src/index.ts", lineStart: 5, text: "first comment" }),
      ann({ filePath: "repo-b/src/index.ts", lineStart: 10, text: "second comment" }),
      ann({ filePath: "repo-a/src/index.ts", lineStart: 15, text: "third comment" }),
    ]);
    // All repo-a comments should be grouped together
    const repoAHeaderIdx = result.indexOf("## repo-a/src/index.ts");
    const repoBHeaderIdx = result.indexOf("## repo-b/src/index.ts");
    const firstCommentIdx = result.indexOf("first comment");
    const thirdCommentIdx = result.indexOf("third comment");
    const secondCommentIdx = result.indexOf("second comment");

    expect(repoAHeaderIdx).toBeLessThan(repoBHeaderIdx);
    expect(firstCommentIdx).toBeLessThan(thirdCommentIdx);
    expect(thirdCommentIdx).toBeLessThan(repoBHeaderIdx);
    expect(repoBHeaderIdx).toBeLessThan(secondCommentIdx);
  });

  it("handles file-scoped annotations with repo-prefixed paths", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "repo-a/src/index.ts", scope: "file", text: "file comment" }),
      ann({ filePath: "repo-a/src/index.ts", lineStart: 1, lineEnd: 1, text: "line comment" }),
    ]);
    expect(result).toContain("## repo-a/src/index.ts");
    expect(result).toContain("### File Comment");
    expect(result).toContain("### Line 1");
    const fileIdx = result.indexOf("File Comment");
    const lineIdx = result.indexOf("Line 1");
    expect(fileIdx).toBeLessThan(lineIdx);
  });

  it("handles repo labels with special characters in paths", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "my-repo_2.0/src/index.ts", text: "special chars" }),
    ]);
    expect(result).toContain("## my-repo_2.0/src/index.ts");
  });

  it("empty annotations returns generic message regardless of workspace mode", () => {
    expect(exportReviewFeedback([], undefined)).toBe("# Code Review\n\nNo feedback provided.");
  });

  it("describes exact workspace diff mode in feedback context", () => {
    const staged = exportReviewFeedback([ann()], undefined, { mode: "workspace-staged" });
    const last = exportReviewFeedback([ann()], undefined, { mode: "workspace-last" });

    expect(staged).toContain("**Diff:** Workspace staged changes");
    expect(last).toContain("**Diff:** Workspace last change");
  });

  it("contains exactly one top-level heading in workspace mode", () => {
    const result = exportReviewFeedback([
      ann({ filePath: "repo-a/src/a.ts" }),
      ann({ filePath: "repo-b/src/b.ts" }),
    ]);
    const headingMatches = result.match(/^# /gm) || [];
    expect(headingMatches).toHaveLength(1);
  });
});
