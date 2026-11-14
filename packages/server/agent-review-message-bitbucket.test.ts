/**
 * Agent jobs on a PR without a ready local checkout: GitHub/GitLab agents can
 * read the PR through gh/glab, so the prompt carries only the URL; no CLI a
 * job may run can read a Bitbucket PR, so its prompt must carry the diff.
 */
import { describe, expect, test } from "bun:test";
import { buildAgentReviewUserMessage } from "./agent-review-message";
import { buildGuideUserMessage } from "@plannotator/shared/guide-prompt";
import type { PRMetadata } from "./pr";

const patch = "diff --git a/src/a.ts b/src/a.ts\n+const a = 1;\n";
const common = { title: "t", author: "a", baseBranch: "main", headBranch: "f", baseSha: "b", headSha: "h" };
const github: PRMetadata = { ...common, platform: "github", host: "github.com", owner: "o", repo: "r", number: 1, url: "https://github.com/o/r/pull/1" };
const bitbucket: PRMetadata = { ...common, platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "r", number: 1, url: "https://bitbucket.org/ws/r/pull-requests/1" };

describe("PR prompts without a local checkout", () => {
  test("review agents: GitHub stays URL-only, Bitbucket carries the diff", () => {
    expect(buildAgentReviewUserMessage(patch, "uncommitted", {}, github)).not.toContain(patch);
    const bb = buildAgentReviewUserMessage(patch, "uncommitted", {}, bitbucket);
    expect(bb).toContain(bitbucket.url);
    expect(bb).toContain(patch);
  });

  test("with a ready checkout every platform gets the same local-diff instructions", () => {
    const gh = buildAgentReviewUserMessage(patch, "uncommitted", { hasLocalAccess: true }, github);
    const bb = buildAgentReviewUserMessage(patch, "uncommitted", { hasLocalAccess: true }, bitbucket);
    expect(bb.replace(bitbucket.url, "URL")).toBe(gh.replace(github.url, "URL"));
  });

  test("guided review: the inlineDiff flag is what adds the diff", () => {
    expect(buildGuideUserMessage(patch, "uncommitted", {}, github)).not.toContain(patch);
    expect(buildGuideUserMessage(patch, "uncommitted", {}, { ...bitbucket, inlineDiff: true })).toContain(patch);
  });
});
