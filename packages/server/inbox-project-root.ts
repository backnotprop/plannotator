/**
 * Plannotator Inbox: the project a path belongs to.
 *
 * An agent names where it works (`project_path`); the Inbox files its
 * messages under a project, one per repository or folder. The rules, in
 * order:
 *
 *  1. The path must be an absolute path to an existing folder; it is taken
 *     by its realpath (`folder`). A filesystem root names the home folder:
 *     `/` is never a project (`inboxProjectFolderOf`).
 *  2. Not in a git work tree (no git, not a repository, inside a `.git`
 *     folder, a repository git cannot open), or in one whose toplevel is the
 *     home folder (a dotfiles home) or `/`: the folder is the project, as
 *     under a plain home (`isHomeOrRootFolder`).
 *  3. In a git work tree: the work tree's toplevel is the project, except
 *     when that work tree is a LINKED worktree (`git worktree add`, which is
 *     how Claude Code isolates an agent in `.claude/worktrees/agent-…`).
 *     Then the project is the repository's main worktree, so every worktree
 *     of one repository files into one project instead of one each.
 *  4. Not in a git work tree, but a folder that holds one repository's
 *     checkouts (Workspaces' `<repo>/worktrees/<branch>`, whose `<repo>` is
 *     a plain folder of notes beside the checkouts): that repository's
 *     project, so a session started in `<repo>` files where its checkouts
 *     do (`repositoryHeldBy`). Read from disk without git and bounded: the
 *     folders of its `worktrees` / `.worktrees` folder and its own, at most
 *     `INBOX_PROJECT_CONTAINER_SCAN_MAX` folders and
 *     `INBOX_PROJECT_CONTAINER_ENTRIES_MAX` entries each, and each one's `.git`. Only
 *     checkouts in such a folder count (a `~/code` holding `api` and
 *     `api-wt` side by side is a folder of projects, not a repository);
 *     they must be of one repository, or four in five of them (a stray
 *     clone does not split the folder off), whose root git confirms and
 *     which lies in the folder (or its checkouts folder); a folder that also
 *     holds a checkout of another repository right in it is a folder of
 *     repositories. A plain
 *     subfolder (`<repo>/notes`) is asked of the nearest such parent, at
 *     most three up. A home folder or a filesystem root is never folded.
 *
 * A linked worktree is recognized by git's own layout: its git dir is
 * `<common dir>/worktrees/<id>` (`--git-dir` against `--git-common-dir`). A
 * submodule's checkout has its own git dir, equal to its common dir, so it is
 * not a linked worktree and stays a project of its own.
 *
 * The main worktree of a common dir is found, then checked:
 *  - `<repo>/.git` (the usual layout): `<repo>`;
 *  - otherwise, a bare repository (`git clone --bare`, worktrees added
 *    beside it): the repository folder itself, or the folder holding it
 *    when it is named `.bare` or `.git` (the "bare repo in a container"
 *    layouts);
 *  - otherwise the work tree git names for the common dir (`core.worktree`,
 *    which is how a submodule's own linked worktrees point at its checkout).
 *  A candidate counts only when git, asked from it, names it as its
 *  toplevel and the same common dir. A main repository that was moved or
 *  deleted, a separate git dir with no work tree on record, or any git
 *  answer that does not fit: the linked worktree's own toplevel is the
 *  project, as before this rule.
 *
 * Every path is compared by realpath, so a symlinked spelling on either side
 * (macOS `/tmp` and `/private/tmp`, a symlinked checkout) lands in the same
 * project. git's relative answers start at the folder it was run in. A git
 * too old for `--git-common-dir` (before 2.5) echoes the flag back; that, or
 * any answer of the wrong shape, falls back to the toplevel.
 *
 * Each git runs off the request's critical path once per folder: answers are
 * cached per realpath (`createInboxProjectRoots`), refreshed in the
 * background once older than `INBOX_PROJECT_ROOT_TTL_MS`, and each git is
 * bounded by `INBOX_PROJECT_ROOT_GIT_TIMEOUT_MS`, run without the variables
 * that would point it at another repository (`GIT_DIR` and its kin). An
 * answer git could not give (the time limit) is marked `settled: false`,
 * used once and never cached, so the next call asks again; the Inbox then
 * files into an existing project that holds the folder, or refuses with
 * `project_unresolved` rather than make a project from a guess
 * (packages/server/inbox.ts, `resolveProject`). A machine without git at all
 * is an answer: every folder is its own project, as before.
 */

import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { labelPath } from "@plannotator/core/inbox-project-labels";
import { extractDirName, extractRepoName } from "@plannotator/core/project";
import { InboxError } from "@plannotator/shared/inbox/schema";

/** One git run for a project root never takes longer than this. */
export const INBOX_PROJECT_ROOT_GIT_TIMEOUT_MS = 3_000;
/** How long a cached answer is used as it is; after that it is used once more while a refresh runs. */
export const INBOX_PROJECT_ROOT_TTL_MS = 60_000;
/** At most this many folders are cached (the oldest leaves first). */
export const INBOX_PROJECT_ROOT_CACHE_MAX = 512;
/** How many parents up a folder outside any work tree looks for a checkouts holder (rule 4: `appnotes/notes` is `appnotes`'s). */
export const INBOX_PROJECT_CONTAINER_WALK_MAX = 3;
/** A `worktrees` folder, or a folder that holds one, with more folders than this in it is not read (rule 4): the folder stays its own project. */
export const INBOX_PROJECT_CONTAINER_SCAN_MAX = 256;
/** And with more entries of any kind than this (files of notes count only here): the folder stays its own project. */
export const INBOX_PROJECT_CONTAINER_ENTRIES_MAX = 4096;

export interface InboxProjectRoot {
  /** The project's root: a realpath. */
  root: string;
  /** The name a new project at `root` is created with (the folder key's slug). */
  name: string;
  /** The folder the path named, as a realpath: where the agent works. */
  folder: string;
  /**
   * The root an older Inbox filed this folder under, when this answer folds
   * it into another project (`root`): the linked worktree's toplevel the
   * folder lies in, or the folder itself when it holds one repository's
   * checkouts (rule 4). Null otherwise. Reads still find that project's
   * threads (`threadReadScope`, `findProjects`) and a send from it keeps the
   * folder as its `base_path`.
   */
  worktree: string | null;
  /**
   * Every git this answer needed answered. False when one ran past the time
   * limit (or could not start for a reason other than git being absent):
   * `root` is then a guess (the folder, or a worktree's own toplevel), never
   * cached, and the Inbox does not make a new project from it.
   */
  settled: boolean;
}

/**
 * One git run in `cwd`: its exit code and stdout, or null when git gave no
 * answer (killed at the time limit, could not start). A git that is not
 * installed is an answer: exit 127, so the folder is the project.
 */
export type InboxGitRunner = (args: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string } | null>;

/**
 * Variables that would point git at another repository than the folder's
 * own, whatever its cwd (an Inbox started from a git hook, or from a shell
 * that exported them), and the ones that inject config into one git run
 * (`git -c`'s `GIT_CONFIG_PARAMETERS`, and `GIT_CONFIG_COUNT` with its
 * `GIT_CONFIG_KEY_<n>` / `GIT_CONFIG_VALUE_<n>`): cleared for every
 * project-root git.
 */
export const INBOX_PROJECT_ROOT_GIT_ENV_CLEARED = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

/** The environment project-root gits run with: the Inbox's own, without the repository and config overrides, never prompting. */
export function inboxProjectRootGitEnv(environment: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined && !GIT_CONFIG_ENTRY.test(key)) env[key] = value;
  for (const key of INBOX_PROJECT_ROOT_GIT_ENV_CLEARED) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

/**
 * The real git: `rev-parse` only (it reads, starts no other process and
 * never prompts), killed at the time limit, its stderr ignored.
 */
export function inboxGitRunner(timeoutMs = INBOX_PROJECT_ROOT_GIT_TIMEOUT_MS): InboxGitRunner {
  return async (args, cwd) => {
    let proc: ReturnType<typeof Bun.spawn>;
    try {
      proc = Bun.spawn(["git", ...args], {
        cwd,
        env: inboxProjectRootGitEnv(),
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        windowsHide: true,
      });
    } catch (error) {
      // No git on this machine: an answer (the folder is the project), not a failure to retry.
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exitCode: 127, stdout: "" } : null;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      // Killed (the time limit, or any signal): no answer. git's own errors exit 1 or 128.
      if (timedOut || exitCode > 128) return null;
      return { exitCode, stdout };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The realpath of an existing folder an agent named, or the `validation_error` it gets. */
export function inboxProjectFolder(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new InboxError("validation_error", "project_path: must be an absolute path.", { field: "project_path" });
  }
  try {
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) return real;
  } catch {
    // Reported below.
  }
  throw new InboxError("validation_error", "project_path: no such folder.", { field: "project_path" });
}

/** At most this many entries in a folder are read for `folderHoldsOtherWork`; a bigger folder counts as holding other work. */
export const INBOX_FOLDER_CHILDREN_MAX = 256;

/**
 * Whether a plain folder holds work on disk besides the project at `inner`
 * (inside it): a direct child folder, other than the one on `inner`'s path,
 * that is a repository (`.git`) or holds checkouts (`worktrees`, `.worktrees`),
 * or is itself a checkouts folder. Tidy offers a folder into the one project
 * inside it only when this is false: `~/code` holding the repositories `a`, `b`
 * and `c`, of which only `a` reached the Inbox yet, is a folder of
 * repositories, not `a`'s. One bounded read of the folder (no git, no walk):
 * an unreadable folder, a folder with more than `INBOX_FOLDER_CHILDREN_MAX`
 * entries, or an `inner` not inside it counts as holding other work.
 */
export function folderHoldsOtherWork(folder: string, inner: string): boolean {
  const path = relative(folder, inner);
  if (path === "" || path.startsWith("..") || isAbsolute(path)) return true;
  const onPath = path.split(sep)[0];
  let entries: Dirent[];
  try {
    entries = readdirSync(folder, { withFileTypes: true });
  } catch {
    return true;
  }
  if (entries.length > INBOX_FOLDER_CHILDREN_MAX) return true;
  for (const entry of entries) {
    if (entry.name === onPath) continue;
    const child = join(folder, entry.name);
    let isFolder = entry.isDirectory();
    if (!isFolder && entry.isSymbolicLink()) {
      try {
        isFolder = statSync(child).isDirectory();
      } catch {
        isFolder = false;
      }
    }
    if (!isFolder) continue;
    if (entry.name === "worktrees" || entry.name === ".worktrees") return true;
    if (existsSync(join(child, ".git")) || existsSync(join(child, "worktrees")) || existsSync(join(child, ".worktrees"))) return true;
  }
  return false;
}

/**
 * The folder a path names for the Inbox: its realpath (`inboxProjectFolder`),
 * except a filesystem root, which names the home folder: an MCP client that
 * starts its server at `/` (a desktop app) has no folder of its own, and `/`
 * is no project. Without a home folder to use, `/` is refused.
 */
export function inboxProjectFolderOf(path: string, home: string | null): string {
  const folder = inboxProjectFolder(path);
  if (folder !== parse(folder).root) return folder;
  if (home !== null && home !== parse(home).root) return home;
  throw new InboxError("validation_error", "project_path: a filesystem root is not a project; name your project's folder.", { field: "project_path" });
}

/** Whether `path` is `root` or inside it (both realpaths). */
export function isInsideFolder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

/** Of `projects`, the one whose root holds `folder` most closely (the deepest root), or null. */
export function nearestProjectHolding<T extends { root: string }>(projects: readonly T[], folder: string): T | null {
  let best: T | null = null;
  for (const project of projects) {
    if (isInsideFolder(folder, project.root) && (!best || project.root.length > best.root.length)) best = project;
  }
  return best;
}

type GitAnswer = { kind: "answer"; lines: string[] } | { kind: "refused" } | { kind: "unavailable" };

async function ask(git: InboxGitRunner, args: readonly string[], cwd: string): Promise<GitAnswer> {
  const result = await git(args, cwd).catch(() => null);
  if (!result) return { kind: "unavailable" };
  if (result.exitCode !== 0) return { kind: "refused" };
  // One path per line; a path may hold spaces, so only the line ends go.
  const lines = result.stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines[lines.length - 1] === "") lines.pop();
  return { kind: "answer", lines };
}

/**
 * The realpath of a path git printed (relative ones start at `cwd`), or null
 * when the line is missing, is a flag git echoed back (a git that does not
 * know it), or names nothing on disk.
 */
function gitPath(line: string | undefined, cwd: string): string | null {
  if (!line || line.startsWith("-")) return null;
  try {
    return realpathSync(resolve(cwd, line));
  } catch {
    return null;
  }
}

function realFolder(path: string): string | null {
  try {
    const real = realpathSync(path);
    return statSync(real).isDirectory() ? real : null;
  } catch {
    return null;
  }
}

/** A resolution, and whether every git it needed answered (only those are cached). */
type Resolved = {
  root: string;
  worktree: string | null;
  settled: boolean;
  /** Rule 4's answer read from disk because the checkout's git did not answer in time: fine to file into, never to fold by. */
  fromDisk?: true;
};

/**
 * Whether `candidate` is the main worktree of `commonDir`: git, asked there,
 * names it as its toplevel and the same common dir. Null: not, or no longer
 * (moved, deleted, replaced by another repository).
 */
async function verifiedMain(git: InboxGitRunner, candidate: string, commonDir: string): Promise<{ root: string | null; settled: boolean }> {
  const folder = realFolder(candidate);
  if (!folder) return { root: null, settled: true };
  const answer = await ask(git, ["rev-parse", "--show-toplevel", "--git-common-dir"], folder);
  if (answer.kind === "unavailable") return { root: null, settled: false };
  if (answer.kind === "refused") return { root: null, settled: true };
  const toplevel = gitPath(answer.lines[0], folder);
  const common = gitPath(answer.lines[1], folder);
  return { root: toplevel === folder && common === commonDir ? folder : null, settled: true };
}

/** The main worktree a linked worktree's common dir belongs to (a bare repository's folder for a bare one), or null. */
async function mainWorktreeOf(git: InboxGitRunner, commonDir: string): Promise<{ root: string | null; settled: boolean }> {
  // The usual layout: `<repo>/.git`, whose main worktree is `<repo>`.
  if (basename(commonDir) === ".git") {
    const plain = await verifiedMain(git, dirname(commonDir), commonDir);
    if (plain.root || !plain.settled) return plain;
  }
  const bare = await ask(git, ["rev-parse", "--is-bare-repository"], commonDir);
  if (bare.kind === "unavailable") return { root: null, settled: false };
  if (bare.kind === "answer" && bare.lines[0] === "true") {
    // `repo.git` is the project; `repo/.bare` and `repo/.git` (a bare
    // repository inside the folder that holds its worktrees) are `repo`.
    const name = basename(commonDir);
    return { root: name === ".bare" || name === ".git" ? dirname(commonDir) : commonDir, settled: true };
  }
  // A work tree git keeps on record for the common dir (`core.worktree`):
  // how a submodule's linked worktrees point at the submodule's checkout.
  const recorded = await ask(git, ["rev-parse", "--show-toplevel"], commonDir);
  if (recorded.kind === "unavailable") return { root: null, settled: false };
  if (recorded.kind === "refused") return { root: null, settled: true };
  const candidate = gitPath(recorded.lines[0], commonDir);
  return candidate ? verifiedMain(git, candidate, commonDir) : { root: null, settled: true };
}

/** The folders a repository's checkouts are kept in, inside the folder that holds it (as `labelPath` in core). */
const CHECKOUT_FOLDERS = ["worktrees", ".worktrees"];

/**
 * The names of the folders right in `folder` (symlinks not followed), or null when it cannot be read or has
 * more folders (`INBOX_PROJECT_CONTAINER_SCAN_MAX`) or entries (`INBOX_PROJECT_CONTAINER_ENTRIES_MAX`) than
 * the scan reads: a folder of notes files is read whole. Asynchronous, so a slow disk never holds the
 * Inbox's event loop.
 */
async function childFolders(folder: string): Promise<string[] | null> {
  let dir: Awaited<ReturnType<typeof opendir>>;
  try {
    dir = await opendir(folder);
  } catch {
    return null;
  }
  const names: string[] = [];
  try {
    for (let seen = 0; ; seen += 1) {
      const entry = await dir.read();
      if (entry === null) return names;
      if (seen >= INBOX_PROJECT_CONTAINER_ENTRIES_MAX) return null;
      if (!entry.isDirectory()) continue;
      if (names.length >= INBOX_PROJECT_CONTAINER_SCAN_MAX) return null;
      names.push(entry.name);
    }
  } catch {
    return null;
  } finally {
    try {
      await dir.close();
    } catch {
      // Closed already (a read to the end closes it).
    }
  }
}

/**
 * A checkout's repository, read from its `.git` without git: the common dir
 * (realpath) of the `.git` folder, or of the git dir its `gitdir:` file names
 * (a linked worktree's names its common dir in `commondir`). `main` when the
 * `.git` is a folder. Null when the folder is no checkout.
 */
async function checkoutOf(folder: string): Promise<{ common: string; main: boolean } | null> {
  const dotGit = join(folder, ".git");
  try {
    const stat = await lstat(dotGit);
    if (stat.isDirectory()) return { common: await realpath(dotGit), main: true };
    if (!stat.isFile() || stat.size > 4096) return null;
    const named = /^gitdir:[ \t]*(.+?)[ \t\r]*$/m.exec(await readFile(dotGit, "utf8"))?.[1];
    if (!named) return null;
    const gitDir = resolve(folder, named);
    let common = gitDir;
    try {
      const recorded = (await readFile(join(gitDir, "commondir"), "utf8")).trim();
      if (recorded) common = resolve(gitDir, recorded);
    } catch {
      // No `commondir`: the git dir is its own common dir (a submodule, a separate git dir).
    }
    return { common: await realpath(common), main: false };
  } catch {
    return null;
  }
}

/**
 * A home folder or a filesystem root by its shape alone: `/Users/<x>`, `/home/<x>`, `<drive>:\Users\<x>`,
 * `/root`, `/`, `<drive>:\`, a network share's root (`\\server\share`). Rule 4 never folds one, nor walks
 * up to one.
 */
export function isHomeOrRootShape(folder: string): boolean {
  const parts = folder.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  if (/^[\\/]{2}[^\\/]/.test(folder) && parts.length <= 2) return true;
  const top = parts[0]!.endsWith(":") ? parts.slice(1) : parts;
  if (top.length === 0) return true;
  return (top.length === 2 && ["users", "home"].includes(top[0]!.toLowerCase())) || (top.length === 1 && top[0] === "root");
}

/** This user's home folder as a realpath, or null when there is none on record. */
export function inboxProjectRootHome(): string | null {
  try {
    return realpathSync(homedir());
  } catch {
    return null;
  }
}

/**
 * The one home-or-root check: a filesystem root, `home` (this user's home as a realpath, injectable for
 * tests; null: none), or, unless `shape` is false, a home folder by its shape (`isHomeOrRootShape`).
 *
 * Rule 4's walk and fold and Tidy's plain folders use the shape too (any home is never a holder). A git
 * toplevel (rule 2's dotfiles home) and the repository projects a guess may take use only the exact home and
 * `/` (`shape: false`): a real repository at `/home/<user>` (a devcontainer, a CI runner) stays a project.
 */
export function isHomeOrRootFolder(folder: string, home: string | null, options: { shape?: boolean } = {}): boolean {
  return folder === parse(folder).root || (home !== null && folder === home) || (options.shape !== false && isHomeOrRootShape(folder));
}

/** What rule 4 runs with: the git runner, and the home folder it never folds or walks up to. */
type Rule4 = { git: InboxGitRunner; home: string | null };

/** Whether `folder` has a `worktrees` or `.worktrees` folder (no symlink followed). */
async function hasCheckoutsFolder(folder: string): Promise<boolean> {
  for (const name of CHECKOUT_FOLDERS) {
    try {
      if ((await lstat(join(folder, name))).isDirectory()) return true;
    } catch {
      // Not there.
    }
  }
  return false;
}

/**
 * The folder rule 4 is asked of for `folder`: the folder itself or the nearest of its parents, at most
 * `INBOX_PROJECT_CONTAINER_WALK_MAX` up, that has a checkouts folder (so `appnotes/notes` and
 * `appnotes/worktrees` ask `appnotes`), never a home folder or a filesystem root or above. Null: none. No git.
 */
export async function checkoutsHolderOf(folder: string, home: string | null = inboxProjectRootHome()): Promise<string | null> {
  let at = folder;
  for (let up = 0; up <= INBOX_PROJECT_CONTAINER_WALK_MAX; up += 1) {
    if (isHomeOrRootFolder(at, home)) return null;
    if (await hasCheckoutsFolder(at)) return at;
    const parent = dirname(at);
    if (parent === at) return null;
    at = parent;
  }
  return null;
}

/**
 * The repository whose checkouts a checkouts folder holds: all of them, or four in five of them (so with
 * another repository there, at least four), so one stray clone of another repository dropped among the
 * owner's 39 checkouts does not split the folder off again; with a closer count (two of one and one of
 * another, four of six), no repository speaks for the folder. Null: none.
 */
function leadingRepository<T extends { common: string }>(checkouts: readonly T[]): T[] | null {
  const groups = new Map<string, T[]>();
  for (const checkout of checkouts) groups.set(checkout.common, [...(groups.get(checkout.common) ?? []), checkout]);
  if (groups.size === 0) return null;
  const [lead] = [...groups.values()].sort((a, b) => b.length - a.length);
  if (groups.size === 1) return lead!;
  return lead!.length * 5 >= checkouts.length * 4 ? lead! : null;
}

/** Whether `root` is `folder` itself or lies in one of its checkouts folders: a repository the folder holds, not one beside them. */
function inCheckouts(root: string, folder: string): boolean {
  return root === folder || CHECKOUT_FOLDERS.some((name) => isInsideFolder(root, join(folder, name)));
}

/**
 * Rule 4: the repository a plain folder holds, from the checkouts in its `worktrees` / `.worktrees` folder
 * (`checkoutOf`, no git): all of one repository, or a clear majority (`leadingRepository`). None, a close
 * count, or too many entries to read leave it a folder. The repository's root is then asked of git
 * (`resolveWorkTree` on one of its checkouts, the main one first) and counts only when git confirms it (a
 * linked worktree that folds, or the main checkout itself) and it is the folder or lies in its checkouts
 * folder (`inCheckouts`: `~/work` holding the repositories `api` and `web` beside `worktrees/api-feat` is a
 * folder of repositories, not `api`'s). Null: the folder stays its own project.
 *
 * A folder that also holds a checkout of another repository right in it, outside its checkouts folders
 * (`~/work/web` beside `~/work/worktrees/api`), or one whose `.git` does not read, is a folder of
 * repositories: no repository speaks for it (#2526 delta review, D2). A checkout of the same repository
 * there (a linked worktree added as `appnotes/scratch`) does not split it off (E1).
 *
 * A git that does not answer for the checkout does not fail the session (it would have no project to file
 * into): the repository's main checkout in the checkouts folder, read from disk, stands for it; with none
 * there (only linked ones), the folder is its own project, as before rule 4.
 */
async function repositoryHeldBy(folder: string, { git, home }: Rule4): Promise<Resolved | null> {
  if (isHomeOrRootFolder(folder, home)) return null;
  const direct = await childFolders(folder);
  if (direct === null) return null;
  const checkouts: { path: string; common: string; main: boolean }[] = [];
  for (const name of CHECKOUT_FOLDERS) {
    try {
      if (!(await lstat(join(folder, name))).isDirectory()) continue;
    } catch {
      continue;
    }
    const inner = await childFolders(join(folder, name));
    if (inner === null) return null;
    for (const child of inner) {
      const found = await checkoutOf(join(folder, name, child));
      if (found) checkouts.push({ path: join(folder, name, child), ...found });
    }
  }
  const lead = leadingRepository(checkouts);
  if (!lead) return null;
  for (const name of direct) {
    if (CHECKOUT_FOLDERS.includes(name)) continue;
    try {
      await lstat(join(folder, name, ".git"));
    } catch {
      continue; // Not a checkout.
    }
    if ((await checkoutOf(join(folder, name)))?.common !== lead[0]!.common) return null;
  }
  const checkout = lead.find((one) => one.main) ?? lead[0]!;
  const resolved = await resolveWorkTree(checkout.path, git, home);
  if (resolved === null) return null;
  // The main checkout is a child of a checkouts folder, so it is the repository the folder holds.
  if (!resolved.settled) return checkout.main ? { root: checkout.path, worktree: folder, settled: true, fromDisk: true } : null;
  const confirmed = resolved.worktree !== null || (checkout.main && resolved.root === checkout.path);
  if (!confirmed || !inCheckouts(resolved.root, folder)) return null;
  return { root: resolved.root, worktree: resolved.root === folder ? null : folder, settled: true };
}

/**
 * Rule 4 for a folder outside any work tree: the repository its nearest checkouts holder holds
 * (`checkoutsHolderOf`). `worktree` is the folder itself (the root an earlier Inbox filed it under), unless
 * that is the repository's root. Null: no holder, or the holder holds no one repository.
 */
async function heldRepositoryOf(folder: string, rule4: Rule4): Promise<Resolved | null> {
  const holder = await checkoutsHolderOf(folder, rule4.home);
  if (holder === null) return null;
  const held = await repositoryHeldBy(holder, rule4);
  if (!held) return null;
  return { root: held.root, worktree: held.root === folder ? null : folder, settled: held.settled, ...(held.fromDisk ? { fromDisk: true as const } : {}) };
}

/** The project root of a folder (a realpath). Never throws. */
async function resolveFolder(folder: string, rule4: Rule4): Promise<Resolved> {
  const inWorkTree = await resolveWorkTree(folder, rule4.git, rule4.home);
  if (inWorkTree !== null) return inWorkTree;
  // Not a work tree (or a repository git cannot open, or one at home or `/`): the folder is the project, unless it is (or is in) a folder that holds one repository's checkouts.
  return (await heldRepositoryOf(folder, rule4)) ?? { root: folder, worktree: null, settled: true };
}

/**
 * The project root of a folder in a git work tree (rules 3), or null when git says it is in none. A work
 * tree whose toplevel is the home folder (dotfiles) or `/` counts as none (rule 2): no project's repository,
 * so the folder stands alone as under a plain home, and rule 4 and the startup fold still run for it. Only
 * the exact `home` and `/`, never the home shape: a real repository at `/home/<user>` stays one. Never throws.
 */
async function resolveWorkTree(folder: string, git: InboxGitRunner, home: string | null): Promise<Resolved | null> {
  const answer = await ask(git, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], folder);
  if (answer.kind === "unavailable") return { root: folder, worktree: null, settled: false };
  if (answer.kind === "refused") return null;
  const toplevel = gitPath(answer.lines[0], folder) ?? folder;
  if (isHomeOrRootFolder(toplevel, home, { shape: false })) return null;
  const gitDir = gitPath(answer.lines[1], folder);
  const commonDir = gitPath(answer.lines[2], folder);
  const linked = gitDir !== null && commonDir !== null && gitDir !== commonDir && dirname(gitDir) === join(commonDir, "worktrees");
  if (!linked) return { root: toplevel, worktree: null, settled: true };
  const main = await mainWorktreeOf(git, commonDir);
  // A linked worktree of a dotfiles home (or of a repository at `/`) keeps its own toplevel: home is no repository's project.
  if (!main.root || main.root === toplevel || isHomeOrRootFolder(main.root, home, { shape: false })) return { root: toplevel, worktree: null, settled: main.settled };
  return { root: main.root, worktree: toplevel, settled: true };
}

/**
 * Rule 4 alone, for the startup fold (inbox-checkout-folders.ts): the repository project root a plain folder's
 * checkouts make it, or null when the folder is in a work tree, holds no one repository's checkouts, or is that
 * root itself. `settled` false: a git did not answer, so nothing can be said this time.
 */
export async function resolveCheckoutsFolder(path: string, options: { git?: InboxGitRunner; home?: string | null } = {}): Promise<{ root: string | null; settled: boolean }> {
  const git = options.git ?? inboxGitRunner();
  let folder: string;
  try {
    folder = await realpath(path);
    if (!(await stat(folder)).isDirectory()) return { root: null, settled: true };
  } catch {
    return { root: null, settled: true };
  }
  const home = options.home === undefined ? inboxProjectRootHome() : options.home;
  const inWorkTree = await resolveWorkTree(folder, git, home);
  if (inWorkTree !== null) return { root: null, settled: inWorkTree.settled };
  const held = await heldRepositoryOf(folder, { git, home });
  if (!held) return { root: null, settled: true };
  // A timed-out git (the answer read from disk) is never acted on: the next start asks again.
  if (held.fromDisk) return { root: null, settled: false };
  return { root: held.settled && held.root !== folder ? held.root : null, settled: held.settled };
}

function rootFor(folder: string, resolved: Resolved): InboxProjectRoot {
  const { root, worktree, settled } = resolved;
  // A checkout in a `worktrees` folder is named for its repository (`labelPath`, the rule the names follow): `appnotes`, not `main`.
  const named = labelPath(root);
  const by = named.checkout !== null ? named.parts.join("/") : root;
  return { root, name: extractRepoName(by) ?? extractDirName(by) ?? "project", folder, worktree, settled };
}

/**
 * The project root for a path an agent named, asked of git now (no cache).
 * Throws `validation_error` for a path that is not an existing folder.
 */
export async function resolveInboxProjectRoot(path: string, options: { git?: InboxGitRunner; home?: string | null } = {}): Promise<InboxProjectRoot> {
  const home = options.home === undefined ? inboxProjectRootHome() : options.home;
  const folder = inboxProjectFolderOf(path, home);
  return rootFor(folder, await resolveFolder(folder, { git: options.git ?? inboxGitRunner(), home }));
}

export interface InboxProjectRoots {
  /** The home folder these answers keep apart (`isHomeOrRootFolder`): a realpath, or null. */
  readonly home: string | null;
  /**
   * The project root for a path an agent named. Waits for git only the first
   * time a folder is seen (or after an answer git could not give); later
   * calls answer from the cache. Throws `validation_error` for a path that is
   * not an existing folder.
   */
  resolve(path: string): Promise<InboxProjectRoot>;
}

/** Project roots cached per folder (realpath), shared by sends, live sessions and the image route. */
export function createInboxProjectRoots(options: { git?: InboxGitRunner; home?: string | null; ttlMs?: number; now?: () => number; max?: number } = {}): InboxProjectRoots {
  const git = options.git ?? inboxGitRunner();
  const home = options.home === undefined ? inboxProjectRootHome() : options.home;
  const rule4: Rule4 = { git, home };
  const ttlMs = options.ttlMs ?? INBOX_PROJECT_ROOT_TTL_MS;
  const now = options.now ?? Date.now;
  const max = Math.max(1, options.max ?? INBOX_PROJECT_ROOT_CACHE_MAX);
  const entries = new Map<string, { value: InboxProjectRoot; at: number }>();
  const pending = new Map<string, Promise<InboxProjectRoot>>();

  const remember = (folder: string, value: InboxProjectRoot) => {
    entries.delete(folder);
    entries.set(folder, { value, at: now() });
    while (entries.size > max) entries.delete(entries.keys().next().value!);
  };

  const run = (folder: string): Promise<InboxProjectRoot> => {
    const inFlight = pending.get(folder);
    if (inFlight) return inFlight;
    const job = resolveFolder(folder, rule4)
      .then((resolved) => {
        const value = rootFor(folder, resolved);
        // Unsettled (git could not answer): used this once; a stale entry stays.
        if (resolved.settled) remember(folder, value);
        return value;
      })
      .finally(() => pending.delete(folder));
    pending.set(folder, job);
    return job;
  };

  return {
    home,
    async resolve(path) {
      const folder = inboxProjectFolderOf(path, home);
      const entry = entries.get(folder);
      if (!entry) return run(folder);
      if (now() - entry.at >= ttlMs) void run(folder).catch(() => {});
      return entry.value;
    },
  };
}
