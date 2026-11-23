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
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { InboxLocalDiffAnswer, InboxLocalWork, InboxLocalWorkAnswer } from "@plannotator/core/inbox-types";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { inboxPullIsOpen, inboxPullRepoKey, type InboxPull } from "@plannotator/core/inbox-types";
import { getDefaultBranch, runGitDiff, type GitCommandOptions, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { BranchDiffTooLarge, branchBaseName, offlineGit, OFFLINE_GIT_TOO_OLD, readBranchDiff, readUnreportedBranches } from "./inbox-branch-reports";

/** A branch diff past its cap (the route says so with a 413). */
export { BranchDiffTooLarge };

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

/**
 * What every local-work command is given besides `offlineGit`'s guards. A list read runs in the background, so it starts
 * nothing a repository configures: no fsmonitor daemon (`core.fsmonitor`), no automatic gc or maintenance (as the PR
 * page's git, `createPullGitRunner`), and no optional lock (`git status` writes no refreshed index). Pager and colour are
 * off for every command already (`prepareGitCommand`), and both diffs run with `--no-ext-diff` (the branch's with
 * `--no-textconv` too; the uncommitted changes read as `plannotator review` reads them).
 */
export const LOCAL_WORK_GIT_CONFIG: Readonly<Record<string, string>> = Object.freeze({ "core.fsmonitor": "false", "maintenance.auto": "false", "gc.auto": "0" });
export const LOCAL_WORK_GIT_ENV: Readonly<Record<string, string>> = Object.freeze({ GIT_OPTIONAL_LOCKS: "0" });

const quietOptions = (options: GitCommandOptions | undefined): GitCommandOptions => ({
  ...options,
  config: { ...options?.config, ...LOCAL_WORK_GIT_CONFIG },
  env: { ...options?.env, ...LOCAL_WORK_GIT_ENV },
});

/** `offlineGit` with `LOCAL_WORK_GIT_CONFIG` and `LOCAL_WORK_GIT_ENV`, its capped reader too. One per runtime, so its version check is once. */
export function localWorkGit(runtime: ReviewGitRuntime): ReviewGitRuntime {
  let git = quiet.get(runtime);
  if (!git) {
    const bytes = runtime.runGitBytes;
    git = offlineGit({
      ...runtime,
      runGit: (args, options) => runtime.runGit(args, quietOptions(options)),
      runGitBytes: bytes ? (args, options) => bytes(args, quietOptions(options)) : undefined,
    });
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

/**
 * A project's branch is in a pull request, on that project's repository (the PR's own, or its head's for a fork;
 * `projectsByRepo` is Reviews' map from a repository key to the projects on it), from what Reviews last listed (no
 * forge is asked): an open one whose head is that branch, or a merged one whose head commit is the branch's head
 * (squash- and rebase-merged work stays ahead of the default branch). A same-named branch's PR on another
 * repository is not this one.
 */
export function localBranchInPull(pulls: readonly InboxPull[], projectsByRepo: ReadonlyMap<string, readonly string[]>, projectId: string, branch: string, head: string): boolean {
  const on = (host: string, repo: string | null) => !!repo && (projectsByRepo.get(inboxPullRepoKey(host, repo)) ?? []).includes(projectId);
  return pulls.some(
    (pull) =>
      ((inboxPullIsOpen(pull) && pull.head === branch) || (pull.state === "merged" && !!head && pull.head_sha === head)) &&
      (on(pull.host, pull.repo) || on(pull.host, pull.head_repo)),
  );
}

export interface InboxLocalWorkOptions {
  runtime: ReviewGitRuntime;
  /** The projects a person sees, newest activity first. */
  projects: () => InboxProject[];
  /** A branch not to list, given its head commit: one in a PR (`localBranchInPull`), or (Branch reviews on) one an agent reported. */
  skip: (projectId: string, branch: string, head: string) => boolean;
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
    // A working tree's uncommitted changes once, though projects inside it (a folder within another's) reach it too:
    // read once, shown under the project whose folder is its top, else the first project (newest activity) to reach it.
    const trees = new Map<string, { read: Promise<InboxLocalWork | null>; owners: { order: number; id: string; atTop: boolean }[] }>();
    const items: InboxLocalWork[] = [];
    let unread = 0;
    const one = async (project: InboxProject, order: number) => {
      try {
        const repo = await repoOf(git, project.root);
        if (!repo) return;
        const atTop = (await realpath(project.root).catch(() => project.root)) === repo.top;
        let tree = trees.get(repo.top);
        if (!tree) {
          tree = { read: readUncommitted(git, repo.top, project.id, at), owners: [] };
          trees.set(repo.top, tree);
        }
        tree.owners.push({ order, id: project.id, atTop });
        await tree.read;
        // A repository's branches once, under the first of its projects to reach it.
        if (repos.has(repo.common)) return;
        const branches = readUnreportedBranches(git, repo.top, project.id, (branch, head) => options.skip(project.id, branch, head), at, { scan: LOCAL_WORK_SCAN_MAX, list: LOCAL_WORK_BRANCHES_MAX }).then(({ branches: found }) => {
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
        while (next < projects.length) {
          const order = next++;
          await one(projects[order]!, order);
        }
      }),
    );
    for (const tree of trees.values()) {
      const row = await tree.read.catch(() => null);
      const owner = tree.owners.find((o) => o.atTop) ?? [...tree.owners].sort((a, b) => a.order - b.order)[0];
      if (row && owner) items.push({ ...row, project_id: owner.id });
    }
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
        const patch = await readBranchDiff(git, repo.top, base, `refs/heads/${branch}`).catch((cause: unknown) => {
          if (cause instanceof BranchDiffTooLarge) throw cause;
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
