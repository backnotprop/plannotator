/**
 * Reviews' "On this computer" (approval "inbox-reviews-compact-list", part 2; rules and wire in
 * packages/core/inbox-local-work.ts): this computer's work that is in no pull request, and the diff a row opens.
 *
 * - The list (`GET /api/inbox/reviews/local`): for each Inbox project whose folder is here, its local branches with a
 *   commit in the last `INBOX_UNREPORTED_BRANCH_DAYS` days and commits not on the default branch, no open PR and (with
 *   Branch reviews on) no agent's report, the same read as Branch reviews' safety net (`readUnreportedBranches`) with
 *   its caps, each branch with its count of commits not on the default branch; and its folder's uncommitted changes.
 *   The answer also names the projects read that have nothing (`quiet`), those with no git repository here
 *   (`not_git`) and those whose git could not be read (`unread_projects`), for a list filtered to one project; `?project=`
 *   answers that project's rows only, so another project's rows never use up its `LOCAL_WORK_ROWS_MAX`. Two projects
 *   that are folders of one repository (worktrees, a combined clone) list its branches once, and a branch in a PR or
 *   reported from any of them is left out for all of them.
 * - The diff (`GET /api/inbox/reviews/local/diff`): a branch's whole diff from its merge base with the default branch,
 *   by ref, checked out or not, against the very ref its count used (`readDefaultBranch`, `readBranchDiffFrom`); or the
 *   folder's uncommitted changes as `plannotator review` reads them (`runGitDiff`'s `uncommitted`). Either is held to
 *   `BRANCH_DIFF_MAX_BYTES`: past it, `BranchDiffTooLarge`, never a cut diff. For the uncommitted changes that is every
 *   `git diff` it runs together (the tracked files' and one per new file): once they have read past it, no other starts.
 * - Never the network, never a write: every git command goes through `offlineGit` (no transport, no prompt, killed
 *   after `BRANCH_GIT_TIMEOUT_MS`) with `GIT_OPTIONAL_LOCKS=0`, so not even `git status` refreshes the index on disk. No
 *   checkout, no stash. A folder that is gone, moved or no repository is skipped before any git runs. What the
 *   repository's own config still runs is in `LOCAL_WORK_GIT_CONFIG`'s note (a clean filter); besides that, the
 *   uncommitted diff opened on click runs a textconv program git config names for a file's `diff=` attribute
 *   (`diff.<driver>.textconv`), as `git diff` in that folder runs it (the list never does). With no index refresh, an
 *   index entry git can't trust by its time (racily clean: the file changed in the same second the index was written)
 *   is compared by content on each read, until the person's own git refreshes the index.
 * - Cost: at most `LOCAL_WORK_PROJECTS_MAX` projects (newest activity first), `LOCAL_WORK_PARALLEL` git reads at a
 *   time; per repository about seven commands plus one count per recent branch (no more than `LOCAL_WORK_SCAN_MAX`);
 *   one answer kept `LOCAL_WORK_CACHE_MS` and shared by every read while it is made, whatever its project filter. Read
 *   only when Reviews asks, after its list. A repository whose branches git can't read counts once in `unread` (and
 *   names each of its projects in `unread_projects`), however many of its projects reach it. A working tree whose
 *   uncommitted changes git can't read (`git status` failing or past its time, as it can in a big repository with
 *   fsmonitor off) simply has no uncommitted row: its branches still list, and it is not counted unread.
 * - Bun only: the Inbox is.
 */
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import type { InboxLocalDiffAnswer, InboxLocalWork, InboxLocalWorkAnswer } from "@plannotator/core/inbox-types";
import type { InboxProject } from "@plannotator/core/inbox-types";
import { inboxPullIsOpen, inboxPullRepoKey, type InboxPull } from "@plannotator/core/inbox-types";
import { runGitDiff, type GitCommandOptions, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { INBOX_UNREPORTED_BRANCHES_MAX } from "@plannotator/core/inbox-branch-reports";
import { BRANCH_DIFF_MAX_BYTES, BranchDiffTooLarge, branchBaseName, offlineGit, OFFLINE_GIT_TOO_OLD, readBranchDiffFrom, readDefaultBranch, readUnreportedBranches, UNREPORTED_SCAN_MAX } from "./inbox-branch-reports";

/** A branch diff past its cap (the route says so with a 413). */
export { BranchDiffTooLarge };

/** The projects read, newest activity first. */
export const LOCAL_WORK_PROJECTS_MAX = 24;
/** Recent branches looked at per repository (one `rev-list --count` each): as many as Branch reviews' safety net. */
export const LOCAL_WORK_SCAN_MAX = UNREPORTED_SCAN_MAX;
/** Branches listed per repository, newest first: as many as Branch reviews' safety net listed. */
export const LOCAL_WORK_BRANCHES_MAX = INBOX_UNREPORTED_BRANCHES_MAX;
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
 * no fsmonitor daemon (`core.fsmonitor`), no automatic gc or maintenance (as the PR page's git, `createPullGitRunner`),
 * and takes no optional lock (`git status` writes no refreshed index). Pager and colour are off for every command
 * already (`prepareGitCommand`), and both diffs run with `--no-ext-diff` (the branch's with `--no-textconv` too; the
 * uncommitted changes read as `plannotator review` reads them).
 * What does run: a clean filter that git config names for a file's `filter=` attribute (`filter.<driver>.clean` or
 * `.process`, as Git LFS's), when `git status` (and the uncommitted diff) must compare a tracked file whose time changed
 * with what is committed, as `git status` in that folder runs it. With no index refresh it runs again on each read until
 * the person's own git refreshes the index. Turning the driver off for these commands (`-c filter.<driver>.clean=`) was
 * tried: the row would then call a file changed that is not (the unfiltered bytes never match the committed ones), and
 * a `required` driver fails the read, so it stays on.
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
  return { project_id: projectId, kind: "uncommitted", branch: await checkedOut(git, top), base: null, at: new Date(Math.min(newest || now, now)).toISOString(), ahead: null };
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

/** `jobs` run `LOCAL_WORK_PARALLEL` at a time. */
async function inTurn(jobs: readonly (() => Promise<void>)[]): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(LOCAL_WORK_PARALLEL, jobs.length) }, async () => {
      while (next < jobs.length) await jobs[next++]!();
    }),
  );
}

/** Where a project is: its repository (`common`, its git folder shared by its worktrees) and working tree, null with none. */
type ProjectRepo = { top: string; common: string; atTop: boolean } | null;

/** What one list read found, every project's rows (the window's filter takes its own; `answerFor` caps them). */
type LocalWorkRead = Omit<InboxLocalWorkAnswer, "items"> & { items: InboxLocalWork[] };

/** The answer for a list filtered to `project` (none: every project), at most `LOCAL_WORK_ROWS_MAX` rows, newest first. */
function answerFor(read: LocalWorkRead, project: string | null): InboxLocalWorkAnswer {
  const items = project ? read.items.filter((item) => item.project_id === project) : read.items;
  return { ...read, items: items.slice(0, LOCAL_WORK_ROWS_MAX) };
}

export function createInboxLocalWork(options: InboxLocalWorkOptions) {
  const { runtime } = options;
  const now = options.now ?? Date.now;
  let kept: { at: number; read: LocalWorkRead; all: InboxLocalWorkAnswer } | null = null;
  let reading: Promise<{ read: LocalWorkRead; all: InboxLocalWorkAnswer }> | null = null;

  const read = async (): Promise<LocalWorkRead> => {
    const git = localWorkGit(runtime);
    const at = now();
    const projects = options.projects().slice(0, LOCAL_WORK_PROJECTS_MAX);
    // What failed, once per repository (a project's id when git could not even say which repository it is in): its
    // branches' read, never its uncommitted changes'.
    const failed = new Set<string>();
    const where = new Map<string, ProjectRepo>();
    await inTurn(
      projects.map((project) => async () => {
        try {
          const repo = await repoOf(git, project.root);
          where.set(project.id, repo && { ...repo, atTop: (await realpath(project.root).catch(() => project.root)) === repo.top });
        } catch {
          failed.add(`project:${project.id}`);
        }
      }),
    );
    // Each repository once, with its projects newest first; each working tree once, though projects inside it (a folder
    // within another's) reach it too: shown under the project whose folder is its top, else the newest to reach it.
    const repos = new Map<string, { top: string; ids: string[] }>();
    const trees = new Map<string, { common: string; owner: string; atTop: boolean }>();
    for (const project of projects) {
      const repo = where.get(project.id);
      if (!repo) continue;
      const one = repos.get(repo.common) ?? { top: repo.top, ids: [] };
      one.ids.push(project.id);
      repos.set(repo.common, one);
      const tree = trees.get(repo.top);
      if (!tree || (repo.atTop && !tree.atTop)) trees.set(repo.top, { common: repo.common, owner: project.id, atTop: repo.atTop });
    }
    const items: InboxLocalWork[] = [];
    const caps = { scan: LOCAL_WORK_SCAN_MAX, list: LOCAL_WORK_BRANCHES_MAX };
    await inTurn([
      // A working tree whose changes git can't read (in time) has no uncommitted row; its branches still list, and it is
      // not a repository that could not be read.
      ...[...trees].map(([top, tree]) => async () => {
        const row = await readUncommitted(git, top, tree.owner, at).catch(() => null);
        if (row) items.push(row);
      }),
      // A repository's branches under its newest project; one in a PR or reported from any of its projects is left out.
      ...[...repos].map(([common, repo]) => async () => {
        try {
          const owner = repo.ids[0]!;
          const read = await readUnreportedBranches(git, repo.top, owner, (branch, head) => repo.ids.some((id) => options.skip(id, branch, head)), at, caps);
          for (const branch of read.branches) items.push({ project_id: owner, kind: "branch", branch: branch.branch, base: branch.base, at: branch.last_commit_at, ahead: branch.ahead });
        } catch {
          failed.add(common);
        }
      }),
    ]);
    items.sort((a, b) => b.at.localeCompare(a.at));
    // A repository with any row (under any of its projects) is not quiet for any of them; one whose read failed is
    // never quiet: it could not be read.
    const busy = new Set(items.map((item) => where.get(item.project_id)?.common));
    const quiet: string[] = [];
    const notGit: string[] = [];
    const unreadProjects: string[] = [];
    for (const project of projects) {
      const repo = where.get(project.id);
      if (failed.has(`project:${project.id}`) || (repo && failed.has(repo.common))) unreadProjects.push(project.id);
      else if (repo === null) notGit.push(project.id);
      else if (repo && !busy.has(repo.common)) quiet.push(project.id);
    }
    return { items, unread: failed.size, quiet, not_git: notGit, unread_projects: unreadProjects };
  };

  return {
    /**
     * This computer's local work, for a list filtered to `project` (none: every project's), kept `LOCAL_WORK_CACHE_MS`
     * whatever the filter; one read at a time.
     */
    async list(project: string | null = null): Promise<InboxLocalWorkAnswer> {
      if (!kept || now() - kept.at >= LOCAL_WORK_CACHE_MS) {
        reading ??= read().then(
          (found) => {
            const answer = { read: found, all: answerFor(found, null) };
            kept = { at: now(), ...answer };
            reading = null;
            return answer;
          },
          (cause: unknown) => {
            reading = null;
            throw cause;
          },
        );
        const answer = await reading;
        return project ? answerFor(answer.read, project) : answer.all;
      }
      return project ? answerFor(kept.read, project) : kept.all;
    },
    /**
     * One row's diff, read now: `branch` its whole diff against the default branch, by ref; null the folder's
     * uncommitted changes. Null: the folder is not a repository here. Throws a sentence when git could not read it,
     * `BranchDiffTooLarge` past `BRANCH_DIFF_MAX_BYTES`.
     */
    async diff(project: InboxProject, branch: string | null): Promise<InboxLocalDiffAnswer | null> {
      const git = localWorkGit(runtime);
      const repo = await repoOf(git, project.root);
      if (!repo) return null;
      if (branch) {
        const defaultRef = await readDefaultBranch(git, repo.top);
        const base = branchBaseName(defaultRef);
        const patch = await readBranchDiffFrom(git, repo.top, defaultRef, `refs/heads/${branch}`).catch((cause: unknown) => {
          if (cause instanceof BranchDiffTooLarge) throw cause;
          throw new Error(`git couldn't read ${branch}'s diff against ${base} in this project's folder.`);
        });
        // Its commits not on the default branch, counted as the list counts them; a count git can't give is left out.
        const counted = await git.runGit(["rev-list", "--count", "--end-of-options", `${defaultRef}..refs/heads/${branch}`], { cwd: repo.top }).catch(() => null);
        const ahead = counted?.exitCode === 0 && /^\d+$/.test(counted.stdout.trim()) ? Number(counted.stdout.trim()) : null;
        return { project_id: project.id, kind: "branch", branch, base, patch, ahead };
      }
      const capped = cappedDiffGit(git);
      const result = await runGitDiff(capped.git, "uncommitted", "HEAD", repo.top);
      if (capped.over() || new TextEncoder().encode(result.patch).byteLength > BRANCH_DIFF_MAX_BYTES) throw new BranchDiffTooLarge();
      if (result.error) throw new Error("git couldn't read the uncommitted changes.");
      return { project_id: project.id, kind: "uncommitted", branch: await checkedOut(git, repo.top), base: "HEAD", patch: result.patch, ahead: null };
    },
  };
}

/**
 * The uncommitted diff's git with a branch diff's cap on all its `git diff` commands together (the tracked diff and one
 * per new file): each read through the capped reader at what is left of `BRANCH_DIFF_MAX_BYTES` (stopped there, never
 * held whole), and once they have read past it (`over`), no further `git diff` starts. Other commands as they were.
 */
function cappedDiffGit(git: ReviewGitRuntime): { git: ReviewGitRuntime; over: () => boolean } {
  let read = 0;
  const over = () => read > BRANCH_DIFF_MAX_BYTES;
  const tooLarge = { stdout: "", stderr: "This diff is too large to read here.", exitCode: 1 };
  const bytes = git.runGitBytes;
  return {
    over,
    git: {
      ...git,
      runGit: async (args, options) => {
        if (!bytes || args[0] !== "diff" || options?.stdin !== undefined) return git.runGit(args, options);
        if (over()) return tooLarge;
        const answer = await bytes(args, { ...options, maxOutputBytes: BRANCH_DIFF_MAX_BYTES - read });
        if (answer.truncated) {
          read = BRANCH_DIFF_MAX_BYTES + 1;
          return tooLarge;
        }
        read += answer.stdout.byteLength;
        return over() ? tooLarge : { stdout: new TextDecoder().decode(answer.stdout), stderr: answer.stderr, exitCode: answer.exitCode };
      },
    },
  };
}

export type InboxLocalWorkService = ReturnType<typeof createInboxLocalWork>;
