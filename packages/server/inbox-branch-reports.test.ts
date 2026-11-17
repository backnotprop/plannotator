/**
 * Branch reviews' store and git reads (inbox-branch-reports.ts), on a scratch repository. What regresses:
 *  - the latest report per project and branch lost across a restart, or an unreadable file that breaks the Inbox;
 *  - a reported head read as in the checkout when it is not (the thread would offer a review it can't open);
 *  - the safety net listing an old branch, the default branch, a reported one or one with no commits of its own;
 *  - the safety net running anything but local reads (no fetch, no checkout, nothing that writes).
 */
import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ReviewGitRuntime } from "@plannotator/shared/review-core";
import { createInboxBranchReports, readBranchDiff, readReportedBranch, readUnreportedBranches } from "./inbox-branch-reports";
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

/** The real runtime, with every git command it is asked to run written down. */
function watched(): { runtime: ReviewGitRuntime; commands: string[][] } {
  const commands: string[][] = [];
  return {
    commands,
    runtime: {
      ...runtime,
      runGit: (args, options) => {
        commands.push(args);
        return runtime.runGit(args, options);
      },
    },
  };
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
    expect(await readReportedBranch(runtime, repo, { name: "retry-jitter" })).toEqual({ head, base: "main", reachable: true });
    expect(await readReportedBranch(runtime, repo, { name: "retry-jitter", head: head.slice(0, 7) })).toEqual({ head, base: "main", reachable: true });
    const elsewhere = "c".repeat(40);
    expect(await readReportedBranch(runtime, repo, { name: "pushed-elsewhere", head: elsewhere, base: "develop" })).toEqual({ head: elsewhere, base: "develop", reachable: false });
    expect(await readReportedBranch(runtime, mkdtempSync(join(tmpdir(), "not-a-repo-")), { name: "x", head: elsewhere })).toEqual({ head: elsewhere, base: null, reachable: false });
    expect(await readBranchDiff(runtime, repo, "main", head)).toContain("jitter.txt");
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

  test("runs only local reads: nothing that fetches, checks out or writes", async () => {
    const now = Math.floor(Date.now() / 1000);
    const { repo } = scratchRepo(now);
    const before = git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"]);
    const { runtime: seen, commands } = watched();
    await readUnreportedBranches(seen, repo, "prj_1", () => false, now * 1000);
    expect(commands.length).toBeGreaterThan(0);
    const READS = new Set(["rev-parse", "symbolic-ref", "show-ref", "for-each-ref", "rev-list", "worktree", "branch", "config"]);
    for (const args of commands) {
      expect(READS.has(args[0]!)).toBe(true);
      if (args[0] === "worktree") expect(args[1]).toBe("list");
      if (args[0] === "branch") expect(args.every((arg) => !/^-(d|D|m|M|c|C|f)$|^--(delete|move|copy|force|set-upstream)/.test(arg))).toBe(true);
    }
    expect(git(repo, ["for-each-ref", "--format=%(refname) %(objectname)"])).toBe(before);
    expect(git(repo, ["status", "--porcelain"])).toBe("");
  });

  test("a folder that is no repository says so and lists nothing", async () => {
    const read = await readUnreportedBranches(runtime, mkdtempSync(join(tmpdir(), "not-a-repo-")), "prj_1", () => false);
    expect(read).toEqual({ git: false, branches: [] });
  });
});
