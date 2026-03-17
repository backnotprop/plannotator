import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import {
  getFileContentsForDiff,
  getGitContext,
  runGitDiff,
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
    expect(result.error).toContain("git diff --no-ext-diff master..HEAD");
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
});
