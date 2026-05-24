import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  getDefaultBranch,
  getFileContentsForDiff,
  getGitContext,
  listRecentCommits,
  parseWorktreeDiffType,
  runGitDiff,
  type DiffType,
  type ReviewGitRuntime,
} from "./review-core";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: string[]): string {
  const result = spawnSync("git", args, { cwd, encoding: "utf-8" });
  if (result.status !== 0) {
    throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  }
  return result.stdout.trim();
}

function makeRuntime(baseCwd: string): ReviewGitRuntime {
  return {
    async runGit(args: string[], options?: { cwd?: string }) {
      const result = spawnSync("git", args, {
        cwd: options?.cwd ?? baseCwd,
        encoding: "utf-8",
      });

      return {
        stdout: result.stdout ?? "",
        stderr: result.stderr ?? "",
        exitCode: result.status ?? (result.error ? 1 : 0),
      };
    },

    async readTextFile(path: string) {
      try {
        const fullPath = path.startsWith("/") ? path : resolvePath(baseCwd, path);
        return readFileSync(fullPath, "utf-8");
      } catch {
        return null;
      }
    },
  };
}

function initRepo(initialBranch = "main"): string {
  const repoDir = makeTempDir("plannotator-review-core-");
  git(repoDir, ["init"]);
  git(repoDir, ["branch", "-M", initialBranch]);
  git(repoDir, ["config", "user.email", "review-core@example.com"]);
  git(repoDir, ["config", "user.name", "Review Core"]);

  writeFileSync(join(repoDir, "tracked.txt"), "before\n", "utf-8");
  git(repoDir, ["add", "tracked.txt"]);
  git(repoDir, ["commit", "-m", "initial"]);

  return repoDir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("review-core", () => {
  test("uncommitted diff includes tracked and untracked files", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    writeFileSync(join(repoDir, "untracked.txt"), "brand new\n", "utf-8");

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.label).toBe("Uncommitted changes");
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/untracked.txt b/untracked.txt");
    expect(result.patch).toContain("+++ b/untracked.txt");
  });

  test("uncommitted diff includes untracked files when CWD is a subdirectory", async () => {
    const repoDir = initRepo();

    mkdirSync(join(repoDir, "packages", "infra", "lib"), { recursive: true });
    writeFileSync(join(repoDir, "packages", "infra", "lib", "Stack.ts"), "new stack\n", "utf-8");

    writeFileSync(join(repoDir, "root-new.txt"), "root untracked\n", "utf-8");
    mkdirSync(join(repoDir, ".github", "workflows"), { recursive: true });
    writeFileSync(join(repoDir, ".github", "workflows", "ci.yml"), "name: CI\n", "utf-8");

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");

    // Runtime whose default CWD is a subdirectory (simulates a hook process
    // that inherits an agent CWD inside a monorepo package)
    const subCwd = join(repoDir, "packages", "infra");
    const runtime = makeRuntime(subCwd);

    const result = await runGitDiff(runtime, "uncommitted", "main");

    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/packages/infra/lib/Stack.ts b/packages/infra/lib/Stack.ts");
    expect(result.patch).toContain("diff --git a/root-new.txt b/root-new.txt");
    expect(result.patch).toContain("diff --git a/.github/workflows/ci.yml b/.github/workflows/ci.yml");
  });

  test("unstaged diff includes untracked files", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    writeFileSync(join(repoDir, "tracked.txt"), "after again\n", "utf-8");
    writeFileSync(join(repoDir, "scratch.txt"), "tmp\n", "utf-8");

    const result = await runGitDiff(runtime, "unstaged", "main");

    expect(result.label).toBe("Unstaged changes");
    expect(result.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(result.patch).toContain("diff --git a/scratch.txt b/scratch.txt");
  });

  test("staged diff excludes untracked files until they are staged", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "staged change\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    writeFileSync(join(repoDir, "draft.txt"), "not staged yet\n", "utf-8");

    const stagedOnly = await runGitDiff(runtime, "staged", "main");
    expect(stagedOnly.patch).toContain("diff --git a/tracked.txt b/tracked.txt");
    expect(stagedOnly.patch).not.toContain("draft.txt");

    git(repoDir, ["add", "draft.txt"]);
    const stagedWithNewFile = await runGitDiff(runtime, "staged", "main");
    expect(stagedWithNewFile.patch).toContain("diff --git a/draft.txt b/draft.txt");
  });

  test("branch diff returns an error when the default branch ref is invalid", async () => {
    const repoDir = initRepo("trunk");
    const runtime = makeRuntime(repoDir);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");

    const context = await getGitContext(runtime);
    expect(context.defaultBranch).toBe("master");

    const result = await runGitDiff(runtime, "branch", context.defaultBranch);

    expect(result.patch).toBe("");
    expect(result.label).toBe("Error: branch");
    // Error is derived from the argv — assert the meaningful parts rather
    // than the exact string so harmless argv reorders (e.g. --end-of-options)
    // don't break it.
    expect(result.error).toContain("git diff");
    expect(result.error).toContain("master..HEAD");
  });

  test("git context lists worktrees and file content lookup returns old/new content", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);

    const worktreeParent = makeTempDir("plannotator-review-core-worktree-");
    const worktreeDir = join(worktreeParent, "feature-worktree");
    git(repoDir, ["worktree", "add", "-b", "feature/review-core", worktreeDir]);

    writeFileSync(join(repoDir, "tracked.txt"), "after\n", "utf-8");
    writeFileSync(join(repoDir, "new-file.txt"), "brand new\n", "utf-8");

    const context = await getGitContext(runtime);
    expect(context.diffOptions.map((option) => option.id)).toEqual(
      expect.arrayContaining(["uncommitted", "staged", "unstaged", "last-commit"]),
    );
    expect(
      context.worktrees.some((worktree) => worktree.path.endsWith("/feature-worktree")),
    ).toBe(true);

    const trackedContents = await getFileContentsForDiff(
      runtime,
      "uncommitted",
      context.defaultBranch,
      "tracked.txt",
    );
    expect(trackedContents.oldContent).toBe("before\n");
    expect(trackedContents.newContent).toBe("after\n");

    const newFileContents = await getFileContentsForDiff(
      runtime,
      "uncommitted",
      context.defaultBranch,
      "new-file.txt",
    );
    expect(newFileContents.oldContent).toBeNull();
    expect(newFileContents.newContent).toBe("brand new\n");
  });

  test("getDefaultBranch falls back to local when origin/HEAD points at an unfetched ref", () => {
    // Simulates a narrow / partial clone where origin/HEAD is configured but
    // the target ref was never fetched. Before the verify step, the server
    // would return "origin/phantom" and every branch/merge-base diff would
    // fail with "unknown revision". With the verify step we fall back to
    // local main.
    const repoDir = initRepo();

    // Manually set origin/HEAD → origin/phantom without ever fetching it.
    git(repoDir, ["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/phantom"]);

    const runtime = makeRuntime(repoDir);
    return getDefaultBranch(runtime).then((result) => {
      expect(result).toBe("main");
    });
  });

  test("listRecentCommits returns HEAD ancestry with shortSha and subject", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "tracked.txt"), "second\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "second commit"]);
    writeFileSync(join(repoDir, "tracked.txt"), "third\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "third commit"]);

    const runtime = makeRuntime(repoDir);
    const commits = await listRecentCommits(runtime, repoDir, 10);

    expect(commits.length).toBe(3);
    expect(commits[0].subject).toBe("third commit");
    expect(commits[1].subject).toBe("second commit");
    expect(commits[2].subject).toBe("initial");
    for (const c of commits) {
      expect(c.sha).toMatch(/^[0-9a-f]{40}$/);
      expect(c.shortSha.length).toBeGreaterThanOrEqual(7);
      expect(c.sha.startsWith(c.shortSha)).toBe(true);
      expect(c.author).toBe("Review Core");
      expect(c.relativeDate.length).toBeGreaterThan(0);
    }
  });

  test("getGitContext includes recentCommits for the picker", async () => {
    const repoDir = initRepo();
    writeFileSync(join(repoDir, "tracked.txt"), "second\n", "utf-8");
    git(repoDir, ["add", "tracked.txt"]);
    git(repoDir, ["commit", "-m", "second commit"]);

    const runtime = makeRuntime(repoDir);
    const context = await getGitContext(runtime, repoDir);

    expect(context.recentCommits).toBeDefined();
    expect(context.recentCommits!.length).toBe(2);
    expect(context.recentCommits![0].subject).toBe("second commit");
  });

  test("parseWorktreeDiffType recognises every DiffType suffix, including merge-base", () => {
    // Regression guard: every local diff type must round-trip through the
    // worktree-prefixed form. Missing `merge-base` here previously routed
    // "worktree:/path:merge-base" to { path: "/path:merge-base", subType: "uncommitted" }
    // which pointed git at a non-existent cwd and silently collapsed the diff mode.
    const subTypes = [
      "uncommitted",
      "staged",
      "unstaged",
      "last-commit",
      "branch",
      "merge-base",
    ] as const;
    for (const sub of subTypes) {
      const composite = `worktree:/tmp/my-worktree:${sub}` as DiffType;
      const parsed = parseWorktreeDiffType(composite);
      expect(parsed).toEqual({ path: "/tmp/my-worktree", subType: sub });
    }
  });
});
