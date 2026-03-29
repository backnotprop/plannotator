import { describe, expect, test } from "bun:test";
import {
  getCliInstallUrl,
  getCliName,
  getDisplayRepo,
  getMRLabel,
  getMRNumberLabel,
  getPlatformLabel,
  parsePRUrl,
  prRefFromMetadata,
  type PRMetadata,
} from "./pr-provider";

describe("pr-provider platform helpers", () => {
  test("parses GitHub PR URLs including nested suffixes", () => {
    const ref = parsePRUrl("https://github.com/backnotprop/plannotator/pull/364/files");

    expect(ref).toEqual({
      platform: "github",
      owner: "backnotprop",
      repo: "plannotator",
      number: 364,
    });
  });

  test("parses GitLab.com MR URLs", () => {
    const ref = parsePRUrl("https://gitlab.com/group/project/-/merge_requests/42/diffs");

    expect(ref).toEqual({
      platform: "gitlab",
      host: "gitlab.com",
      projectPath: "group/project",
      iid: 42,
    });
  });

  test("parses self-hosted GitLab MR URLs with nested groups", () => {
    const ref = parsePRUrl("https://gitlab.example.com/group/subgroup/project/-/merge_requests/7");

    expect(ref).toEqual({
      platform: "gitlab",
      host: "gitlab.example.com",
      projectPath: "group/subgroup/project",
      iid: 7,
    });
  });

  test("returns null for unsupported URLs", () => {
    expect(parsePRUrl("https://example.com/not-a-pr/123")).toBeNull();
    expect(parsePRUrl("")).toBeNull();
  });

  test("formats platform-aware labels for GitHub and GitLab", () => {
    const githubMeta: PRMetadata = {
      platform: "github",
      owner: "backnotprop",
      repo: "plannotator",
      number: 364,
      title: "GitHub PR",
      author: "backnotprop",
      baseBranch: "main",
      headBranch: "feature/github",
      baseSha: "base",
      headSha: "head",
      url: "https://github.com/backnotprop/plannotator/pull/364",
    };

    const gitlabMeta: PRMetadata = {
      platform: "gitlab",
      host: "gitlab.example.com",
      projectPath: "group/project",
      iid: 42,
      title: "GitLab MR",
      author: "alice",
      baseBranch: "main",
      headBranch: "feature/gitlab",
      baseSha: "base",
      headSha: "head",
      url: "https://gitlab.example.com/group/project/-/merge_requests/42",
    };

    expect(getPlatformLabel(githubMeta)).toBe("GitHub");
    expect(getMRLabel(githubMeta)).toBe("PR");
    expect(getMRNumberLabel(githubMeta)).toBe("#364");
    expect(getDisplayRepo(githubMeta)).toBe("backnotprop/plannotator");

    expect(getPlatformLabel(gitlabMeta)).toBe("GitLab");
    expect(getMRLabel(gitlabMeta)).toBe("MR");
    expect(getMRNumberLabel(gitlabMeta)).toBe("!42");
    expect(getDisplayRepo(gitlabMeta)).toBe("group/project");
  });

  test("reconstructs refs and CLI metadata for each platform", () => {
    const githubMeta: PRMetadata = {
      platform: "github",
      owner: "backnotprop",
      repo: "plannotator",
      number: 1,
      title: "GitHub PR",
      author: "backnotprop",
      baseBranch: "main",
      headBranch: "feature/github",
      baseSha: "base",
      headSha: "head",
      url: "https://github.com/backnotprop/plannotator/pull/1",
    };

    const gitlabMeta: PRMetadata = {
      platform: "gitlab",
      host: "gitlab.example.com",
      projectPath: "group/project",
      iid: 2,
      title: "GitLab MR",
      author: "alice",
      baseBranch: "main",
      headBranch: "feature/gitlab",
      baseSha: "base",
      headSha: "head",
      url: "https://gitlab.example.com/group/project/-/merge_requests/2",
    };

    const githubRef = prRefFromMetadata(githubMeta);
    const gitlabRef = prRefFromMetadata(gitlabMeta);

    expect(githubRef).toEqual({
      platform: "github",
      owner: "backnotprop",
      repo: "plannotator",
      number: 1,
    });
    expect(gitlabRef).toEqual({
      platform: "gitlab",
      host: "gitlab.example.com",
      projectPath: "group/project",
      iid: 2,
    });

    expect(getCliName(githubRef)).toBe("gh");
    expect(getCliInstallUrl(githubRef)).toBe("https://cli.github.com");
    expect(getCliName(gitlabRef)).toBe("glab");
    expect(getCliInstallUrl(gitlabRef)).toBe("https://gitlab.com/gitlab-org/cli");
  });
});
