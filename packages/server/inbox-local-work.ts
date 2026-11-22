/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2; rules and wire in
 * packages/core/inbox-local-work.ts): this computer's work that is in no pull request, and the diff a row opens.
 *
 * - The list (`GET /api/inbox/reviews/local`): for each Inbox project whose folder is here, its local branches with a
 *   commit in the last `INBOX_UNREPORTED_BRANCH_DAYS` days and commits not on the default branch, no open PR and (with
 *   Branch reviews on) no agent's report, the same read as Branch reviews' safety net (`readUnreportedBranches`) with
 *   smaller caps; and its folder's uncommitted changes. Two projects that are folders of one repository (worktrees,
 *   a combined clone) list its branches once.
 * - The diff (`GET /api/inbox/reviews/local/diff`): a branch's whole diff from its merge base with the default branch,
 *   by ref, checked out or not (`readBranchDiff`); or the folder's uncommitted changes as `plannotator review` reads
 *   them (`runGitDiff`'s `uncommitted`).
 * - Never the network, never a write: every git command goes through `offlineGit` (no transport, no prompt, killed
 *   after `BRANCH_GIT_TIMEOUT_MS`) with `GIT_OPTIONAL_LOCKS=0`, so not even `git status` refreshes the index on disk. No
 *   checkout, no stash. A folder that is gone, moved or no repository is skipped before any git runs.
 * - Cost: at most `LOCAL_WORK_PROJECTS_MAX` projects (newest activity first), `LOCAL_WORK_PARALLEL` at a time; per
 *   repository about six commands plus one count per recent branch (no more than `LOCAL_WORK_SCAN_MAX`); one answer
 *   kept `LOCAL_WORK_CACHE_MS` and shared by every read while it is made. Read only when Reviews asks, after its list.
 * - Bun only: the Inbox is.
 */
import { stat } from "node:fs/promises";
import { join } from "node:path";
import type { InboxLocalDiffAnswer, InboxLocalWork, InboxLocalWorkAnswer } from "@plannotator/core/inbox-types";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { getDefaultBranch, runGitDiff, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { branchBaseName, offlineGit, OFFLINE_GIT_TOO_OLD, readBranchDiff, readUnreportedBranches } from "./inbox-branch-reports";

/** The projects read, newest activity first. */
export const LOCAL_WORK_PROJECTS_MAX = 24;
/** Recent branches looked at per repository (one `rev-list --count` each). */
export const LOCAL_WORK_SCAN_MAX = 20;
/** Branches listed per repository, newest first. */
export const LOCAL_WORK_BRANCHES_MAX = 8;
/** Rows in the answer, newest first. */
export const LOCAL_WORK_ROWS_MAX = 60;
/** One answer serves every read this long. */
export const LOCAL_WORK_CACHE_MS = 20_000;
/** Projects read at once. */
export const LOCAL_WORK_PARALLEL = 3;
/** Changed files whose time is read for an uncommitted row's age. */
const LOCAL_WORK_STAT_MAX = 200;

const quiet = new WeakMap<ReviewGitRuntime, ReviewGitRuntime>();

/** `offlineGit` that also takes no optional lock (`git status` writes no refreshed index). One per runtime, so its version check is once. */
export function localWorkGit(runtime: ReviewGitRuntime): ReviewGitRuntime {
  let git = quiet.get(runtime);
  if (!git) {
    git = offlineGit({ ...runtime, runGit: (args, options) => runtime.runGit(args, { ...options, env: { ...options?.env, GIT_OPTIONAL_LOCKS: "0" } }) });
    quiet.set(runtime, git);
  }
  return git;
}

const isFolder = async (root: string) => (await stat(root).catch(() => null))?.isDirectory() === true;

/** The repository a folder is in: its top folder and its common git folder (shared by its worktrees). Null: none here. */
async function repoOf(git: ReviewGitRuntime, root: string): Promise<{ top: string; common: string } | null> {
  if (!(await isFolder(root))) return null;
  const answer = await git.runGit(["rev-parse", "--is-inside-work-tree", "--path-format=absolute", "--show-toplevel", "--git-common-dir"], { cwd: root }).catch(() => null);
  if (answer?.stderr === OFFLINE_GIT_TOO_OLD) throw new Error(OFFLINE_GIT_TOO_OLD);
  if (!answer || answer.exitCode !== 0) return null;
  const [inside, top, common] = answer.stdout.split("\n").map((line) => line.trim());
  return inside === "true" && top && common ? { top, common } : null;
}

/** The branch checked out in a folder, its short commit id when detached, null with no commit and no branch. */
async function checkedOut(git: ReviewGitRuntime, top: string): Promise<string | null> {
  const head = await git.runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd: top });
  if (head.exitCode === 0 && head.stdout.trim()) return head.stdout.trim();
  const sha = await git.runGit(["rev-parse", "--verify", "--quiet", "--short", "HEAD"], { cwd: top });
  return sha.exitCode === 0 ? sha.stdout.trim() || null : null;
}

/** A folder's uncommitted changes as one row, or null when it has none. Its age: the newest change among its files. */
export async function readUncommitted(git: ReviewGitRuntime, top: string, projectId: string, now: number): Promise<InboxLocalWork | null> {
  const status = await git.runGit(["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal", "--ignore-submodules=dirty"], { cwd: top });
  if (status.exitCode !== 0) throw new Error("git couldn't read the changes.");
  const paths = status.stdout
    .split("\0")
    .filter((entry) => entry.length > 3)
    .map((entry) => entry.slice(3));
  if (paths.length === 0) return null;
  let newest = 0;
  await Promise.all(
    paths.slice(0, LOCAL_WORK_STAT_MAX).map(async (file) => {
      const info = await stat(join(top, file)).catch(() => null);
      if (info && info.mtimeMs > newest) newest = info.mtimeMs;
    }),
  );
  return { project_id: projectId, kind: "uncommitted", branch: await checkedOut(git, top), base: null, at: new Date(Math.min(newest || now, now)).toISOString() };
}

export interface InboxLocalWorkOptions {
  runtime: ReviewGitRuntime;
  /** The projects a person sees, newest activity first. */
  projects: () => InboxProject[];
  /** A branch not to list: one with an open PR, or (Branch reviews on) one an agent reported. */
  skip: (projectId: string, branch: string) => boolean;
  now?: () => number;
}

export function createInboxLocalWork(options: InboxLocalWorkOptions) {
  const { runtime } = options;
  const now = options.now ?? Date.now;
  let kept: { at: number; answer: InboxLocalWorkAnswer } | null = null;
  let reading: Promise<InboxLocalWorkAnswer> | null = null;

  const read = async (): Promise<InboxLocalWorkAnswer> => {
    const git = localWorkGit(runtime);
    const at = now();
    const projects = options.projects().slice(0, LOCAL_WORK_PROJECTS_MAX);
    const repos = new Map<string, Promise<void>>();
    const items: InboxLocalWork[] = [];
    let unread = 0;
    const one = async (project: InboxProject) => {
      try {
        const repo = await repoOf(git, project.root);
        if (!repo) return;
        const uncommitted = await readUncommitted(git, repo.top, project.id, at);
        if (uncommitted) items.push(uncommitted);
        // A repository's branches once, under the first of its projects to reach it.
        if (repos.has(repo.common)) return;
        const branches = readUnreportedBranches(git, repo.top, project.id, (branch) => options.skip(project.id, branch), at, { scan: LOCAL_WORK_SCAN_MAX, list: LOCAL_WORK_BRANCHES_MAX }).then(({ branches: found }) => {
          for (const branch of found) items.push({ project_id: project.id, kind: "branch", branch: branch.branch, base: branch.base, at: branch.last_commit_at });
        });
        repos.set(repo.common, branches);
        await branches;
      } catch {
        unread += 1;
      }
    };
    let next = 0;
    await Promise.all(
      Array.from({ length: Math.min(LOCAL_WORK_PARALLEL, projects.length) }, async () => {
        while (next < projects.length) await one(projects[next++]!);
      }),
    );
    items.sort((a, b) => b.at.localeCompare(a.at));
    return { items: items.slice(0, LOCAL_WORK_ROWS_MAX), unread };
  };

  return {
    /** Every project's local work, kept `LOCAL_WORK_CACHE_MS`; one read at a time. */
    async list(): Promise<InboxLocalWorkAnswer> {
      if (kept && now() - kept.at < LOCAL_WORK_CACHE_MS) return kept.answer;
      reading ??= read().then(
        (answer) => {
          kept = { at: now(), answer };
          reading = null;
          return answer;
        },
        (cause: unknown) => {
          reading = null;
          throw cause;
        },
      );
      return reading;
    },
    /**
     * One row's diff, read now: `branch` its whole diff against the default branch, by ref; null the folder's
     * uncommitted changes. Null: the folder is not a repository here. Throws a sentence when git could not read it.
     */
    async diff(project: InboxProject, branch: string | null): Promise<InboxLocalDiffAnswer | null> {
      const git = localWorkGit(runtime);
      const repo = await repoOf(git, project.root);
      if (!repo) return null;
      if (branch) {
        const base = branchBaseName(await getDefaultBranch(git, repo.top));
        const patch = await readBranchDiff(git, repo.top, base, `refs/heads/${branch}`).catch(() => {
          throw new Error(`git couldn't read ${branch}'s diff against ${base} in this project's folder.`);
        });
        return { project_id: project.id, kind: "branch", branch, base, patch };
      }
      const result = await runGitDiff(git, "uncommitted", "HEAD", repo.top);
      if (result.error) throw new Error("git couldn't read the uncommitted changes.");
      return { project_id: project.id, kind: "uncommitted", branch: await checkedOut(git, repo.top), base: "HEAD", patch: result.patch };
    },
  };
}

export type InboxLocalWorkService = ReturnType<typeof createInboxLocalWork>;
