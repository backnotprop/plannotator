import { afterEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { getCommitDiffInfo, listCommitHistory } from "./commit-history";
import type { ReviewGitRuntime } from "./review-core";

// Same minimal git harness as review-core.test.ts (per-file test harnesses
// are this package's style — each suite stays runnable in isolation).
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
  const repoDir = makeTempDir("plannotator-commit-history-");
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

describe("getCommitDiffInfo", () => {
  test("getCommitDiffInfo returns the full multiline body for the description card", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    const body = "Why this change exists.\n\n- bullet one\n- bullet two\n\n```ts\ncode();\n```";
    git(repoDir, ["commit", "--allow-empty", "-m", "feat: subject line", "-m", body]);
    const sha = git(repoDir, ["rev-parse", "HEAD"]);

    const info = await getCommitDiffInfo(runtime, sha, repoDir);

    expect(info).not.toBeNull();
    expect(info!.sha).toBe(sha);
    expect(info!.subject).toBe("feat: subject line");
    expect(info!.body).toBe(body);
    expect(info!.author).toBe("Review Core");
    expect(info!.authorEmail).toBe("review-core@example.com");
    expect(info!.committedAt).toBeGreaterThan(0);
    // Non-hex or unresolvable shas fail closed.
    expect(await getCommitDiffInfo(runtime, "HEAD", repoDir)).toBeNull();
    expect(await getCommitDiffInfo(runtime, "deadbeefdeadbeef", repoDir)).toBeNull();
  });

});

describe("listCommitHistory", () => {
  /** Commit an empty marker commit with a given subject and return its sha. */
  function commit(repoDir: string, subject: string): string {
    git(repoDir, ["commit", "--allow-empty", "-m", subject]);
    return git(repoDir, ["rev-parse", "HEAD"]);
  }

  test("marks HEAD, carries authors, and marks where the branch meets the base", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    commit(repoDir, "on main");
    git(repoDir, ["checkout", "-b", "feature"]);
    const branch1 = commit(repoDir, "branch work 1");
    git(repoDir, ["config", "user.name", "Someone Else"]);
    const branch2 = commit(repoDir, "branch work 2");
    git(repoDir, ["config", "user.name", "Review Core"]);

    const page = await listCommitHistory(runtime, "main", repoDir);

    expect(page).not.toBeNull();
    expect(page!.base).toBe("main");
    expect(page!.hasMore).toBe(false);
    expect(page!.commits.map((c) => c.subject)).toEqual([
      "branch work 2",
      "branch work 1",
      "on main",
      "initial",
    ]);
    expect(page!.commits[0].sha).toBe(branch2);
    expect(page!.commits[0].isHead).toBe(true);
    expect(page!.commits[1].isHead).toBe(false);
    // Divider: branch-local commits above, base history below.
    expect(page!.commits.map((c) => c.isPastBase)).toEqual([false, false, true, true]);
    // Author name + email ride along (email is the avatar resolver's key).
    expect(page!.commits[0].author).toBe("Someone Else");
    expect(page!.commits[1].author).toBe("Review Core");
    expect(page!.commits[0].authorEmail).toBe("review-core@example.com");
    // Committer time is a locale-proof epoch (ms) the client formats itself.
    expect(page!.commits[0].committedAt).toBeGreaterThan(0);
    expect(page!.commits[0].committedAt).toBeLessThanOrEqual(Date.now() + 1000);
    expect(branch1).toBe(page!.commits[1].sha);
  });

  test("pages with before and reports hasMore honestly", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    for (let i = 2; i <= 5; i++) commit(repoDir, `commit ${i}`);

    const first = await listCommitHistory(runtime, "main", repoDir, { limit: 2 });
    expect(first!.commits.map((c) => c.subject)).toEqual(["commit 5", "commit 4"]);
    expect(first!.hasMore).toBe(true);

    const second = await listCommitHistory(runtime, "main", repoDir, {
      limit: 2,
      before: first!.commits[1].sha,
    });
    expect(second!.commits.map((c) => c.subject)).toEqual(["commit 3", "commit 2"]);
    expect(second!.hasMore).toBe(true);
    expect(second!.commits.every((c) => !c.isHead)).toBe(true);

    const last = await listCommitHistory(runtime, "main", repoDir, {
      limit: 2,
      before: second!.commits[1].sha,
    });
    expect(last!.commits.map((c) => c.subject)).toEqual(["initial"]);
    expect(last!.hasMore).toBe(false);

    // Paging past the root commit yields an empty terminal page, not an error.
    const past = await listCommitHistory(runtime, "main", repoDir, {
      limit: 2,
      before: last!.commits[0].sha,
    });
    expect(past).toEqual({ commits: [], hasMore: false, base: "main" });
  });

  test("a cursor orphaned by a history rewrite yields an empty terminal page", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    for (let i = 2; i <= 4; i++) commit(repoDir, `commit ${i}`);

    const first = await listCommitHistory(runtime, "main", repoDir, { limit: 2 });
    const cursor = first!.commits[1].sha; // commit 3

    // Rewrite history: drop commits 3-4, add different ones. The cursor still
    // resolves in the object store but is no longer on the branch — paging
    // from it must NOT walk the orphaned pre-rewrite chain.
    git(repoDir, ["reset", "--hard", "HEAD~2"]);
    commit(repoDir, "rewritten A");
    commit(repoDir, "rewritten B");

    const page = await listCommitHistory(runtime, "main", repoDir, { limit: 2, before: cursor });
    expect(page).toEqual({ commits: [], hasMore: false, base: "main" });
  });

  test("an unresolvable base yields no divider instead of failing", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    commit(repoDir, "second");

    const page = await listCommitHistory(runtime, "no-such-branch", repoDir);
    expect(page).not.toBeNull();
    expect(page!.commits.length).toBe(2);
    expect(page!.commits.every((c) => !c.isPastBase)).toBe(true);
  });

  test("rejects a non-hex before cursor", async () => {
    const repoDir = initRepo();
    const runtime = makeRuntime(repoDir);
    expect(await listCommitHistory(runtime, "main", repoDir, { before: "HEAD~1" })).toBeNull();
  });

  test("a repo with no commits yet yields an empty page, not an error", async () => {
    const repoDir = makeTempDir("plannotator-review-core-empty-");
    git(repoDir, ["init"]);
    const runtime = makeRuntime(repoDir);

    const page = await listCommitHistory(runtime, "main", repoDir);
    expect(page).toEqual({ commits: [], hasMore: false, base: "main" });
  });
});
