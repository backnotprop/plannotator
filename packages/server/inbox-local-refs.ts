/**
 * Reviews' "On this computer", its + (approval "reviews-open-any-branch-a"; wire in packages/core/inbox-local-work.ts):
 * open any branch or worktree folder of a project as a review, or any folder through New message's folder opener.
 *
 * - The projects (`GET /api/inbox/reviews/local/refs`): each project whose folder is a git repository here (the list's
 *   projects, at most `LOCAL_WORK_PROJECTS_MAX`), with how many worktree folders and branches its step lists.
 * - A project's step (`?project=`): its repository's worktree folders but the project's own (at most
 *   `LOCAL_REFS_FOLDERS_MAX`), each with the branch checked out in it (or its short commit), its commits not on the
 *   default branch and whether it has uncommitted changes; then its local branches, newest first (at most
 *   `LOCAL_REFS_BRANCHES_MAX`), but the default branch and those checked out in a listed folder (offered once, as the
 *   folder), each with its commits not on the default branch: one `for-each-ref` with `%(ahead-behind:…)` where git has
 *   it (2.41), else one count each for the newest `LOCAL_REFS_COUNT_MAX` (the rest uncounted, `ahead: null`).
 * - A folder (`folder=` on the diff route, and a kept folder): only a worktree that git itself lists for that project's
 *   repository (by its real path), or a folder the folder opener's own rules accept (`pickedFolder`: Launch on, not
 *   hidden, not a system folder, a full path with no `.` or `..`, there, one a session could start in), and a git
 *   repository. A value that starts with `-`, holds a NUL or a `..` segment, or is neither a full path nor `~/…` is
 *   refused before anything is read. Its diff is its whole work: from its merge base with the default branch to its
 *   working tree, new files too (`runGitDiff`'s `since-base`), held to `BRANCH_DIFF_MAX_BYTES` as the other diffs.
 * - Kept rows (`?keep=` on the list): what the person opened, each read again (a branch's tip, count and PR; a
 *   folder's rules again). One in a pull request (`skip`), gone, or refused is left out.
 * - Never the network, never a write: every command goes through `localWorkGit` (`offlineGit`, no optional locks, no
 *   fsmonitor, gc or maintenance). Answers are kept `LOCAL_WORK_CACHE_MS`, per project and per kept row.
 * - Bun only: the Inbox is.
 */
import { realpath } from "node:fs/promises";
import { isAbsolute, sep } from "node:path";
import { inboxLocalKeepOf, INBOX_LOCAL_KEPT_MAX, inboxPullSafeBranch, type InboxLocalDiffAnswer, type InboxLocalRefProjectsAnswer, type InboxLocalRefsAnswer, type InboxLocalWork, type InboxProject } from "@plannotator/core/inbox-types";
import { getWorktrees, runGitDiff, type ReviewGitRuntime } from "@plannotator/shared/review-core";
import { BRANCH_DIFF_MAX_BYTES, BranchDiffTooLarge, branchBaseName, readDefaultBranch } from "./inbox-branch-reports";
import { cappedDiffGit, inTurn, isFolder, LOCAL_WORK_CACHE_MS, LOCAL_WORK_PROJECTS_MAX, localWorkGit, readUncommitted, repoOf } from "./inbox-local-work";

/** Branches a project's step lists, newest first. */
export const LOCAL_REFS_BRANCHES_MAX = 500;
/** Where git has no `%(ahead-behind:…)`: branches counted one command each, newest first; the rest show no count. */
export const LOCAL_REFS_COUNT_MAX = 200;
/** Worktree folders a project's step lists (about five commands each). */
export const LOCAL_REFS_FOLDERS_MAX = 20;
/** Past `LOCAL_REFS_FOLDERS_MAX`, worktrees on no branch listed unread (no counts, no git call each), at most this many. */
export const LOCAL_REFS_FOLDERS_PAST_MAX = 200;

const realOr = async (path: string) => realpath(path).catch(() => null);

/** A folder value from the window that may be looked at, by its form alone: a full path or `~/…`, no option, no NUL, no `.` or `..`. */
export function localFolderFormOk(folder: string): boolean {
  if (!folder || folder.length > 4096 || folder.startsWith("-") || folder.includes("\0")) return false;
  if (!(isAbsolute(folder) || folder.startsWith("~/"))) return false;
  return !folder.split(/[\\/]/).some((part) => part === ".." || part === ".");
}

export interface InboxLocalRefsOptions {
  runtime: ReviewGitRuntime;
  /** The list's projects, newest activity first. */
  projects: () => InboxProject[];
  /** A project by id (none: null). */
  project: (id: string) => InboxProject | null;
  /** A branch in a pull request (or, Branch reviews on, reported), given its head commit: a kept row leaves. */
  skip: (projectId: string, branch: string, head: string) => boolean;
  /**
   * The folder opener's own rules (`GET /api/inbox/launch/folders`, inbox-launch.ts): the folder's real path when it is
   * one the opener offers to start in, else null (Launch off too). Absent: no folder but a listed worktree.
   */
  pickedFolder?: (folder: string) => Promise<string | null>;
  /** "Another folder…" in the window: the folder opener can be used. */
  anotherFolder?: () => boolean;
  home?: string | null;
  now?: () => number;
}

/** A worktree folder of a repository: where it is and what git says is checked out in it. */
type Tree = { path: string; real: string; branch: string | null; head: string };

export function createInboxLocalRefs(options: InboxLocalRefsOptions) {
  const { runtime } = options;
  const now = options.now ?? Date.now;
  const kept = new Map<string, { at: number; value: Promise<unknown> }>();
  /** One answer per key for `LOCAL_WORK_CACHE_MS`, shared by reads while it is made; a failed one is not kept. */
  const once = <T>(key: string, make: () => Promise<T>): Promise<T> => {
    const was = kept.get(key);
    if (was && now() - was.at < LOCAL_WORK_CACHE_MS) return was.value as Promise<T>;
    const value = make();
    kept.set(key, { at: now(), value });
    value.catch(() => kept.get(key)?.value === value && kept.delete(key));
    // Old answers go, so the map stays as small as what was read lately.
    if (kept.size > 200) for (const [k, v] of kept) if (now() - v.at >= LOCAL_WORK_CACHE_MS) kept.delete(k);
    return value;
  };

  /** A repository's worktree folders that are there (not its bare entry), by their real paths. */
  const treesOf = async (git: ReviewGitRuntime, top: string): Promise<Tree[]> => {
    const listed = await getWorktrees(git, top);
    const trees: Tree[] = [];
    for (const tree of listed) {
      // A bare repository's own entry (`git clone --bare` with worktrees off it): no working folder to review.
      if (!tree.path || tree.bare || !(await isFolder(tree.path))) continue;
      const real = await realOr(tree.path);
      if (real) trees.push({ path: tree.path, real, branch: tree.branch ?? null, head: tree.head });
    }
    return trees;
  };

  /** A folder's row: the branch in it (or its short commit), its tip's time, its commits not on `defaultRef`, its changes. */
  const folderRow = async (git: ReviewGitRuntime, cwd: string, folder: string, projectId: string, defaultRef: string): Promise<{ row: InboxLocalWork; sha: string }> => {
    const named = await git.runGit(["symbolic-ref", "-q", "--short", "HEAD"], { cwd });
    const branch = named.exitCode === 0 && named.stdout.trim() ? named.stdout.trim() : null;
    const short = branch ? null : await git.runGit(["rev-parse", "--verify", "--quiet", "--short", "HEAD"], { cwd });
    const tip = await git.runGit(["rev-list", "--max-count=1", "--timestamp", "HEAD"], { cwd });
    const [seconds = "", sha = ""] = tip.exitCode === 0 ? tip.stdout.trim().split(/\s+/) : [];
    const counted = await git.runGit(["rev-list", "--count", "--end-of-options", `${defaultRef}..HEAD`], { cwd });
    const ahead = counted.exitCode === 0 && /^\d+$/.test(counted.stdout.trim()) ? Number(counted.stdout.trim()) : null;
    const at = now();
    const changes = await readUncommitted(git, cwd, projectId, at).catch(() => null);
    const committed = Number(seconds) > 0 ? Number(seconds) * 1000 : 0;
    const newest = Math.max(committed, changes ? Date.parse(changes.at) : 0) || at;
    return {
      row: {
        project_id: projectId,
        kind: "folder",
        branch,
        base: branchBaseName(defaultRef),
        at: new Date(newest).toISOString(),
        ahead,
        folder,
        head: branch ? null : short?.exitCode === 0 ? short.stdout.trim() || null : null,
        uncommitted: !!changes,
        folder_real: (await realOr(cwd)) ?? cwd,
      },
      sha,
    };
  };

  /** A project's branches, newest first, each with its count (`ahead-behind`, else one count each up to the cap). */
  const branchesOf = async (git: ReviewGitRuntime, top: string, projectId: string, defaultRef: string, leave: ReadonlySet<string>): Promise<InboxLocalWork[]> => {
    const base = branchBaseName(defaultRef);
    const count = `--count=${LOCAL_REFS_BRANCHES_MAX + leave.size + 1}`;
    const read = (format: string) => git.runGit(["for-each-ref", "--sort=-committerdate", count, `--format=${format}`, "refs/heads/"], { cwd: top });
    let listed = await read(`%(refname)%00%(committerdate:unix)%00%(ahead-behind:${defaultRef})`);
    const together = listed.exitCode === 0;
    if (!together) listed = await read("%(refname)%00%(committerdate:unix)");
    if (listed.exitCode !== 0) throw new Error("git couldn't list the branches.");
    const rows: InboxLocalWork[] = [];
    for (const line of listed.stdout.split("\n")) {
      const [ref = "", seconds = "", counts = ""] = line.split("\u0000");
      const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
      if (!branch || branch === base || leave.has(branch) || !inboxPullSafeBranch(branch)) continue;
      const ahead = together && /^\d+ \d+$/.test(counts.trim()) ? Number(counts.trim().split(" ")[0]) : null;
      rows.push({ project_id: projectId, kind: "branch", branch, base, at: new Date((Number(seconds) || 0) * 1000).toISOString(), ahead });
      if (rows.length >= LOCAL_REFS_BRANCHES_MAX) break;
    }
    if (!together) {
      await inTurn(
        rows.slice(0, LOCAL_REFS_COUNT_MAX).map((row) => async () => {
          const counted = await git.runGit(["rev-list", "--count", "--end-of-options", `${defaultRef}..refs/heads/${row.branch}`], { cwd: top });
          row.ahead = counted.exitCode === 0 && /^\d+$/.test(counted.stdout.trim()) ? Number(counted.stdout.trim()) : null;
        }),
      );
    }
    return rows;
  };

  /**
   * Each folder's checked-out commit's time, seconds: one `git log` for them all (`--ignore-missing`, so a commit that
   * is not there drops out alone); should that call fail, one each. A folder on an unborn branch (`git worktree add
   * --orphan`, an all-zero HEAD) has none, and counts as the oldest.
   */
  const headTimes = async (git: ReviewGitRuntime, top: string, trees: Tree[]): Promise<Map<string, number>> => {
    const heads = [...new Set(trees.map((tree) => tree.head).filter((head) => /^[0-9a-f]{40,64}$/.test(head) && !/^0+$/.test(head)))];
    const times = new Map<string, number>();
    const take = (stdout: string) => {
      for (const line of stdout.split("\n")) {
        const [sha = "", seconds = ""] = line.trim().split(" ");
        if (sha && Number(seconds) > 0) times.set(sha, Number(seconds));
      }
    };
    if (!heads.length) return times;
    const read = await git.runGit(["log", "--no-walk=unsorted", "--ignore-missing", "--format=%H %ct", "--end-of-options", ...heads], { cwd: top });
    if (read.exitCode === 0) take(read.stdout);
    else await inTurn(heads.map((head) => async () => {
      const one = await git.runGit(["log", "-1", "--format=%H %ct", "--end-of-options", head], { cwd: top });
      if (one.exitCode === 0) take(one.stdout);
    }));
    return times;
  };

  /**
   * A project's repository, its default branch's ref and its worktree folders but its own: at most
   * `LOCAL_REFS_FOLDERS_MAX` read whole, the newest by their checked-out commit's time (`headTimes`: not the list's
   * `at`, which counts uncommitted edits too, a `git status` a folder). A branch checked out in one of them is offered as
   * that folder (`inFolders`); one checked out in a folder past them stays a branch, and a folder past them on no branch
   * is still listed, unread (`past`: no counts, at most `LOCAL_REFS_FOLDERS_PAST_MAX`). Null: no repository here.
   */
  const placeOf = async (git: ReviewGitRuntime, project: InboxProject) => {
    const repo = await repoOf(git, project.root);
    if (!repo) return null;
    const own = (await realOr(repo.top)) ?? repo.top;
    const all = (await treesOf(git, repo.top)).filter((tree) => tree.real !== own);
    let trees = all;
    let past: { tree: Tree; seconds: number }[] = [];
    if (all.length > LOCAL_REFS_FOLDERS_MAX) {
      const times = await headTimes(git, repo.top, all);
      const ranked = [...all].sort((a, b) => (times.get(b.head) ?? 0) - (times.get(a.head) ?? 0));
      trees = ranked.slice(0, LOCAL_REFS_FOLDERS_MAX);
      past = ranked
        .slice(LOCAL_REFS_FOLDERS_MAX)
        .filter((tree) => !tree.branch && times.has(tree.head))
        .slice(0, LOCAL_REFS_FOLDERS_PAST_MAX)
        .map((tree) => ({ tree, seconds: times.get(tree.head)! }));
    }
    const inFolders = new Set(trees.flatMap((tree) => (tree.branch ? [tree.branch] : [])));
    return { top: repo.top, defaultRef: await readDefaultBranch(git, repo.top), trees, past, inFolders };
  };

  /**
   * A folder value the window may open, as its real top and the project it is under: a worktree git lists for that
   * project's repository, else a folder the folder opener's rules accept. Null: refused, gone or no repository.
   */
  const folderOf = async (project: InboxProject | null, folder: string): Promise<{ top: string; project: InboxProject | null } | null> => {
    if (!localFolderFormOk(folder)) return null;
    const git = localWorkGit(runtime);
    if (project && isAbsolute(folder)) {
      const real = await realOr(folder);
      const repo = real ? await repoOf(git, project.root) : null;
      if (real && repo && (await treesOf(git, repo.top)).some((tree) => tree.real === real)) return { top: real, project };
    }
    const picked = options.pickedFolder ? await options.pickedFolder(folder).catch(() => null) : null;
    if (!picked) return null;
    const repo = await repoOf(git, picked);
    return repo ? { top: repo.top, project } : null;
  };

  return {
    /** The first step: each project whose folder is a git repository here, with its counts. */
    projects(): Promise<InboxLocalRefProjectsAnswer> {
      return once("projects", async () => {
        const git = localWorkGit(runtime);
        const projects = options.projects().slice(0, LOCAL_WORK_PROJECTS_MAX);
        const found = new Map<string, { project_id: string; folders: number; branches: number }>();
        await inTurn(
          projects.map((project) => async () => {
            const place = await placeOf(git, project).catch(() => null);
            if (!place) return;
            const listed = await git.runGit(["for-each-ref", "--format=%(refname)", "refs/heads/"], { cwd: place.top });
            if (listed.exitCode !== 0) return;
            const base = branchBaseName(place.defaultRef);
            const branches = listed.stdout.split("\n").filter((ref) => {
              const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : "";
              return branch && branch !== base && !place.inFolders.has(branch) && inboxPullSafeBranch(branch);
            }).length;
            found.set(project.id, { project_id: project.id, folders: place.trees.length + place.past.length, branches: Math.min(branches, LOCAL_REFS_BRANCHES_MAX) });
          }),
        );
        return {
          projects: projects.flatMap((project) => (found.has(project.id) ? [found.get(project.id)!] : [])),
          another_folder: options.anotherFolder?.() === true,
          home: options.home ?? null,
        };
      });
    },

    /** A project's step: its worktree folders, then its branches. Null: its folder is no git repository here. */
    refs(project: InboxProject): Promise<InboxLocalRefsAnswer | null> {
      return once(`refs:${project.id}`, async () => {
        const git = localWorkGit(runtime);
        const place = await placeOf(git, project);
        if (!place) return null;
        const folders: InboxLocalWork[] = new Array(place.trees.length);
        await inTurn(place.trees.map((tree, i) => async () => void (folders[i] = (await folderRow(git, tree.path, tree.path, project.id, place.defaultRef)).row)));
        folders.sort((a, b) => b.at.localeCompare(a.at));
        // Past the cap, on no branch: listed unread (its commit and time only), so it can still be found and opened.
        const base = branchBaseName(place.defaultRef);
        for (const { tree, seconds } of place.past) {
          folders.push({ project_id: project.id, kind: "folder", branch: null, base, at: new Date(seconds * 1000).toISOString(), ahead: null, folder: tree.path, head: tree.head.slice(0, 7), folder_real: tree.real });
        }
        // A branch checked out in a listed folder is offered once, as the folder.
        const branches = await branchesOf(git, place.top, project.id, place.defaultRef, place.inFolders);
        return { project_id: project.id, base: branchBaseName(place.defaultRef), folders, branches };
      });
    },

    /** Whether `folder` may be opened under `project` (null: none), as `folderOf` decides. */
    async allowed(project: InboxProject | null, folder: string): Promise<boolean> {
      return (await folderOf(project, folder)) !== null;
    },

    /**
     * A folder's whole work, read now: from its merge base with the default branch to its working tree, new files too.
     * Null: refused, gone or no repository. Throws a sentence when git could not read it, `BranchDiffTooLarge` past the cap.
     */
    async diff(project: InboxProject | null, folder: string): Promise<InboxLocalDiffAnswer | null> {
      const place = await folderOf(project, folder);
      if (!place) return null;
      const git = localWorkGit(runtime);
      const defaultRef = await readDefaultBranch(git, place.top);
      const capped = cappedDiffGit(git);
      const result = await runGitDiff(capped.git, "since-base", defaultRef, place.top);
      if (capped.over() || new TextEncoder().encode(result.patch).byteLength > BRANCH_DIFF_MAX_BYTES) throw new BranchDiffTooLarge();
      if (result.error) throw new Error("git couldn't read the uncommitted changes.");
      const { row } = await folderRow(git, place.top, folder, project?.id ?? "", defaultRef);
      return { project_id: row.project_id, kind: "folder", branch: row.branch, base: branchBaseName(defaultRef), patch: result.patch, ahead: row.ahead ?? null, folder, head: row.head ?? null, uncommitted: row.uncommitted ?? false };
    },

    /** Kept rows (`inboxLocalWorkKey` of a branch or a folder), each read again; one gone, refused or in a PR is left out. */
    async kept(keys: readonly string[]): Promise<InboxLocalWork[]> {
      const rows: (InboxLocalWork | null)[] = [];
      const wanted = [...new Set(keys)].slice(0, INBOX_LOCAL_KEPT_MAX);
      await inTurn(
        wanted.map((key, i) => async () => {
          rows[i] = await once(`kept:${key}`, () => keptRow(key)).catch(() => null);
        }),
      );
      return rows.filter((row): row is InboxLocalWork => !!row);
    },
  };

  async function keptRow(key: string): Promise<InboxLocalWork | null> {
    const keep = inboxLocalKeepOf(key);
    if (!keep) return null;
    const project = keep.project ? options.project(keep.project) : null;
    if (keep.project && !project) return null;
    const git = localWorkGit(runtime);
    if ("branch" in keep) {
      if (!project || !inboxPullSafeBranch(keep.branch)) return null;
      const repo = await repoOf(git, project.root);
      if (!repo) return null;
      // A pattern also matches the refs under it (`refs/heads/fix` names `refs/heads/fix/x` too): the exact ref only.
      const ref = `refs/heads/${keep.branch}`;
      const tip = await git.runGit(["for-each-ref", "--format=%(refname)%00%(committerdate:unix)%00%(objectname)", ref], { cwd: repo.top });
      const line = tip.exitCode === 0 ? tip.stdout.split("\n").find((entry) => entry.startsWith(`${ref}\u0000`)) : undefined;
      const [, seconds = "", sha = ""] = line ? line.split("\u0000") : [];
      if (!sha || options.skip(project.id, keep.branch, sha)) return null;
      const defaultRef = await readDefaultBranch(git, repo.top);
      const counted = await git.runGit(["rev-list", "--count", "--end-of-options", `${defaultRef}..refs/heads/${keep.branch}`], { cwd: repo.top });
      const ahead = counted.exitCode === 0 && /^\d+$/.test(counted.stdout.trim()) ? Number(counted.stdout.trim()) : null;
      return { project_id: project.id, kind: "branch", branch: keep.branch, base: branchBaseName(defaultRef), at: new Date((Number(seconds) || 0) * 1000).toISOString(), ahead };
    }
    const place = await folderOf(project, keep.folder);
    if (!place) return null;
    const defaultRef = await readDefaultBranch(git, place.top);
    const { row, sha } = await folderRow(git, place.top, keep.folder, project?.id ?? "", defaultRef);
    // Picked through "Another folder…" (no project), yet a known project's repository: the window shows it once.
    const under = project ?? (await projectOfRepo(git, place.top));
    if (!project && under) row.in_project = under.id;
    if (under && row.branch && sha && options.skip(under.id, row.branch, sha)) return null;
    return row;
  }

  /**
   * The known project whose repository `top` is part of (its folder or one of its worktrees), or null. Two projects on
   * one repository: the one whose folder holds `top` (the deepest), else the first.
   */
  async function projectOfRepo(git: ReviewGitRuntime, top: string): Promise<InboxProject | null> {
    const common = async (root: string) => {
      const repo = await repoOf(git, root).catch(() => null);
      return repo ? ((await realOr(repo.common)) ?? repo.common) : null;
    };
    const mine = await common(top);
    if (!mine) return null;
    const here = (await realOr(top)) ?? top;
    let first: InboxProject | null = null;
    let best: { project: InboxProject; depth: number } | null = null;
    for (const project of options.projects().slice(0, LOCAL_WORK_PROJECTS_MAX)) {
      if ((await once(`common:${project.id}`, () => common(project.root))) !== mine) continue;
      first ??= project;
      const root = (await realOr(project.root)) ?? project.root;
      if ((here === root || here.startsWith(root.endsWith(sep) ? root : root + sep)) && root.length > (best?.depth ?? -1)) best = { project, depth: root.length };
    }
    return best?.project ?? first;
  }
}

export type InboxLocalRefsService = ReturnType<typeof createInboxLocalRefs>;
