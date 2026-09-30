/**
 * The PR provider seam (#1583): URL detection, capabilities and the pure
 * helpers every platform shares. GitHub/GitLab behavior is pinned so adding a
 * third platform cannot change it.
 */
import { describe, expect, test } from "bun:test";
import {
  getCliName,
  getDisplayRepo,
  getMRNumberLabel,
  getPlatformLabel,
  getPRCloneCommand,
  getPRHeadFetchSpec,
  getPRNumber,
  getPRPlatformCapabilities,
  isSameProject,
  parsePRUrl,
  prRefFromMetadata,
  type BitbucketPRMetadata,
  type PRMetadata,
} from "./pr-types";
import { prDraftTargetKey } from "./review-draft";

const bbMeta: BitbucketPRMetadata = {
  platform: "bitbucket",
  host: "bitbucket.org",
  workspace: "ws",
  repo: "repo",
  number: 7,
  title: "t",
  author: "a",
  baseBranch: "main",
  headBranch: "feature/x",
  baseSha: "b".repeat(40),
  headSha: "h".repeat(40),
  url: "https://bitbucket.org/ws/repo/pull-requests/7",
};

describe("parsePRUrl — Bitbucket Cloud", () => {
  test.each([
    "https://bitbucket.org/ws/repo/pull-requests/7",
    "https://bitbucket.org/ws/repo/pull-requests/7/diff",
    "https://bitbucket.org/ws/repo/pull-requests/7/overview?w=1",
    "https://www.bitbucket.org/ws/repo/pull-requests/7#comment-1",
  ])("%s", (url) => {
    expect(parsePRUrl(url)).toEqual({ platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "repo", number: 7 });
  });

  test("rejects non-PR Bitbucket URLs and Bitbucket Data Center's shape", () => {
    expect(parsePRUrl("https://bitbucket.org/ws/repo/src/main/")).toBeNull();
    expect(parsePRUrl("https://bitbucket.org/ws/repo/pull-requests/7abc")).toBeNull();
    // Data Center: a different URL and API, not supported.
    expect(parsePRUrl("https://git.corp.example/projects/P/repos/r/pull-requests/7")).toBeNull();
  });

  test("GitHub and GitLab URLs still parse as before", () => {
    expect(parsePRUrl("https://github.com/o/r/pull/3")?.platform).toBe("github");
    expect(parsePRUrl("https://gitlab.com/g/p/-/merge_requests/3")?.platform).toBe("gitlab");
  });
});

describe("helpers", () => {
  test("labels, number and repo for all three platforms", () => {
    const gh = parsePRUrl("https://github.com/o/r/pull/3")!;
    const gl = parsePRUrl("https://gitlab.com/g/p/-/merge_requests/4")!;
    const bb = parsePRUrl("https://bitbucket.org/ws/repo/pull-requests/5")!;
    expect([gh, gl, bb].map(getMRNumberLabel)).toEqual(["#3", "!4", "#5"]);
    expect([gh, gl, bb].map(getPRNumber)).toEqual([3, 4, 5]);
    expect([gh, gl, bb].map(getDisplayRepo)).toEqual(["o/r", "g/p", "ws/repo"]);
    expect([gh, gl, bb].map(getPlatformLabel)).toEqual(["GitHub", "GitLab", "Bitbucket"]);
    expect([gh, gl, bb].map(getCliName)).toEqual(["gh", "glab", ""]);
    expect(prRefFromMetadata(bbMeta)).toEqual({ platform: "bitbucket", host: "bitbucket.org", workspace: "ws", repo: "repo", number: 7 });
  });

  test("isSameProject treats Bitbucket slugs case-insensitively and never matches across platforms", () => {
    const a = parsePRUrl("https://bitbucket.org/WS/Repo/pull-requests/1")!;
    const b = parsePRUrl("https://bitbucket.org/ws/repo/pull-requests/2")!;
    expect(isSameProject(a, b)).toBe(true);
    expect(isSameProject(a, parsePRUrl("https://github.com/ws/repo/pull/1")!)).toBe(false);
  });

  test("capabilities: what the UI hides or maps per platform", () => {
    const pick = (platform: PRMetadata["platform"]) => {
      const c = getPRPlatformCapabilities({ platform });
      return [c.requestChanges, c.selfReviewBlocked, c.viewedSync, c.fileLevelComments, c.agentCliAccess, c.artifacts];
    };
    expect(pick("github")).toEqual([true, true, true, true, true, true]);
    expect(pick("gitlab")).toEqual([false, true, false, false, true, true]);
    expect(pick("bitbucket")).toEqual([true, false, false, false, false, false]);
  });
});

describe("local checkout specs", () => {
  test("GitHub/GitLab fetch their PR head ref from origin, unchanged", () => {
    const gh = { ...bbMeta, platform: "github", owner: "o", repo: "r", number: 3 } as unknown as PRMetadata;
    const gl = { ...bbMeta, platform: "gitlab", projectPath: "g/p", iid: 4 } as unknown as PRMetadata;
    expect(getPRHeadFetchSpec(gh)).toEqual({ remote: null, ref: "refs/pull/3/head" });
    expect(getPRHeadFetchSpec(gl)).toEqual({ remote: null, ref: "refs/merge-requests/4/head" });
    expect(getPRCloneCommand(gh, "/d").argv).toEqual(["gh", "repo", "clone", "o/r", "/d", "--", "--depth=1", "--no-checkout"]);
  });

  test("Bitbucket fetches the source branch, from the fork when there is one", () => {
    expect(getPRHeadFetchSpec(bbMeta)).toEqual({ remote: null, ref: "refs/heads/feature/x" });
    expect(getPRHeadFetchSpec({ ...bbMeta, sourceRepo: "someone/repo-fork" })).toEqual({
      remote: "https://bitbucket.org/someone/repo-fork.git",
      ref: "refs/heads/feature/x",
    });
    // A branch name shaped like a flag is refused before it reaches git.
    expect(() => getPRHeadFetchSpec({ ...bbMeta, headBranch: "--upload-pack=x" })).toThrow("Invalid source branch");
  });

  test("the Bitbucket clone is plain git over https that never prompts", () => {
    const { argv, env } = getPRCloneCommand(bbMeta, "/tmp/x");
    expect(argv).toEqual(["git", "clone", "--depth=1", "--no-checkout", "--", "https://bitbucket.org/ws/repo.git", "/tmp/x"]);
    expect(env).toEqual({ GIT_TERMINAL_PROMPT: "0" });
  });
});

describe("prDraftTargetKey", () => {
  test("GitHub and GitLab keys are pinned: a changed key would orphan every saved PR draft", () => {
    const gh = { platform: "github", host: "github.com", owner: "Acme", repo: "Widgets", number: 42 } as PRMetadata;
    const gl = { platform: "gitlab", host: "gitlab.example.com", projectPath: "Group/Sub/Project", iid: 7 } as PRMetadata;
    // Values computed with the pre-Bitbucket implementation on main.
    expect(prDraftTargetKey(gh, "layer")).toBe("pr-89a0481ca8626ebf");
    expect(prDraftTargetKey(gh, "full-stack")).toBe("pr-5bafee1d6456631b");
    expect(prDraftTargetKey(gl, "layer")).toBe("pr-a2c74c0e94f2901e");
    expect(prDraftTargetKey(gl, "full-stack")).toBe("pr-bb259c21fae448bc");
  });

  test("Bitbucket keys are case-insensitive and never collide with a same-named GitHub PR", () => {
    const key = prDraftTargetKey(bbMeta, "layer");
    expect(prDraftTargetKey({ ...bbMeta, workspace: "WS", repo: "Repo" }, "layer")).toBe(key);
    const gh = { ...bbMeta, platform: "github", owner: "ws", repo: "repo", number: 7 } as unknown as PRMetadata;
    expect(prDraftTargetKey(gh, "layer")).not.toBe(key);
  });
});
