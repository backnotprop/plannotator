import { describe, expect, test } from "bun:test";
import type {
  DiffResult,
  DiffType,
  GitContext,
  ReviewGitRuntime,
} from "./review-core";
import {
  type VcsProvider,
  createGitProvider,
  createVcsApi,
  resolveInitialDiffType,
} from "./vcs-core";

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

function provider(
  id: string,
  detected: boolean,
  ownedTypes: string[],
  contextOverrides: Partial<GitContext> = {},
): VcsProvider {
  return {
    id,
    async detect() {
      return detected;
    },
    ownsDiffType(diffType: string) {
      return ownedTypes.includes(diffType);
    },
    async getContext() {
      return context({ vcsType: id as GitContext["vcsType"], ...contextOverrides });
    },
    async runDiff(diffType: DiffType, defaultBranch: string): Promise<DiffResult> {
      return { patch: `${id}:${diffType}:${defaultBranch}`, label: `${id}:${defaultBranch}` };
    },
    async getFileContents() {
      return { oldContent: id, newContent: id };
    },
  };
}

const gitRuntime: ReviewGitRuntime = {
  async runGit() {
    return { stdout: "", stderr: "", exitCode: 0 };
  },
  async readTextFile() {
    return null;
  },
};

describe("createVcsApi", () => {
  test("detects the first matching provider so jj wins colocated workspaces", async () => {
    const jj = provider("jj", true, ["jj-current"]);
    const git = provider("git", true, ["uncommitted"]);
    const api = createVcsApi([jj, git]);

    await expect(api.detectVcs("/repo")).resolves.toBe(jj);
    await expect(api.getVcsContext("/repo")).resolves.toMatchObject({ vcsType: "jj" });
  });

  test("routes operations by diff type before falling back to detection", async () => {
    const jj = provider("jj", false, ["jj-current"]);
    const git = provider("git", true, ["uncommitted"]);
    const api = createVcsApi([jj, git]);

    await expect(api.runVcsDiff("jj-current", "trunk()", "/repo")).resolves.toMatchObject({
      patch: "jj:jj-current:trunk()",
    });
    await expect(api.runVcsDiff("uncommitted", "main", "/repo")).resolves.toMatchObject({
      patch: "git:uncommitted:main",
    });
  });

  test("limits Git staging to working-tree diff modes", async () => {
    const git = createVcsApi([createGitProvider(gitRuntime)]);

    await expect(git.canStageFiles("uncommitted", "/repo")).resolves.toBe(true);
    await expect(git.canStageFiles("unstaged", "/repo")).resolves.toBe(true);
    await expect(git.canStageFiles("worktree:/repo:uncommitted", "/repo")).resolves.toBe(true);
    await expect(git.canStageFiles("staged", "/repo")).resolves.toBe(false);
    await expect(git.canStageFiles("branch", "/repo")).resolves.toBe(false);
    await expect(git.canStageFiles("merge-base", "/repo")).resolves.toBe(false);
  });

  test("prepares JJ local reviews by ignoring Git-shaped requested options", async () => {
    const jj = provider("jj", true, ["jj-current", "jj-line"], {
      defaultBranch: "trunk()",
      diffOptions: [
        { id: "jj-current", label: "Current change" },
        { id: "jj-line", label: "Line of work" },
      ],
      vcsType: "jj",
    });
    const git = provider("git", true, ["merge-base", "uncommitted"]);
    const api = createVcsApi([jj, git]);

    await expect(api.prepareLocalReviewDiff({
      cwd: "/repo",
      requestedDiffType: "merge-base",
      requestedBase: "main",
      configuredDiffType: "unstaged",
    })).resolves.toMatchObject({
      diffType: "jj-current",
      base: "trunk()",
      rawPatch: "jj:jj-current:trunk()",
    });
  });

  test("prepares local reviews by preserving valid requested diff types for the detected VCS", async () => {
    const jj = provider("jj", true, ["jj-current", "jj-line"], {
      defaultBranch: "trunk()",
      diffOptions: [
        { id: "jj-current", label: "Current change" },
        { id: "jj-line", label: "Line of work" },
      ],
      vcsType: "jj",
    });
    const api = createVcsApi([jj]);

    await expect(api.prepareLocalReviewDiff({
      cwd: "/repo",
      requestedDiffType: "jj-line",
      requestedBase: "feature@origin",
      configuredDiffType: "unstaged",
    })).resolves.toMatchObject({
      diffType: "jj-line",
      base: "feature@origin",
      rawPatch: "jj:jj-line:feature@origin",
    });
  });

  test("prepares Git local reviews by honoring valid requested base and ignoring JJ diff modes", async () => {
    const git = provider("git", true, ["uncommitted", "merge-base"]);
    const api = createVcsApi([git]);

    await expect(api.prepareLocalReviewDiff({
      cwd: "/repo",
      requestedDiffType: "jj-line",
      requestedBase: "develop",
      configuredDiffType: "merge-base",
    })).resolves.toMatchObject({
      diffType: "merge-base",
      base: "develop",
      rawPatch: "git:merge-base:develop",
    });
  });

  test("can force Git for local review startup in colocated JJ workspaces", async () => {
    const jj = provider("jj", true, ["jj-current"], {
      defaultBranch: "trunk()",
      diffOptions: [{ id: "jj-current", label: "Current change" }],
      vcsType: "jj",
    });
    const git = provider("git", true, ["uncommitted", "merge-base"]);
    const api = createVcsApi([jj, git]);

    await expect(api.prepareLocalReviewDiff({
      cwd: "/repo",
      vcsType: "git",
      configuredDiffType: "merge-base",
    })).resolves.toMatchObject({
      gitContext: { vcsType: "git" },
      diffType: "merge-base",
      base: "main",
      rawPatch: "git:merge-base:main",
    });
  });

  test("reports a clear error when forced Git is unavailable", async () => {
    const jj = provider("jj", true, ["jj-current"], {
      defaultBranch: "trunk()",
      diffOptions: [{ id: "jj-current", label: "Current change" }],
      vcsType: "jj",
    });
    const git = provider("git", false, ["uncommitted", "merge-base"]);
    const api = createVcsApi([jj, git]);

    await expect(api.prepareLocalReviewDiff({
      cwd: "/repo",
      vcsType: "git",
      configuredDiffType: "merge-base",
    })).rejects.toThrow("Git workspace not found.");
  });

  test("refreshes context and remote defaults with the forced VCS", async () => {
    const jj = provider("jj", true, ["jj-current"], {
      defaultBranch: "trunk()",
      diffOptions: [{ id: "jj-current", label: "Current change" }],
      vcsType: "jj",
    });
    const git = {
      ...provider("git", true, ["uncommitted", "merge-base"]),
      detectRemoteDefaultCompareTarget: async () => "origin/main",
    };
    const api = createVcsApi([jj, git]);

    await expect(api.getVcsContext("/repo", "git")).resolves.toMatchObject({
      vcsType: "git",
      defaultBranch: "main",
    });
    await expect(api.detectRemoteDefaultCompareTarget("/repo", "git")).resolves.toBe("origin/main");
  });
});

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
