/**
 * Plannotator Inbox: the project a path belongs to.
 *
 * An agent names where it works (`project_path`); the Inbox files its
 * messages under a project, one per repository or folder. The rules, in
 * order:
 *
 *  1. The path must be an absolute path to an existing folder; it is taken
 *     by its realpath (`folder`).
 *  2. Not in a git work tree (no git, not a repository, inside a `.git`
 *     folder, a repository git cannot open): the folder is the project.
 *  3. In a git work tree: the work tree's toplevel is the project, except
 *     when that work tree is a LINKED worktree (`git worktree add`, which is
 *     how Claude Code isolates an agent in `.claude/worktrees/agent-…`).
 *     Then the project is the repository's main worktree, so every worktree
 *     of one repository files into one project instead of one each.
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

import { realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { extractDirName, extractRepoName } from "@plannotator/core/project";
import { InboxError } from "@plannotator/shared/inbox/schema";

/** One git run for a project root never takes longer than this. */
export const INBOX_PROJECT_ROOT_GIT_TIMEOUT_MS = 3_000;
/** How long a cached answer is used as it is; after that it is used once more while a refresh runs. */
export const INBOX_PROJECT_ROOT_TTL_MS = 60_000;
/** At most this many folders are cached (the oldest leaves first). */
export const INBOX_PROJECT_ROOT_CACHE_MAX = 512;

export interface InboxProjectRoot {
  /** The project's root: a realpath. */
  root: string;
  /** The name a new project at `root` is created with (the folder key's slug). */
  name: string;
  /** The folder the path named, as a realpath: where the agent works. */
  folder: string;
  /**
   * The linked worktree's toplevel when the folder lies in one that was
   * folded into its main repository's project (`root`), else null.
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
type Resolved = { root: string; worktree: string | null; settled: boolean };

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

/** The project root of a folder (a realpath). Never throws. */
async function resolveFolder(folder: string, git: InboxGitRunner): Promise<Resolved> {
  const answer = await ask(git, ["rev-parse", "--show-toplevel", "--git-dir", "--git-common-dir"], folder);
  if (answer.kind === "unavailable") return { root: folder, worktree: null, settled: false };
  // Not a work tree (or a repository git cannot open): the folder is the project.
  if (answer.kind === "refused") return { root: folder, worktree: null, settled: true };
  const toplevel = gitPath(answer.lines[0], folder) ?? folder;
  const gitDir = gitPath(answer.lines[1], folder);
  const commonDir = gitPath(answer.lines[2], folder);
  const linked = gitDir !== null && commonDir !== null && gitDir !== commonDir && dirname(gitDir) === join(commonDir, "worktrees");
  if (!linked) return { root: toplevel, worktree: null, settled: true };
  const main = await mainWorktreeOf(git, commonDir);
  if (!main.root || main.root === toplevel) return { root: toplevel, worktree: null, settled: main.settled };
  return { root: main.root, worktree: toplevel, settled: true };
}

function rootFor(folder: string, resolved: Resolved): InboxProjectRoot {
  const { root, worktree, settled } = resolved;
  return { root, name: extractRepoName(root) ?? extractDirName(root) ?? "project", folder, worktree, settled };
}

/**
 * The project root for a path an agent named, asked of git now (no cache).
 * Throws `validation_error` for a path that is not an existing folder.
 */
export async function resolveInboxProjectRoot(path: string, options: { git?: InboxGitRunner } = {}): Promise<InboxProjectRoot> {
  const folder = inboxProjectFolder(path);
  return rootFor(folder, await resolveFolder(folder, options.git ?? inboxGitRunner()));
}

export interface InboxProjectRoots {
  /**
   * The project root for a path an agent named. Waits for git only the first
   * time a folder is seen (or after an answer git could not give); later
   * calls answer from the cache. Throws `validation_error` for a path that is
   * not an existing folder.
   */
  resolve(path: string): Promise<InboxProjectRoot>;
}

/** Project roots cached per folder (realpath), shared by sends, live sessions and the image route. */
export function createInboxProjectRoots(options: { git?: InboxGitRunner; ttlMs?: number; now?: () => number; max?: number } = {}): InboxProjectRoots {
  const git = options.git ?? inboxGitRunner();
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
    const job = resolveFolder(folder, git)
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
    async resolve(path) {
      const folder = inboxProjectFolder(path);
      const entry = entries.get(folder);
      if (!entry) return run(folder);
      if (now() - entry.at >= ttlMs) void run(folder).catch(() => {});
      return entry.value;
    },
  };
}
