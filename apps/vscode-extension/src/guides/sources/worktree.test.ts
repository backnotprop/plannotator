/**
 * PR worktrees against real git repositories in a temp folder (an "origin"
 * with `refs/pull/<n>/head`, and the user's clone): one worktree per PR head,
 * never moved under another reader, no `git worktree prune`, no ref of the
 * user's moved by a fetch, and nothing removed outside the extension's storage.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultRunner, type Runner } from "./runner";
import { ensureWorktreeAt, preparePullRequestWorktree, pullRequestWorktreePath, removePullRequestWorktree } from "./github";

let work: string;
let user: string;
let storage: string;
const shas: Record<string, string> = {};

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).trim();
}

const calls: string[] = [];
const runner: Runner = (command, args, options) => {
  calls.push(`${command} ${args.join(" ")}`);
  return defaultRunner(command, args, { ...options, env: { ...options?.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } });
};

beforeAll(() => {
  work = mkdtempSync(join(tmpdir(), "pn-guides-wt-"));
  const origin = join(work, "origin");
  git(work, "init", "-q", "-b", "main", origin);
  git(origin, "commit", "-q", "--allow-empty", "-m", "base");
  shas.base = git(origin, "rev-parse", "HEAD");
  git(origin, "checkout", "-q", "-b", "feat");
  git(origin, "commit", "-q", "--allow-empty", "-m", "pr one");
  shas.head1 = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", shas.head1);
  git(origin, "checkout", "-q", "main");
  git(work, "clone", "-q", origin, join(work, "user"));
  user = join(work, "user");
  // After the clone: the PR gets a new head and main moves on, so both must be fetched.
  git(origin, "checkout", "-q", "feat");
  git(origin, "commit", "-q", "--allow-empty", "-m", "pr two");
  shas.head2 = git(origin, "rev-parse", "HEAD");
  git(origin, "update-ref", "refs/pull/7/head", shas.head2);
  git(origin, "checkout", "-q", "main");
  git(origin, "commit", "-q", "--allow-empty", "-m", "main moves");
  shas.main2 = git(origin, "rev-parse", "HEAD");
  storage = join(work, "storage");
});

afterAll(() => {
  rmSync(work, { recursive: true, force: true });
});

const repo = () => ({ root: user, repoKey: "key" }) as Parameters<typeof preparePullRequestWorktree>[1];
const pr = (headRefOid: string, baseRefOid: string) => ({ number: 7, title: "t", url: "u", body: "", author: "a", headRefName: "feat", headRefOid, baseRefName: "main", baseRefOid });

describe("PR worktrees", () => {
  it("fetches the head and base without moving the user's refs, into a worktree named by the head", async () => {
    const originMain = git(user, "rev-parse", "origin/main");
    const refsBefore = git(user, "for-each-ref", "--format=%(refname) %(objectname)");
    const wt = await preparePullRequestWorktree(runner, repo(), pr(shas.head2, shas.main2), storage);
    expect(wt.path).toBe(pullRequestWorktreePath(storage, "key", 7, shas.head2));
    expect(wt.path.endsWith(`pr-7-${shas.head2.slice(0, 7)}`)).toBe(true);
    expect(git(wt.path, "rev-parse", "HEAD")).toBe(shas.head2);
    // origin/main and every other ref of the user's are where they were; no private ref is left.
    expect(git(user, "rev-parse", "origin/main")).toBe(originMain);
    expect(git(user, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(refsBefore);
    expect(calls.some((c) => /worktree prune/.test(c))).toBe(false);
  });

  it("falls back to a private ref for the base when the sha cannot be fetched, and removes it", async () => {
    const before = git(user, "for-each-ref", "--format=%(refname) %(objectname)");
    // A base sha the origin does not have: the branch is fetched into a private ref instead.
    const wt = await preparePullRequestWorktree(runner, repo(), pr(shas.head2, "0".repeat(40)), storage);
    expect(wt.mergeBase).toBe(shas.base);
    expect(git(user, "for-each-ref", "--format=%(refname) %(objectname)")).toBe(before);
  });

  it("gives an older head its own worktree and never moves the newer one", async () => {
    const newer = pullRequestWorktreePath(storage, "key", 7, shas.head2);
    const older = pullRequestWorktreePath(storage, "key", 7, shas.head1);
    const r = await ensureWorktreeAt(runner, user, older, shas.head1, storage);
    expect(r.ok).toBe(true);
    expect(git(older, "rev-parse", "HEAD")).toBe(shas.head1);
    expect(git(newer, "rev-parse", "HEAD")).toBe(shas.head2);
  });

  it("re-adds a worktree whose folder was deleted, without pruning the user's worktrees", async () => {
    const path = pullRequestWorktreePath(storage, "key", 7, shas.head1);
    rmSync(path, { recursive: true, force: true });
    calls.length = 0;
    const r = await ensureWorktreeAt(runner, user, path, shas.head1, storage);
    expect(r.ok).toBe(true);
    expect(git(path, "rev-parse", "HEAD")).toBe(shas.head1);
    expect(calls.some((c) => /worktree prune/.test(c))).toBe(false);
  });

  it("refuses to create or remove a worktree outside the extension's storage", async () => {
    const outside = join(work, "elsewhere");
    expect((await ensureWorktreeAt(runner, user, outside, shas.head1, storage)).ok).toBe(false);
    expect(existsSync(outside)).toBe(false);
    expect(await removePullRequestWorktree(runner, user, user, storage)).toBe(false);
    expect(existsSync(join(user, ".git"))).toBe(true);
  });

  it("removes its own worktree", async () => {
    const path = pullRequestWorktreePath(storage, "key", 7, shas.head1);
    expect(await removePullRequestWorktree(runner, user, path, storage)).toBe(true);
    expect(existsSync(path)).toBe(false);
    expect(existsSync(pullRequestWorktreePath(storage, "key", 7, shas.head2))).toBe(true);
  });
});
