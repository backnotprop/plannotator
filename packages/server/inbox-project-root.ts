import { existsSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { lstat, opendir, readFile, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { labelPath } from "@plannotator/core/inbox-project-labels";
import { extractDirName, extractRepoName } from "@plannotator/core/project";
import { InboxError } from "@plannotator/shared/inbox/schema";

export const INBOX_PROJECT_ROOT_GIT_TIMEOUT_MS = 3_000;
export const INBOX_PROJECT_ROOT_TTL_MS = 60_000;
export const INBOX_PROJECT_ROOT_CACHE_MAX = 512;
export const INBOX_PROJECT_CONTAINER_WALK_MAX = 3;
export const INBOX_PROJECT_CONTAINER_SCAN_MAX = 256;
export const INBOX_PROJECT_CONTAINER_ENTRIES_MAX = 4096;

export interface InboxProjectRoot {
  root: string;
  name: string;
  folder: string;
  worktree: string | null;
  settled: boolean;
}

export type InboxGitRunner = (args: readonly string[], cwd: string) => Promise<{ exitCode: number; stdout: string } | null>;

export const INBOX_PROJECT_ROOT_GIT_ENV_CLEARED = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_COMMON_DIR",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
] as const;
const GIT_CONFIG_ENTRY = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

export function inboxProjectRootGitEnv(environment: Readonly<Record<string, string | undefined>> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) if (value !== undefined && !GIT_CONFIG_ENTRY.test(key)) env[key] = value;
  for (const key of INBOX_PROJECT_ROOT_GIT_ENV_CLEARED) delete env[key];
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

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
      return (error as NodeJS.ErrnoException).code === "ENOENT" ? { exitCode: 127, stdout: "" } : null;
    }
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill("SIGKILL");
    }, timeoutMs);
    try {
      const [stdout, exitCode] = await Promise.all([new Response(proc.stdout as ReadableStream).text(), proc.exited]);
      if (timedOut || exitCode > 128) return null;
      return { exitCode, stdout };
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  };
}

export function inboxProjectFolder(path: string): string {
  if (typeof path !== "string" || !isAbsolute(path)) {
    throw new InboxError("validation_error", "project_path: must be an absolute path.", { field: "project_path" });
  }
  try {
    const real = realpathSync(path);
    if (statSync(real).isDirectory()) return real;
  } catch {
  }
  throw new InboxError("validation_error", "project_path: no such folder.", { field: "project_path" });
}

export const INBOX_FOLDER_CHILDREN_MAX = 256;

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

export function inboxProjectFolderOf(path: string, home: string | null): string {
  const folder = inboxProjectFolder(path);
  if (folder !== parse(folder).root) return folder;
  if (home !== null && home !== parse(home).root) return home;
  throw new InboxError("validation_error", "project_path: a filesystem root is not a project; name your project's folder.", { field: "project_path" });
}

export function isInsideFolder(path: string, root: string): boolean {
  return path === root || path.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);
}

export function guessableProjects<T extends { root: string }>(projects: readonly T[], home: string | null, hasGit: (root: string) => boolean = (root) => existsSync(join(root, ".git"))): T[] {
  return projects.filter((project) => hasGit(project.root) && !isHomeOrRootFolder(project.root, home, { shape: false }));
}

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
  const lines = result.stdout.split("\n").map((line) => line.replace(/\r$/, ""));
  if (lines[lines.length - 1] === "") lines.pop();
  return { kind: "answer", lines };
}

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

type Resolved = {
  root: string;
  worktree: string | null;
  settled: boolean;
  fromDisk?: true;
};

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

async function mainWorktreeOf(git: InboxGitRunner, commonDir: string): Promise<{ root: string | null; settled: boolean }> {
  if (basename(commonDir) === ".git") {
    const plain = await verifiedMain(git, dirname(commonDir), commonDir);
    if (plain.root || !plain.settled) return plain;
  }
  const bare = await ask(git, ["rev-parse", "--is-bare-repository"], commonDir);
  if (bare.kind === "unavailable") return { root: null, settled: false };
  if (bare.kind === "answer" && bare.lines[0] === "true") {
    const name = basename(commonDir);
    return { root: name === ".bare" || name === ".git" ? dirname(commonDir) : commonDir, settled: true };
  }
  const recorded = await ask(git, ["rev-parse", "--show-toplevel"], commonDir);
  if (recorded.kind === "unavailable") return { root: null, settled: false };
  if (recorded.kind === "refused") return { root: null, settled: true };
  const candidate = gitPath(recorded.lines[0], commonDir);
  return candidate ? verifiedMain(git, candidate, commonDir) : { root: null, settled: true };
}

const CHECKOUT_FOLDERS = ["worktrees", ".worktrees"];

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
    }
  }
}

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
    }
    return { common: await realpath(common), main: false };
  } catch {
    return null;
  }
}

export function isHomeOrRootShape(folder: string): boolean {
  const parts = folder.split(/[\\/]+/).filter((part) => part.length > 0);
  if (parts.length === 0) return true;
  if (/^[\\/]{2}[^\\/]/.test(folder) && parts.length <= 2) return true;
  const top = parts[0]!.endsWith(":") ? parts.slice(1) : parts;
  if (top.length === 0) return true;
  return (top.length === 2 && ["users", "home"].includes(top[0]!.toLowerCase())) || (top.length === 1 && top[0] === "root");
}

export function inboxProjectRootHome(): string | null {
  try {
    return realpathSync(homedir());
  } catch {
    return null;
  }
}

export function isHomeOrRootFolder(folder: string, home: string | null, options: { shape?: boolean } = {}): boolean {
  return folder === parse(folder).root || (home !== null && folder === home) || (options.shape !== false && isHomeOrRootShape(folder));
}

type Rule4 = { git: InboxGitRunner; home: string | null };

async function hasCheckoutsFolder(folder: string): Promise<boolean> {
  for (const name of CHECKOUT_FOLDERS) {
    try {
      if ((await lstat(join(folder, name))).isDirectory()) return true;
    } catch {
    }
  }
  return false;
}

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

function leadingRepository<T extends { common: string }>(checkouts: readonly T[]): T[] | null {
  const groups = new Map<string, T[]>();
  for (const checkout of checkouts) groups.set(checkout.common, [...(groups.get(checkout.common) ?? []), checkout]);
  if (groups.size === 0) return null;
  const [lead] = [...groups.values()].sort((a, b) => b.length - a.length);
  if (groups.size === 1) return lead!;
  return lead!.length * 5 >= checkouts.length * 4 ? lead! : null;
}

function inCheckouts(root: string, folder: string): boolean {
  return root === folder || CHECKOUT_FOLDERS.some((name) => isInsideFolder(root, join(folder, name)));
}

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
      continue;
    }
    if ((await checkoutOf(join(folder, name)))?.common !== lead[0]!.common) return null;
  }
  const checkout = lead.find((one) => one.main) ?? lead[0]!;
  const resolved = await resolveWorkTree(checkout.path, git, home);
  if (resolved === null) return null;
  if (!resolved.settled) return checkout.main ? { root: checkout.path, worktree: folder, settled: true, fromDisk: true } : null;
  const confirmed = resolved.worktree !== null || (checkout.main && resolved.root === checkout.path);
  if (!confirmed || !inCheckouts(resolved.root, folder)) return null;
  return { root: resolved.root, worktree: resolved.root === folder ? null : folder, settled: true };
}

async function heldRepositoryOf(folder: string, rule4: Rule4): Promise<Resolved | null> {
  const holder = await checkoutsHolderOf(folder, rule4.home);
  if (holder === null) return null;
  const held = await repositoryHeldBy(holder, rule4);
  if (!held) return null;
  return { root: held.root, worktree: held.root === folder ? null : folder, settled: held.settled, ...(held.fromDisk ? { fromDisk: true as const } : {}) };
}

async function resolveFolder(folder: string, rule4: Rule4): Promise<Resolved> {
  const inWorkTree = await resolveWorkTree(folder, rule4.git, rule4.home);
  if (inWorkTree !== null) return inWorkTree;
  return (await heldRepositoryOf(folder, rule4)) ?? { root: folder, worktree: null, settled: true };
}

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
  if (!main.root || main.root === toplevel || isHomeOrRootFolder(main.root, home, { shape: false })) return { root: toplevel, worktree: null, settled: main.settled };
  return { root: main.root, worktree: toplevel, settled: true };
}

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
  if (held.fromDisk) return { root: null, settled: false };
  return { root: held.settled && held.root !== folder ? held.root : null, settled: held.settled };
}

function rootFor(folder: string, resolved: Resolved): InboxProjectRoot {
  const { root, worktree, settled } = resolved;
  const named = labelPath(root);
  const by = named.checkout !== null ? named.parts.join("/") : root;
  return { root, name: extractRepoName(by) ?? extractDirName(by) ?? "project", folder, worktree, settled };
}

export async function resolveInboxProjectRoot(path: string, options: { git?: InboxGitRunner; home?: string | null } = {}): Promise<InboxProjectRoot> {
  const home = options.home === undefined ? inboxProjectRootHome() : options.home;
  const folder = inboxProjectFolderOf(path, home);
  return rootFor(folder, await resolveFolder(folder, { git: options.git ?? inboxGitRunner(), home }));
}

export interface InboxProjectRoots {
  readonly home: string | null;
  resolve(path: string): Promise<InboxProjectRoot>;
}

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
