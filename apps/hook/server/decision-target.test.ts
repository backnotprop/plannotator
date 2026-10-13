import { describe, expect, test } from "bun:test";
import { annotateDecisionTarget, HOST_REVIEW_ID_ENV, reviewDecisionTarget, takeHostReviewId } from "./decision-target";

// The failure these guard: a decision record or registry row that names a
// review by something other than what the server actually opened (a relative
// word, the wrong one of several files), or a host review id that leaks into
// every process the server spawns.
describe("decision target", () => {
  test("review: a PR URL wins, then the patch file, then the reviewed directory, all absolute", () => {
    expect(reviewDecisionTarget({ prUrl: "https://github.com/o/r/pull/9", cwd: "/repo", invocationCwd: "/x" })).toBe("https://github.com/o/r/pull/9");
    expect(reviewDecisionTarget({ patchFile: "fix.patch", cwd: "/repo", invocationCwd: "/work" })).toBe("/work/fix.patch");
    expect(reviewDecisionTarget({ patchFile: "-", cwd: "/repo", invocationCwd: "/work" })).toBeUndefined();
    expect(reviewDecisionTarget({ cwd: "/repo/app/../app", invocationCwd: "/work" })).toBe("/repo/app");
  });

  test("annotate: a bundle names every file in order, else the folder, else the file or URL", () => {
    expect(annotateDecisionTarget({ bundlePaths: ["/w/b.md", "/w/a.md"], absolutePath: "/w/b.md" })).toEqual(["/w/b.md", "/w/a.md"]);
    expect(annotateDecisionTarget({ folderPath: "/w/docs", absolutePath: "/w/docs" })).toBe("/w/docs");
    expect(annotateDecisionTarget({ absolutePath: "https://example.com/" })).toBe("https://example.com/");
  });

  test("the host review id is taken once, validated and scrubbed", () => {
    const env: NodeJS.ProcessEnv = { [HOST_REVIEW_ID_ENV]: "PN-ABC123" };
    expect(takeHostReviewId(env)).toBe("pn-abc123");
    expect(env[HOST_REVIEW_ID_ENV]).toBeUndefined();
    expect(takeHostReviewId({ [HOST_REVIEW_ID_ENV]: "pn-abc123; rm -rf /" })).toBeUndefined();
  });
});
