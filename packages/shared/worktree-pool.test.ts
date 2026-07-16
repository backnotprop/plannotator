import { describe, expect, test } from "bun:test";
import type { ReviewGitRuntime } from "./review-core";
import type { PRMetadata } from "./pr-types";
import { createWorktreePool } from "./worktree-pool";

function fakeRuntime(): { runtime: ReviewGitRuntime; commands: string[][] } {
  const commands: string[][] = [];
  const runtime: ReviewGitRuntime = {
    async runGit(args) {
      commands.push(args);
      return { stdout: "", stderr: "", exitCode: 0 };
    },
    async readTextFile() { return null; },
  };
  return { runtime, commands };
}

function makeMetadata(number: number, baseBranch = "main"): PRMetadata {
  return {
    platform: "github",
    host: "github.com",
    owner: "acme",
    repo: "widgets",
    number,
    title: `PR #${number}`,
    author: "alice",
    baseBranch,
    headBranch: `feature/pr-${number}`,
    baseSha: "abc123def456abc123def456abc123def456abc1",
    headSha: "def456abc123def456abc123def456abc123def4",
    url: `https://github.com/acme/widgets/pull/${number}`,
  };
}

describe("worktree-pool", () => {
  test("resolve returns undefined for unknown PR", () => {
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });
    expect(pool.resolve("https://github.com/acme/widgets/pull/99")).toBeUndefined();
  });

  test("resolve returns path for ready entry", () => {
    const initial = { path: "/tmp/session/pool/pr-3", prUrl: "https://github.com/acme/widgets/pull/3", number: 3, ready: true };
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true }, initial);
    expect(pool.resolve("https://github.com/acme/widgets/pull/3")).toBe("/tmp/session/pool/pr-3");
  });

  test("has returns true for existing entry", () => {
    const initial = { path: "/tmp/session/pool/pr-3", prUrl: "https://github.com/acme/widgets/pull/3", number: 3, ready: true };
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true }, initial);
    expect(pool.has("https://github.com/acme/widgets/pull/3")).toBe(true);
    expect(pool.has("https://github.com/acme/widgets/pull/99")).toBe(false);
  });

  test("ensure creates worktree on first call", async () => {
    const { runtime, commands } = fakeRuntime();
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });

    const entry = await pool.ensure(runtime, makeMetadata(5));

    expect(entry.path).toBe("/tmp/session/pool/pr-5");
    expect(entry.prUrl).toBe("https://github.com/acme/widgets/pull/5");
    expect(entry.number).toBe(5);
    expect(entry.ready).toBe(true);

    // Verify fetch order: baseBranch → baseSha → PR head → worktree add
    expect(commands[0]).toEqual(["fetch", "origin", "--", "main"]);
    expect(commands[1][0]).toBe("cat-file"); // ensureObjectAvailable check
    expect(commands[2]).toEqual(["fetch", "origin", "--", "refs/pull/5/head"]);
    expect(commands[3]).toEqual(["worktree", "add", "--detach", "/tmp/session/pool/pr-5", "FETCH_HEAD"]);
  });

  test("ensure returns cached entry on second call", async () => {
    const { runtime, commands } = fakeRuntime();
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });

    await pool.ensure(runtime, makeMetadata(5));
    const commandCountAfterFirst = commands.length;

    const second = await pool.ensure(runtime, makeMetadata(5));
    expect(second.path).toBe("/tmp/session/pool/pr-5");
    expect(commands.length).toBe(commandCountAfterFirst); // No new git commands
  });

  test("ensure creates separate entries for different PRs", async () => {
    const { runtime } = fakeRuntime();
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });

    const a = await pool.ensure(runtime, makeMetadata(3));
    const b = await pool.ensure(runtime, makeMetadata(4, "feature/pr-3"));

    expect(a.path).toBe("/tmp/session/pool/pr-3");
    expect(b.path).toBe("/tmp/session/pool/pr-4");
    expect(pool.resolve(a.prUrl)).toBe(a.path);
    expect(pool.resolve(b.prUrl)).toBe(b.path);
  });

  test("cross-repo pool returns matching entry", async () => {
    const { runtime } = fakeRuntime();
    const initial = { path: "/tmp/session/pool/pr-3", prUrl: "https://github.com/acme/widgets/pull/3", number: 3, ready: true };
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: false }, initial);

    const entry = await pool.ensure(runtime, makeMetadata(3));
    expect(entry.path).toBe("/tmp/session/pool/pr-3");
  });

  test("cross-repo pool rejects different PR", async () => {
    const { runtime } = fakeRuntime();
    const initial = { path: "/tmp/session/pool/pr-3", prUrl: "https://github.com/acme/widgets/pull/3", number: 3, ready: true };
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: false }, initial);

    await expect(pool.ensure(runtime, makeMetadata(5))).rejects.toThrow("Cross-repo pool cannot create worktrees for other PRs");
  });

  test("cross-repo pool throws when empty", async () => {
    const { runtime } = fakeRuntime();
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: false });

    await expect(pool.ensure(runtime, makeMetadata(5))).rejects.toThrow("Cross-repo pool cannot create worktrees for other PRs");
  });

  test("cleanup removes all entries", async () => {
    const { runtime, commands } = fakeRuntime();
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });

    await pool.ensure(runtime, makeMetadata(3));
    await pool.ensure(runtime, makeMetadata(4, "feature/pr-3"));
    commands.length = 0; // Reset

    await pool.cleanup(runtime);

    expect(pool.has("https://github.com/acme/widgets/pull/3")).toBe(false);
    expect(pool.has("https://github.com/acme/widgets/pull/4")).toBe(false);
    // Should have called worktree remove for both
    const removeCommands = commands.filter(c => c[0] === "worktree" && c[1] === "remove");
    expect(removeCommands.length).toBe(2);
  });

  test("GitLab MR uses correct ref format", async () => {
    const { runtime, commands } = fakeRuntime();
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });

    const glMetadata: PRMetadata = {
      platform: "gitlab",
      host: "gitlab.com",
      projectPath: "group/project",
      iid: 42,
      title: "MR !42",
      author: "bob",
      baseBranch: "main",
      headBranch: "feature/fix",
      baseSha: "abc123def456abc123def456abc123def456abc1",
      headSha: "def456abc123def456abc123def456abc123def4",
      url: "https://gitlab.com/group/project/-/merge_requests/42",
    };

    const entry = await pool.ensure(runtime, glMetadata);
    expect(entry.path).toBe("/tmp/session/pool/pr-42");

    const fetchPRHead = commands.find(c => c[0] === "fetch" && c[2] === "--" && c[3]?.includes("merge-requests"));
    expect(fetchPRHead?.[3]).toBe("refs/merge-requests/42/head");
  });
});

// --- Seeded background warmup (non-blocking PR checkout) ---------------------

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

const PR3_URL = "https://github.com/acme/widgets/pull/3";

function notReadyInitial() {
  return { path: "/tmp/session/pool/pr-3", prUrl: PR3_URL, number: 3, ready: false };
}

describe("worktree-pool seeded warmup", () => {
  test("resolve returns undefined while the warmup is in flight, then the path once it lands", async () => {
    const warmup = deferred<{ path: string; prUrl: string; number: number; ready: boolean }>();
    const pool = createWorktreePool(
      { sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true },
      notReadyInitial(),
      warmup.promise,
    );

    expect(pool.resolve(PR3_URL)).toBeUndefined();
    expect(pool.has(PR3_URL)).toBe(true); // entry exists — consumers can distinguish "warming up" from "unknown"

    warmup.resolve({ path: "/tmp/session/pool/pr-3", prUrl: PR3_URL, number: 3, ready: true });
    await warmup.promise;
    await Bun.sleep(0); // let the pool's bookkeeping handlers run

    expect(pool.resolve(PR3_URL)).toBe("/tmp/session/pool/pr-3");
    expect(pool.get(PR3_URL)?.ready).toBe(true);
  });

  test("ensure during warmup awaits the seeded promise instead of starting a duplicate creation", async () => {
    const { runtime, commands } = fakeRuntime();
    const warmup = deferred<{ path: string; prUrl: string; number: number; ready: boolean }>();
    const pool = createWorktreePool(
      { sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true },
      notReadyInitial(),
      warmup.promise,
    );

    const ensured = pool.ensure(runtime, makeMetadata(3));
    await Bun.sleep(0);
    expect(commands.length).toBe(0); // no parallel creation kicked off

    warmup.resolve({ path: "/tmp/session/pool/pr-3", prUrl: PR3_URL, number: 3, ready: true });
    const entry = await ensured;

    expect(entry.path).toBe("/tmp/session/pool/pr-3");
    expect(entry.ready).toBe(true);
    expect(commands.length).toBe(0); // creation was the warmup's job, not ensure's
  });

  test("failed warmup keeps the entry not-ready so resolve never hands out the dead path", async () => {
    const warmup = deferred<{ path: string; prUrl: string; number: number; ready: boolean }>();
    const pool = createWorktreePool(
      { sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true },
      notReadyInitial(),
      warmup.promise,
    );

    warmup.reject(new Error("network down"));
    await Bun.sleep(0);

    expect(pool.resolve(PR3_URL)).toBeUndefined();
    expect(pool.has(PR3_URL)).toBe(true);
  });

  test("same-repo ensure retries creation after a failed warmup", async () => {
    const { runtime, commands } = fakeRuntime();
    const warmup = deferred<{ path: string; prUrl: string; number: number; ready: boolean }>();
    const pool = createWorktreePool(
      { sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true },
      notReadyInitial(),
      warmup.promise,
    );

    warmup.reject(new Error("network down"));
    await Bun.sleep(0);

    const entry = await pool.ensure(runtime, makeMetadata(3));

    expect(entry.ready).toBe(true);
    expect(pool.resolve(PR3_URL)).toBe("/tmp/session/pool/pr-3");
    // The retry ran the full creation sequence itself this time.
    expect(commands.some(c => c[0] === "worktree" && c[1] === "add")).toBe(true);
  });

  test("cross-repo ensure rejects after a failed warmup — pool cannot rebuild a clone", async () => {
    const { runtime } = fakeRuntime();
    const warmup = deferred<{ path: string; prUrl: string; number: number; ready: boolean }>();
    const pool = createWorktreePool(
      { sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: false },
      notReadyInitial(),
      warmup.promise,
    );

    warmup.reject(new Error("clone failed"));
    await Bun.sleep(0);

    await expect(pool.ensure(runtime, makeMetadata(3))).rejects.toThrow();
  });

  test("creation for another PR queues behind the in-flight warmup (FETCH_HEAD serialization)", async () => {
    const { runtime, commands } = fakeRuntime();
    const warmup = deferred<{ path: string; prUrl: string; number: number; ready: boolean }>();
    const pool = createWorktreePool(
      { sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true },
      notReadyInitial(),
      warmup.promise,
    );

    // pr-switch arrives while the initial checkout is still being fetched
    const switched = pool.ensure(runtime, makeMetadata(5));
    await Bun.sleep(0);
    expect(commands.length).toBe(0); // PR #5's fetch must not clobber the warmup's FETCH_HEAD

    warmup.resolve({ path: "/tmp/session/pool/pr-3", prUrl: PR3_URL, number: 3, ready: true });
    const entry = await switched;

    expect(entry.path).toBe("/tmp/session/pool/pr-5");
    expect(commands[commands.length - 1]).toEqual(["worktree", "add", "--detach", "/tmp/session/pool/pr-5", "FETCH_HEAD"]);
  });

  test("concurrent creations for different PRs never interleave their git commands", async () => {
    // Runtime that yields between commands — interleaving would surface here
    // if creations ran concurrently instead of through the serialization chain.
    const commands: string[][] = [];
    const runtime: ReviewGitRuntime = {
      async runGit(args) {
        await Bun.sleep(1);
        commands.push(args);
        return { stdout: "", stderr: "", exitCode: 0 };
      },
      async readTextFile() { return null; },
    };
    const pool = createWorktreePool({ sessionDir: "/tmp/session", repoDir: "/repo", isSameRepo: true });

    const [a, b] = await Promise.all([
      pool.ensure(runtime, makeMetadata(3)),
      pool.ensure(runtime, makeMetadata(4, "feature/pr-3")),
    ]);

    expect(a.path).toBe("/tmp/session/pool/pr-3");
    expect(b.path).toBe("/tmp/session/pool/pr-4");

    // PR #3's entire sequence (ending in worktree add) must complete before
    // any PR #4 command runs.
    const firstPr4Index = commands.findIndex(c => c.join(" ").includes("pr-4") || c.join(" ").includes("refs/pull/4"));
    const pr3AddIndex = commands.findIndex(c => c[0] === "worktree" && c[3] === "/tmp/session/pool/pr-3");
    expect(pr3AddIndex).toBeGreaterThanOrEqual(0);
    expect(firstPr4Index).toBeGreaterThan(pr3AddIndex);
  });
});
