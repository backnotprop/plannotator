/**
 * Branch reviews (docs/agent-guides/inbox-files-and-guides.md, "Branch reviews"; rules in
 * packages/core/inbox-branch-reports.ts). An agent that finished work on a branch says so with `send_message`'s
 * `branch` field; this module keeps the latest report per project and branch and reads git for it.
 *
 *   inbox/branch-reports.json   { v: 1, reports: { [project id \0 branch]: InboxBranchReport } }
 *
 * - Nothing here runs on a timer. A report is read once when it arrives (its head, its base, whether the commit is in
 *   the project's checkout here); the by-hand list of branches nobody reported is read only when the person opens it.
 * - Every git command is local (no fetch, no network), with no way to ask anything (`interaction: "forbid"`), in the
 *   project's own folder, killed after `BRANCH_GIT_TIMEOUT_MS`.
 * - Bun only: the Inbox is.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  INBOX_BRANCH_REPORTS_MAX,
  INBOX_UNREPORTED_BRANCH_DAYS,
  INBOX_UNREPORTED_BRANCHES_MAX,
  inboxBranchReportKey,
  type InboxBranchReport,
  type InboxUnreportedBranch,
} from "@plannotator/core/inbox-branch-reports";
import { inboxPullLongLived, inboxPullSafeBranch } from "@plannotator/core/inbox-types";
import { getDefaultBranch, getWorktrees, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { inboxDir } from "@plannotator/shared/inbox/schema";

export const INBOX_BRANCH_REPORTS_FILE = "branch-reports.json";
/** One git command of a report's read or the safety net's. */
export const BRANCH_GIT_TIMEOUT_MS = 5_000;
/** A reported branch's diff, read for its risk run, no further than this (as a PR clone's diff). */
export const BRANCH_DIFF_MAX_BYTES = 8 * 1024 * 1024;

export interface InboxBranchReports {
  get(projectId: string, branch: string): InboxBranchReport | null;
  /** By thread: a thread is one branch's. */
  ofThread(threadId: string): InboxBranchReport | null;
  list(): InboxBranchReport[];
  put(report: InboxBranchReport): void;
}

/** The reports on disk: the latest per project and branch. An unreadable file is moved aside and starts empty. */
export function createInboxBranchReports(dataDir: string): InboxBranchReports {
  const dir = inboxDir(dataDir);
  const file = join(dir, INBOX_BRANCH_REPORTS_FILE);
  let all: Map<string, InboxBranchReport> | null = null;
  const load = (): Map<string, InboxBranchReport> => {
    if (all) return all;
    all = new Map();
    if (!existsSync(file)) return all;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { v?: unknown; reports?: Record<string, InboxBranchReport> };
      if (parsed.v !== 1 || !parsed.reports || typeof parsed.reports !== "object") throw new Error("not a reports file");
      for (const report of Object.values(parsed.reports)) {
        if (isReport(report)) all.set(inboxBranchReportKey(report.project_id, report.branch), report);
      }
    } catch {
      try {
        renameSync(file, `${file}.unreadable-${Date.now()}`);
      } catch {
        // Reports come again with the agents' next ones.
      }
    }
    return all;
  };
  const save = () => {
    const map = load();
    mkdirSync(dir, { recursive: true });
    const temp = `${file}.${process.pid}.tmp`;
    writeFileSync(temp, `${JSON.stringify({ v: 1, reports: Object.fromEntries(map) })}\n`, { mode: 0o600 });
    renameSync(temp, file);
  };
  return {
    get: (projectId, branch) => load().get(inboxBranchReportKey(projectId, branch)) ?? null,
    ofThread: (threadId) => [...load().values()].reverse().find((report) => report.thread_id === threadId) ?? null,
    list: () => [...load().values()],
    put(report) {
      const map = load();
      const key = inboxBranchReportKey(report.project_id, report.branch);
      map.delete(key);
      map.set(key, report);
      while (map.size > INBOX_BRANCH_REPORTS_MAX) map.delete(map.keys().next().value!);
      save();
    },
  };
}

function isReport(value: unknown): value is InboxBranchReport {
  const r = value as InboxBranchReport | null;
  return (
    !!r &&
    typeof r === "object" &&
    typeof r.project_id === "string" &&
    typeof r.branch === "string" &&
    inboxPullSafeBranch(r.branch) &&
    typeof r.thread_id === "string" &&
    typeof r.message_id === "string" &&
    typeof r.at === "string" &&
    (r.place === "here" || r.place === "cloud")
  );
}

const git = (runtime: ReviewGitRuntime, root: string, args: string[]) => runtime.runGit(args, { cwd: root, interaction: "forbid", timeoutMs: BRANCH_GIT_TIMEOUT_MS });

/** A commit id when `ref` names one in this repository, else null. */
async function commitOf(runtime: ReviewGitRuntime, root: string, ref: string): Promise<string | null> {
  if (ref.startsWith("-")) return null;
  const answer = await git(runtime, root, ["rev-parse", "--verify", "--quiet", "--end-of-options", `${ref}^{commit}`]);
  const sha = answer.exitCode === 0 ? answer.stdout.trim() : "";
  return /^[0-9a-f]{40,64}$/.test(sha) ? sha : null;
}

/** The base as words: `origin/main` reads `main`. */
export function branchBaseName(ref: string): string {
  return ref.replace(/^origin\//, "");
}

/**
 * What git here says of a reported branch: its head (the agent's, else the branch's tip here), its base (the agent's,
 * else the repository's default branch) and whether the head is a commit in this checkout. Never throws: a folder that
 * is no repository reads as nothing here.
 */
export async function readReportedBranch(runtime: ReviewGitRuntime, root: string | null, input: { name: string; base?: string; head?: string }): Promise<{ head: string | null; base: string | null; reachable: boolean }> {
  if (!root) return { head: input.head ?? null, base: input.base ?? null, reachable: false };
  try {
    const inside = await git(runtime, root, ["rev-parse", "--is-inside-work-tree"]);
    if (inside.exitCode !== 0) return { head: input.head ?? null, base: input.base ?? null, reachable: false };
    const tip = (await commitOf(runtime, root, `refs/heads/${input.name}`)) ?? (await commitOf(runtime, root, `refs/remotes/origin/${input.name}`));
    const named = input.head ? await commitOf(runtime, root, input.head) : null;
    const head = named ?? input.head ?? tip;
    const base = input.base ?? branchBaseName(await getDefaultBranch(runtime, root));
    return { head, base, reachable: !!(named ?? (input.head ? null : tip)) };
  } catch {
    return { head: input.head ?? null, base: input.base ?? null, reachable: false };
  }
}

/** Whether a reported head is a commit here (read again when the list is: a fetch may have brought it). */
export async function branchHeadHere(runtime: ReviewGitRuntime, root: string | null, head: string | null): Promise<boolean> {
  if (!root || !head) return false;
  try {
    return (await commitOf(runtime, root, head)) !== null;
  } catch {
    return false;
  }
}

/** The ref a base names here: the local branch, else origin's. Null when neither is a commit. */
async function baseRef(runtime: ReviewGitRuntime, root: string, base: string): Promise<string | null> {
  if (await commitOf(runtime, root, base)) return base;
  if (await commitOf(runtime, root, `origin/${base}`)) return `origin/${base}`;
  return null;
}

/** A reported branch's whole diff from its merge base with the base to its head, for its risk run. Throws a sentence. */
export async function readBranchDiff(runtime: ReviewGitRuntime, root: string, base: string, head: string): Promise<string> {
  const ref = await baseRef(runtime, root, base);
  if (!ref) throw new Error(`The base ${base} isn't in the project's checkout on this computer.`);
  if (!(await commitOf(runtime, root, head))) throw new Error("The reported commit isn't in the project's checkout on this computer.");
  const answer = await runtime.runGit(["diff", "--no-ext-diff", "--no-textconv", "--no-relative", "--no-color", "--end-of-options", `${ref}...${head}`], {
    cwd: root,
    interaction: "forbid",
    timeoutMs: 5 * 60_000,
    maxOutputBytes: BRANCH_DIFF_MAX_BYTES,
  });
  if (answer.exitCode !== 0) throw new Error("git couldn't read the branch's diff.");
  return answer.stdout;
}

/**
 * The safety net: local branches with a commit in the last `INBOX_UNREPORTED_BRANCH_DAYS` days and commits not on the
 * default branch, newest first, at most `INBOX_UNREPORTED_BRANCHES_MAX`, each with the worktree it is checked out in.
 * `skip`: branches reported or with an open PR. Read only, when the person opens the list.
 */
export async function readUnreportedBranches(
  runtime: ReviewGitRuntime,
  root: string,
  projectId: string,
  skip: (branch: string) => boolean,
  now: number = Date.now(),
): Promise<{ git: boolean; branches: InboxUnreportedBranch[] }> {
  const inside = await git(runtime, root, ["rev-parse", "--is-inside-work-tree"]).catch(() => null);
  if (!inside || inside.exitCode !== 0) return { git: false, branches: [] };
  const baseRefName = await getDefaultBranch(runtime, root);
  const base = branchBaseName(baseRefName);
  const listed = await git(runtime, root, ["for-each-ref", "--sort=-committerdate", "--format=%(refname:short)%00%(committerdate:unix)", "refs/heads"]);
  if (listed.exitCode !== 0) return { git: true, branches: [] };
  const since = now / 1000 - INBOX_UNREPORTED_BRANCH_DAYS * 86_400;
  const candidates: { branch: string; at: number }[] = [];
  for (const line of listed.stdout.split("\n")) {
    const [branch, at] = line.split("\u0000");
    const seconds = Number(at);
    if (!branch || !Number.isFinite(seconds) || seconds < since) continue;
    if (!inboxPullSafeBranch(branch) || inboxPullLongLived(branch) || branch === base || skip(branch)) continue;
    candidates.push({ branch, at: seconds });
    if (candidates.length >= INBOX_UNREPORTED_BRANCHES_MAX) break;
  }
  if (candidates.length === 0) return { git: true, branches: [] };
  const worktrees = await getWorktrees(runtime, root).catch(() => []);
  const checkedOut = new Map(worktrees.flatMap((tree) => (tree.branch ? [[tree.branch, tree.path] as const] : [])));
  const branches: InboxUnreportedBranch[] = [];
  for (const { branch, at } of candidates) {
    const ahead = await git(runtime, root, ["rev-list", "--count", "--end-of-options", `${baseRefName}..refs/heads/${branch}`]).catch(() => null);
    const count = ahead && ahead.exitCode === 0 ? Number(ahead.stdout.trim()) : 0;
    if (!Number.isFinite(count) || count <= 0) continue;
    branches.push({ project_id: projectId, branch, base, ahead: count, last_commit_at: new Date(at * 1000).toISOString(), worktree: checkedOut.get(branch) ?? null });
  }
  return { git: true, branches };
}
