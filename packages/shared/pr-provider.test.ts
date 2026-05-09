import { describe, expect, test } from "bun:test";
import {
  getCliInstallUrl,
  getCliName,
  getDisplayRepo,
  getMRLabel,
  getMRNumberLabel,
  getPlatformLabel,
  isSameProject,
  parsePRUrl,
  prRefFromMetadata,
  type PRMetadata,
  type PRRef,
} from "./pr-provider";
import {
  getPRDiffScopeOptions,
  getPRStackInfo,
} from "./pr-stack";

describe("pr-provider platform helpers", () => {
  test("parses GitHub PR URLs including nested suffixes", () => {
    const ref = parsePRUrl("https://github.com/backnotprop/plannotator/pull/364/files");

    expect(ref).toEqual({
      platform: "github",
      host: "github.com",
      owner: "backnotprop",
      repo: "plannotator",
      number: 364,
    });
  });

  test("parses GitHub Enterprise PR URLs", () => {
    const ref = parsePRUrl("https://ghe.company.com/org/repo/pull/99/files");

    expect(ref).toEqual({
      platform: "github",
      host: "ghe.company.com",
      owner: "org",
      repo: "repo",
      number: 99,
    });
  });

  test("does not confuse GHE URL with GitLab", () => {
    const ref = parsePRUrl("https://git.internal.corp/team/app/pull/5");

    expect(ref).toEqual({
      platform: "github",
      host: "git.internal.corp",
      owner: "team",
      repo: "app",
      number: 5,
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
      host: "github.com",
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
      host: "github.com",
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
      host: "github.com",
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

describe("PR stack helpers", () => {
  const stackedMeta: PRMetadata = {
    platform: "github",
    host: "github.com",
    owner: "backnotprop",
    repo: "plannotator-stack-fixture",
    number: 3,
    title: "Validate user id",
    author: "backnotprop",
    baseBranch: "stack/auth-refactor",
    headBranch: "stack/validation",
    defaultBranch: "main",
    baseSha: "base",
    headSha: "head",
    url: "https://github.com/backnotprop/plannotator-stack-fixture/pull/3",
  };

  test("infers a stacked PR when the base branch differs from the default branch", () => {
    expect(getPRStackInfo(stackedMeta)).toEqual({
      isStacked: true,
      baseBranch: "stack/auth-refactor",
      defaultBranch: "main",
      label: "stack/validation stacked on stack/auth-refactor",
      source: "branch-inferred",
    });
  });

  test("does not infer a stack for the bottom PR targeting the default branch", () => {
    expect(getPRStackInfo({
      ...stackedMeta,
      number: 1,
      baseBranch: "main",
      headBranch: "stack/base-cleanup",
    })).toBeNull();
  });

  test("only enables full-stack scope when stacked metadata has a local checkout", () => {
    expect(getPRDiffScopeOptions(stackedMeta, true)).toEqual([
      {
        id: "layer",
        label: "Layer",
        description: "Only changes relative to stack/auth-refactor.",
        enabled: true,
      },
      {
        id: "full-stack",
        label: "Full stack",
        description: "All changes from main to HEAD in the local checkout.",
        enabled: true,
      },
    ]);

    expect(getPRDiffScopeOptions(stackedMeta, false)[1].enabled).toBe(false);
  });
});

describe("isSameProject", () => {
  const ghRef: PRRef = { platform: "github", host: "github.com", owner: "acme", repo: "widgets", number: 1 };
  const glRef: PRRef = { platform: "gitlab", host: "gitlab.com", projectPath: "acme/widgets", iid: 1 };

  test("same GitHub project", () => {
    expect(isSameProject(ghRef, { ...ghRef, number: 99 })).toBe(true);
  });

  test("different GitHub owner", () => {
    expect(isSameProject(ghRef, { ...ghRef, owner: "other" })).toBe(false);
  });

  test("different GitHub repo", () => {
    expect(isSameProject(ghRef, { ...ghRef, repo: "gadgets" })).toBe(false);
  });

  test("different GitHub host", () => {
    expect(isSameProject(ghRef, { ...ghRef, host: "ghe.corp.com" })).toBe(false);
  });

  test("same GitLab project", () => {
    expect(isSameProject(glRef, { ...glRef, iid: 99 })).toBe(true);
  });

  test("different GitLab projectPath", () => {
    expect(isSameProject(glRef, { ...glRef, projectPath: "other/repo" })).toBe(false);
  });

  test("GitHub vs GitLab", () => {
    expect(isSameProject(ghRef, glRef)).toBe(false);
  });
});
