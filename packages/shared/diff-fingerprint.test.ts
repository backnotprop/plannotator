import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getGitDiffFingerprint, type ReviewGitRuntime } from "./review-core";

// Real-git runtime against a throwaway repo — fingerprints are only meaningful
// against actual VCS behavior, so no mocks.
const runtime: ReviewGitRuntime = {
  async runGit(args, options) {
    const proc = Bun.spawn(["git", ...args], {
      cwd: options?.cwd,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    const exitCode = await proc.exited;
    return { exitCode, stdout, stderr };
  },
  async readTextFile(path) {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
};

let repo: string;

async function git(...args: string[]): Promise<void> {
  const result = await runtime.runGit(args, { cwd: repo });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

beforeAll(async () => {
  repo = mkdtempSync(join(tmpdir(), "pn-fingerprint-"));
  await git("init", "-b", "main");
  await git("config", "user.email", "test@test");
  await git("config", "user.name", "test");
  writeFileSync(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await git("add", "-A");
  await git("commit", "-m", "init");
});

afterAll(() => {
  rmSync(repo, { recursive: true, force: true });
});

describe("getGitDiffFingerprint", () => {
  test("uncommitted: stable when nothing changes", async () => {
    const a = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    const b = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    expect(a).not.toBeNull();
    expect(a).toBe(b!);
  });

  test("uncommitted: changes when a tracked file is edited — and again on a second edit", async () => {
    const before = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    writeFileSync(join(repo, "a.txt"), "one\nTWO\nthree\n");
    const afterFirstEdit = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    expect(afterFirstEdit).not.toBe(before!);
    // The critical case `git status` alone cannot see: an ALREADY-modified
    // file modified again.
    writeFileSync(join(repo, "a.txt"), "one\nTWO!\nthree\n");
    const afterSecondEdit = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    expect(afterSecondEdit).not.toBe(afterFirstEdit!);
  });

  test("uncommitted: changes when an untracked file appears and when its CONTENT changes", async () => {
    const before = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    writeFileSync(join(repo, "new.txt"), "hello\n");
    const created = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    expect(created).not.toBe(before!);
    writeFileSync(join(repo, "new.txt"), "hello world\n");
    const edited = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    expect(edited).not.toBe(created!);
  });

  test("uncommitted: changes when a commit lands (HEAD moves)", async () => {
    const before = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    await git("add", "-A");
    await git("commit", "-m", "snapshot");
    const after = await getGitDiffFingerprint(runtime, "uncommitted", "main", repo);
    expect(after).not.toBe(before!);
  });

  test("last-commit: stable across working-tree edits, changes on commit", async () => {
    const before = await getGitDiffFingerprint(runtime, "last-commit", "main", repo);
    writeFileSync(join(repo, "a.txt"), "working tree noise\n");
    const duringEdit = await getGitDiffFingerprint(runtime, "last-commit", "main", repo);
    expect(duringEdit).toBe(before!);
    await git("add", "-A");
    await git("commit", "-m", "another");
    const afterCommit = await getGitDiffFingerprint(runtime, "last-commit", "main", repo);
    expect(afterCommit).not.toBe(before!);
  });

  test("merge-base: changes when the branch tip moves", async () => {
    await git("checkout", "-b", "feature");
    writeFileSync(join(repo, "b.txt"), "feature\n");
    await git("add", "-A");
    await git("commit", "-m", "feature work");
    const before = await getGitDiffFingerprint(runtime, "merge-base", "main", repo);
    expect(before).not.toBeNull();
    writeFileSync(join(repo, "b.txt"), "feature 2\n");
    await git("add", "-A");
    await git("commit", "-m", "more feature work");
    const after = await getGitDiffFingerprint(runtime, "merge-base", "main", repo);
    expect(after).not.toBe(before!);
  });

  test("staged: changes when the index changes, not on unstaged edits", async () => {
    const before = await getGitDiffFingerprint(runtime, "staged", "main", repo);
    writeFileSync(join(repo, "a.txt"), "unstaged edit only\n");
    const unstagedOnly = await getGitDiffFingerprint(runtime, "staged", "main", repo);
    expect(unstagedOnly).toBe(before!);
    await git("add", "a.txt");
    const staged = await getGitDiffFingerprint(runtime, "staged", "main", repo);
    expect(staged).not.toBe(before!);
  });

  test("unknown diff type returns null (treated as always-fresh)", async () => {
    const result = await getGitDiffFingerprint(runtime, "p4-default" as never, "main", repo);
    expect(result).toBeNull();
  });
});
