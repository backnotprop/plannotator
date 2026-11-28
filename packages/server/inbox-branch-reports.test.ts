/**
 * Branch reviews' store and git reads (inbox-branch-reports.ts), on a scratch repository. What regresses:
 *  - the latest report per project and branch lost across a restart, or an unreadable file that breaks the Inbox;
 *  - a reported head read as in the checkout when it is not (the thread would offer a review it can't open);
 *  - a cloud agent's report reading a branch's tip here, or its commit counted as pushed when no remote-tracking ref of
 *    the remote it named holds it (its risk would read local, unpushed work);
 *  - the safety net listing an old branch, the default branch, a reported one or one with no commits of its own, or
 *    losing a real branch behind branches with nothing of their own;
 *  - any read running anything but the exact local read-only commands, or without the guards that keep git off the
 *    network (no transport, no lazy fetch), from asking, and short;
 *  - a git too old to take those guards running a read anyway, unguarded, or its version asked on every read;
 *  - a reported commit counted as in what a PR merged when git can't show it is.
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";
import { BRANCH_GIT_TIMEOUT_MS, commitContains, createInboxBranchReports, OFFLINE_GIT_TOO_OLD, offlineGit, offlineGitTooOld, pushedHere, readBranchDiff, readReportedBranch, readUnreportedBranches } from "./inbox-branch-reports";
import { runtime } from "./git";

const DAY = 86_400;

function git(repo: string, args: string[], env: Record<string, string> = {}): string {
  const result = spawnSync("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "-c", "commit.gpgsign=false", ...args], { encoding: "utf-8", env: { ...process.env, ...env } });
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(" ")} failed`);
  return result.stdout.trim();
}

function commitAt(repo: string, file: string, seconds: number): string {
  writeFileSync(join(repo, file), `${file} ${seconds}\n`);
  git(repo, ["add", file]);
  const date = `@${seconds} +0000`;
  git(repo, ["commit", "--quiet", "-m", file], { GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date });
  return git(repo, ["rev-parse", "HEAD"]);
}

/** A repository with main, a recent branch, an old one, one with nothing of its own, and one reported. */
function scratchRepo(now: number) {
  const repo = mkdtempSync(join(tmpdir(), "branch-reviews-"));
  git(repo, ["init", "--quiet", "-b", "main"]);
  commitAt(repo, "base.txt", now - 30 * DAY);
  git(repo, ["checkout", "--quiet", "-b", "retry-jitter"]);
  const head = commitAt(repo, "jitter.txt", now - 2 * DAY);
  git(repo, ["checkout", "--quiet", "main"]);
  git(repo, ["checkout", "--quiet", "-b", "old-spike"]);
  commitAt(repo, "spike.txt", now - 20 * DAY);
  git(repo, ["checkout", "--quiet", "main"]);
  git(repo, ["branch", "same-as-main"]);
  git(repo, ["checkout", "--quiet", "-b", "reported-one"]);
  commitAt(repo, "reported.txt", now - DAY);
  git(repo, ["checkout", "--quiet", "main"]);
  return { repo, head };
}

/** The real runtime, with every git command it is asked to run (and how) written down. */
function watched(): { runtime: ReviewGitRuntime; commands: string[][]; options: Parameters<ReviewGitRuntime["runGit"]>[1][] } {
  const commands: string[][] = [];
  const options: Parameters<ReviewGitRuntime["runGit"]>[1][] = [];
  return {
    commands,
    options,
    runtime: {
      ...runtime,
      runGit: (args, given) => {
        commands.push(args);
        options.push(given);
        return runtime.runGit(args, given);
      },
    },
  };
}

/** The exact read-only commands these reads may run: anything else (a fetch, a checkout, a write) fails. */
const READ_SHAPES: RegExp[] = [
  /^--version$/,
  /^rev-parse --is-inside-work-tree$/,
  /^rev-parse --verify --quiet --end-of-options \S+\^\{commit\}$/,
  /^symbolic-ref refs\/remotes\/origin\/HEAD$/,
  /^show-ref --verify( --quiet)? refs\/(heads|remotes\/origin)\/[\w./-]+$/,
  /^for-each-ref --sort=-committerdate --format=%\(refname\)%00%\(committerdate:unix\)%00%\(objectname\)%00%\(upstream:track\) refs\/heads\/$/,
  /^rev-list --count --end-of-options \S+\.\.refs\/heads\/[\w./-]+$/,
  /^worktree list --porcelain$/,
  /^config --get-regexp -- \^remote\\\.\.\*\\\.url\$$/,
  /^for-each-ref --count=1 --format=%\(refname\) --contains=[0-9a-f]+ refs\/remotes\/[\w.-]+\/$/,
  /^merge-base --is-ancestor --end-of-options [0-9a-f]+ [0-9a-f]+$/,
];
function onlyGuardedReads(seen: ReturnType<typeof watched>) {
  expect(seen.commands.length).toBeGreaterThan(0);
  seen.commands.forEach((args, i) => {
    expect(READ_SHAPES.some((shape) => shape.test(args.join(" ")))).toBe(true);
    const given = seen.options[i];
    expect(given?.interaction).toBe("forbid");
    expect(given?.config?.["protocol.allow"]).toBe("never");
    expect(given?.env?.GIT_NO_LAZY_FETCH).toBe("1");
    expect(given?.timeoutMs).toBeLessThanOrEqual(BRANCH_GIT_TIMEOUT_MS);
  });
}

describe("the reports store", () => {
  test("keeps the latest report per project and branch across a restart, found by its thread", () => {
    const dir = mkdtempSync(join(tmpdir(), "branch-reports-"));
    const one = createInboxBranchReports(dir);
    const report = { project_id: "prj_1", branch: "retry-jitter", base: "main", head: "a".repeat(40), place: "here" as const, remote_url: null, summary: null, thread_id: "01JD0000000000000000000000", message_id: "01JD0000000000000000000000", at: "2026-11-16T10:00:00.000Z", first_at: "2026-11-16T10:00:00.000Z", reports: 1, agent: null };
    one.put(report);
    one.put({ ...report, head: "b".repeat(40), message_id: "01JD0000000000000000000009", reports: 2 });
    const again = createInboxBranchReports(dir);
    expect(again.list()).toHaveLength(1);
    expect(again.get("prj_1", "retry-jitter")).toMatchObject({ head: "b".repeat(40), reports: 2 });
    expect(again.ofThread(report.thread_id)?.branch).toBe("retry-jitter");
    expect(again.get("prj_2", "retry-jitter")).toBeNull();
  });

  test("an unreadable file is moved aside and the store starts empty", () => {
    const dir = mkdtempSync(join(tmpdir(), "branch-reports-"));
    mkdirSync(join(dir, "inbox"), { recursive: true });
    writeFileSync(join(dir, "inbox", "branch-reports.json"), "{ not json");
    expect(createInboxBranchReports(dir).list()).toEqual([]);
    expect(readdirSync(join(dir, "inbox")).some((name) => name.startsWith("branch-reports.json.unreadable-"))).toBe(true);
    expect(existsSync(join(dir, "inbox", "branch-reports.json"))).toBe(false);
  });
});

describe("git for a report", () => {
  test("a branch's tip and the default branch are read when the agent names neither; a head not here is not reachable", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo, head } = scratchRepo(now);
    const seen = watched();
    expect(await readReportedBranch(seen.runtime, repo, { name: "retry-jitter" })).toEqual({ head, base: "main", reachable: true, defaultBranch: "main" });
    onlyGuardedReads(seen);
    expect(await readReportedBranch(runtime, repo, { name: "retry-jitter", head: head.slice(0, 7) })).toEqual({ head, base: "main", reachable: true, defaultBranch: "main" });
    const elsewhere = "c".repeat(40);
    expect(await readReportedBranch(runtime, repo, { name: "pushed-elsewhere", head: elsewhere, base: "develop" })).toEqual({ head: elsewhere, base: "develop", reachable: false, defaultBranch: "main" });
    expect(await readReportedBranch(runtime, mkdtempSync(join(tmpdir(), "not-a-repo-")), { name: "x", head: elsewhere })).toEqual({ head: elsewhere, base: null, reachable: false, defaultBranch: null });
    expect(await readBranchDiff(runtime, repo, "main", head)).toContain("jitter.txt");
  });

  test("a cloud agent's report never reads a branch's tip here", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo } = scratchRepo(now);
    const seen = watched();
    expect(await readReportedBranch(seen.runtime, repo, { name: "retry-jitter" }, { localTip: false })).toEqual({ head: null, base: "main", reachable: false, defaultBranch: "main" });
    expect(seen.commands.some((args) => args.some((arg) => arg.includes("retry-jitter")))).toBe(false);
  });

  test("a commit counts as pushed only when a remote-tracking ref of the remote it named holds it", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo, head } = scratchRepo(now);
    git(repo, ["remote", "add", "origin", "git@github.com:acme/app.git"]);
    git(repo, ["remote", "add", "fork", "https://github.com/someone/app.git"]);
    // Only on this computer: no remote-tracking ref holds it.
    expect(await pushedHere(runtime, repo, head, "https://github.com/acme/app.git")).toBe(false);
    git(repo, ["update-ref", "refs/remotes/fork/retry-jitter", head]);
    // Held by another remote's ref: not the one the agent named.
    expect(await pushedHere(runtime, repo, head, "https://github.com/acme/app.git")).toBe(false);
    git(repo, ["update-ref", "refs/remotes/origin/retry-jitter", head]);
    const seen = watched();
    // The same repository in another form (https for an ssh remote), and a short id.
    expect(await pushedHere(seen.runtime, repo, head.slice(0, 12), "https://github.com/acme/app.git")).toBe(true);
    onlyGuardedReads(seen);
    expect(await pushedHere(runtime, repo, head, null)).toBe(false);
    expect(await pushedHere(runtime, repo, head, "https://evil.example/acme/app.git")).toBe(false);
  });

  test("a reported commit is in what merged only when git here shows it; a commit not here answers nothing", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo, head } = scratchRepo(now);
    const base = git(repo, ["rev-parse", "main"]);
    const seen = watched();
    expect(await commitContains(seen.runtime, repo, base, head)).toBe(true);
    expect(await commitContains(seen.runtime, repo, head, base)).toBe(false);
    onlyGuardedReads(seen);
    expect(await commitContains(runtime, repo, head, "e".repeat(40))).toBeNull();
    expect(await commitContains(runtime, repo, "--all", head)).toBeNull();
    expect(await commitContains(runtime, null, head, base)).toBeNull();
  });
});

describe("the safety net: branches nobody reported", () => {
  test("lists recent branches with commits of their own, newest first, never the default, an old, a skipped or an empty one", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo } = scratchRepo(now);
    const read = await readUnreportedBranches(runtime, repo, "prj_1", (branch) => branch === "reported-one", now * 1000);
    expect(read.git).toBe(true);
    expect(read.branches.map((b) => [b.branch, b.base, b.ahead])).toEqual([["retry-jitter", "main", 1]]);
  });

  test("runs only the exact local read-only commands, each kept off the network and short", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo } = scratchRepo(now);
    const before = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const seen = watched();
    await readUnreportedBranches(seen.runtime, repo, "prj_1", () => false, now * 1000);
    onlyGuardedReads(seen);
    expect(git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  test("counts its 30 after dropping branches with nothing of their own", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo } = scratchRepo(now);
    // Newer than every real branch, and with nothing of their own: once they filled the list.
    commitAt(repo, "fresh.txt", now - 3600);
    for (let i = 0; i < 35; i++) git(repo, ["branch", `empty-${i}`]);
    const read = await readUnreportedBranches(runtime, repo, "prj_1", () => false, now * 1000);
    expect(read.branches.map((b) => b.branch)).toEqual(["reported-one", "retry-jitter"]);
  });

  test("a folder that is no repository says so and lists nothing", async () => {
    const read = await readUnreportedBranches(runtime, mkdtempSync(join(tmpdir(), "not-a-repo-")), "prj_1", () => false);
    expect(read).toEqual({ git: false, branches: [] });
  });
});

describe("a git too old for the guards", () => {
  test("runs nothing but its version check: every read fails closed", async () => {
    const asked: string[][] = [];
    const old: ReviewGitRuntime = {
      ...runtime,
      runGit: async (args) => {
        asked.push(args);
        return args[0] === "--version" ? { stdout: "git version 2.30.9\n", stderr: "", exitCode: 0 } : { stdout: "should not run", stderr: "", exitCode: 0 };
      },
    };
    const answer = await offlineGit(old).runGit(["rev-parse", "--is-inside-work-tree"], { cwd: "/tmp" });
    expect(answer).toMatchObject({ exitCode: 1, stderr: OFFLINE_GIT_TOO_OLD });
    expect(await readReportedBranch(old, "/tmp", { name: "retry-jitter" })).toMatchObject({ head: null, reachable: false });
    await expect(readUnreportedBranches(old, "/tmp", "prj_1", () => false)).rejects.toThrow(OFFLINE_GIT_TOO_OLD);
    expect(asked.every((args) => args[0] === "--version")).toBe(true);
    // Asked once for the process, not again on each read.
    expect(asked).toHaveLength(1);
    expect(await offlineGitTooOld(old)).toBe(true);
    expect(await offlineGitTooOld(runtime)).toBe(false);
  });
});
