/**
 * Clone from a git URL (approval "launch-create-clone", C1-C17, E1-E11): the machine that runs the agent clones the
 * repo first, with its own git and its own sign-in, then the agent starts in the clone. This file holds the parts
 * that touch git and the disk; the launch engine (inbox-launch.ts) holds the record and the run line.
 *
 * - Where a clone goes with no setting (`defaultCloneFolder`): the folder the person last cloned into on this
 *   machine; else the folder most of this machine's known projects live in; else home (C1, C1b, C1c).
 * - The folder it goes in (`cloneTarget`): `<into>/<repo>`; a folder of that name that holds the same repo is
 *   "already cloned" (C9, decision 9a); one that holds anything else gets `-2`, `-3` (C10). Nothing is overwritten.
 * - The check (`checkGitRemote`): `git ls-remote` quietly after a paste (C7, C8, C11, decision 3a).
 * - The clone (`runGitClone`): `git clone --progress [--branch <b>] -- <url> <folder>`, an argument list (never a
 *   shell), into the empty folder the Send made. The URL is the one `parseInboxGitUrl` rebuilt (https or ssh only,
 *   no credential, no option); git asks nothing (no terminal prompt, no askpass, no controlling terminal), so a
 *   machine that can't sign in fails at once and says so (E4).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { delimiter, dirname, join, relative, sep } from "node:path";
import { inboxGitRemoteKey } from "@plannotator/core/inbox-git-url";
import { prepareGitCommand } from "@plannotator/shared/review-core";

/** Why a clone or a check failed, as the run line and the clone row say it. */
export type GitFailure = "auth" | "not_found" | "network" | "failed";

/** What the quiet check after a paste found: the repo is there and can be read, or why not. */
export type GitReach = "ok" | GitFailure;

/** How long the quiet check may take before it says nothing (`failed`, which dims nothing). */
export const GIT_CHECK_TIMEOUT_MS = 15_000;

/**
 * How long a clone may go without git writing a word before it is called stalled (E6's line): a keychain or security
 * key waiting for a touch no one sees, or a transfer that stopped. git writes its progress many times a second while
 * it works, so only a clone that really stopped gets here; a big repo that keeps moving is never cut off.
 */
export const GIT_CLONE_IDLE_MS = 120_000;

/** How many `-2`, `-3`… names are tried before a clone folder is given up on. */
const TAKEN_MAX = 50;

/**
 * git's words for a failure, read into the four the person sees. Sign-in first: GitHub answers a private repo the
 * machine can't read as it answers one that isn't there, by asking for a password, and that is the likelier cause.
 */
export function classifyGitFailure(stderr: string): GitFailure {
  const text = stderr.toLowerCase();
  if (
    /could not resolve host|could not resolve hostname|network is unreachable|connection timed out|operation timed out|connection refused|failed to connect|no route to host|unable to access.*(timed out|resolve)|temporary failure in name resolution/.test(
      text,
    )
  )
    return "network";
  if (/authentication failed|could not read username|could not read password|terminal prompts disabled|permission denied \(publickey|host key verification failed|returned error: 403|access denied|invalid username or password|sign in/.test(text)) return "auth";
  if (/repository not found|not found|does not appear to be a git repository|returned error: 404|does not exist|no such repository/.test(text)) return "not_found";
  return "failed";
}

/** The percent in a line of `git clone --progress` ("Receiving objects:  23% (…)"), or null. Resolving deltas counts as the last stretch. */
export function parseGitProgress(chunk: string): number | null {
  let last: number | null = null;
  for (const line of chunk.split(/[\r\n]+/)) {
    const m = /(Counting|Compressing|Receiving|Resolving) (?:objects|deltas):\s+(\d{1,3})%/.exec(line);
    if (!m) continue;
    const pct = Number(m[2]);
    // Receiving is most of the time; resolving deltas is the tail end.
    last = m[1] === "Receiving" ? Math.round(pct * 0.9) : m[1] === "Resolving" ? 90 + Math.round(pct / 10) : Math.min(5, Math.round(pct / 20));
  }
  return last;
}

/** The repo a folder's `origin` remote names (`host/slug`, for "already cloned"), read from `.git/config` (no git run); null when none. */
export function originKeyOf(folder: string): string | null {
  let text: string;
  try {
    text = readFileSync(join(folder, ".git", "config"), "utf8");
  } catch {
    return null;
  }
  let inOrigin = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    const m = inOrigin ? /^url\s*=\s*(.+)$/.exec(line) : null;
    if (m) return inboxGitRemoteKey(m[1]!.trim());
  }
  return null;
}

/** A folder under `home` as `~/…` (home as `~`). */
export function tildeOf(home: string, path: string): string {
  const rel = relative(home, path);
  return rel === "" ? "~" : `~/${rel.split(sep).join("/")}`;
}

/** Inside home (home itself counts) and not in a hidden folder. */
function underHome(home: string, path: string): boolean {
  const rel = relative(home, path);
  return !rel.startsWith("..") && !rel.split(sep).some((segment) => segment.startsWith("."));
}

/**
 * Where a clone goes on this machine with no setting (C1, C1b, C1c): the folder last cloned into here, while it is
 * still there; else the folder most of this machine's known projects live in (their parent folders, under home and
 * not hidden; a tie goes to the one listed first, the most recent); else home.
 */
export function defaultCloneFolder(input: { home: string; last: string | null; projectRoots: readonly string[]; isFolder: (path: string) => boolean }): string {
  if (input.last && underHome(input.home, input.last) && input.isFolder(input.last)) return input.last;
  const counts = new Map<string, number>();
  for (const root of input.projectRoots) {
    const up = dirname(root);
    if (!underHome(input.home, up) || !input.isFolder(up)) continue;
    counts.set(up, (counts.get(up) ?? 0) + 1);
  }
  let best = input.home;
  let most = 0;
  for (const [folder, n] of counts) {
    if (n > most) {
      best = folder;
      most = n;
    }
  }
  return best;
}

/** The folder a clone goes in, in `into`: `state: "already"` when it holds the same repo (C9); `taken`: the name another folder had (C10). */
export type CloneTarget = { path: string; name: string; state: "clone" | "already"; taken: string | null };

/** `<into>/<repo>`, or the first `-2`, `-3`… that is free; the same repo already there is that folder (C9, C10). */
export function cloneTarget(input: { into: string; repo: string; key: string; exists: (path: string) => boolean; originOf: (path: string) => string | null }): CloneTarget | null {
  let taken: string | null = null;
  for (let n = 1; n <= TAKEN_MAX; n++) {
    const name = n === 1 ? input.repo : `${input.repo}-${n}`;
    const path = join(input.into, name);
    if (!input.exists(path)) return { path, name, state: "clone", taken };
    if (input.originOf(path) === input.key) return { path, name, state: "already", taken: null };
    taken ??= path;
  }
  return null;
}

/** The last folder cloned into on this machine (C1c), kept in `<dataDir>/inbox/launch/clone-folder.json`. */
export function readLastCloneFolder(dataDir: string): string | null {
  try {
    const value = JSON.parse(readFileSync(join(dataDir, "inbox", "launch", "clone-folder.json"), "utf8")) as { last?: unknown };
    return typeof value.last === "string" ? value.last : null;
  } catch {
    return null;
  }
}

export function writeLastCloneFolder(dataDir: string, folder: string): void {
  const dir = join(dataDir, "inbox", "launch");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, "clone-folder.json");
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify({ last: folder })}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

/** `git` on this PATH (the login PATH first), else the system's. */
export function gitBinary(env: Readonly<Record<string, string>>): string {
  for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const candidate = join(dir, "git");
    if (existsSync(candidate)) return candidate;
  }
  return "/usr/bin/git";
}

/** What git is never handed from the login env: they point git at another repository's files. */
const GIT_REPO_ENV = ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_ALTERNATE_OBJECT_DIRECTORIES", "GIT_COMMON_DIR", "GIT_NAMESPACE", "GIT_CEILING_DIRECTORIES"];

/**
 * One git command as it runs: the person's own env (their SSH agent, their credential helper, their proxy) with
 * nothing that could ask (`prepareGitCommand`'s no-interaction mode: no terminal prompt, `credential.interactive=false`,
 * ssh in batch mode with a connect timeout, their own `GIT_SSH_COMMAND` kept; and here no askpass dialog and no Git
 * Credential Manager window), git's words in English (`LC_ALL=C`), which the failure lines and the percent are read
 * from, and no variable that points git at another repository.
 */
export function gitCommand(args: string[], base: Readonly<Record<string, string>>, connectTimeoutMs = 30_000): { args: string[]; env: Record<string, string> } {
  const clean: Record<string, string> = { ...base };
  for (const name of GIT_REPO_ENV) delete clean[name];
  const prepared = prepareGitCommand(args, { interaction: "forbid", timeoutMs: connectTimeoutMs }, clean);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(prepared.env ?? clean)) if (typeof value === "string") env[key] = value;
  return { args: prepared.args, env: { ...env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never", SSH_ASKPASS_REQUIRE: "never", GIT_ASKPASS: "", SSH_ASKPASS: "", LC_ALL: "C", LANGUAGE: "C" } };
}

/**
 * One git run: its exit code and what it wrote on stderr (the last 8 KB). `detached`: no controlling terminal, so ssh
 * can't ask either. `timeoutMs` ends it after that long in all; `idleMs` once it has written nothing for that long;
 * `signal` when the one who asked is gone.
 */
function runGit(input: {
  git: string;
  args: string[];
  env: Record<string, string>;
  cwd?: string;
  timeoutMs?: number;
  idleMs?: number;
  signal?: AbortSignal;
  onStderr?: (chunk: string) => void;
  onSpawn?: (child: ChildProcess) => void;
}): Promise<{ code: number | null; stderr: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    let stderr = "";
    let timedOut = false;
    let child: ChildProcess;
    if (input.signal?.aborted) {
      resolve({ code: null, stderr: "", timedOut: false });
      return;
    }
    try {
      child = spawn(input.git, input.args, { cwd: input.cwd, env: input.env, stdio: ["ignore", "ignore", "pipe"], detached: true, shell: false });
    } catch (error) {
      resolve({ code: null, stderr: error instanceof Error ? error.message : String(error), timedOut: false });
      return;
    }
    input.onSpawn?.(child);
    const stop = () => {
      timedOut = true;
      killTree(child);
    };
    const timer = input.timeoutMs ? setTimeout(stop, input.timeoutMs) : null;
    let idle = input.idleMs ? setTimeout(stop, input.idleMs) : null;
    const onAbort = () => killTree(child);
    input.signal?.addEventListener("abort", onAbort, { once: true });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-8192);
      if (idle) {
        clearTimeout(idle);
        idle = setTimeout(stop, input.idleMs);
      }
      input.onStderr?.(chunk);
    });
    child.on("error", (error) => {
      stderr += `\n${error.message}`;
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      if (idle) clearTimeout(idle);
      input.signal?.removeEventListener("abort", onAbort);
      resolve({ code, stderr, timedOut });
    });
  });
}

/** Ends a git run and what it started (ssh, a helper): its whole process group. */
export function killTree(child: ChildProcess): void {
  try {
    if (child.pid) process.kill(-child.pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Gone already.
    }
  }
}

/**
 * The quiet check after a paste: can this machine read the repo (`git ls-remote`)? A timeout says `failed` (nothing is
 * dimmed for it); `signal` (the window stopped asking) ends git at once.
 */
export async function checkGitRemote(input: { url: string; env: Record<string, string>; timeoutMs?: number; signal?: AbortSignal }): Promise<GitReach> {
  const timeoutMs = input.timeoutMs ?? GIT_CHECK_TIMEOUT_MS;
  const command = gitCommand(["ls-remote", "--heads", "--", input.url], input.env, timeoutMs);
  const result = await runGit({ git: gitBinary(command.env), args: command.args, env: command.env, timeoutMs, ...(input.signal ? { signal: input.signal } : {}) });
  if (result.code === 0) return "ok";
  if (result.timedOut) return "failed";
  return classifyGitFailure(result.stderr);
}

/** A clone under way: its percent (null before git says one), and how to call it off. */
export interface CloneRun {
  done: Promise<{ ok: true } | { ok: false; error: GitFailure; text: string; cancelled: boolean }>;
  pct(): number | null;
  cancel(): void;
}

/** `git clone` into `folder` (which the Send made, empty). `onProgress` hears each new percent. */
export function runGitClone(input: { url: string; branch?: string; folder: string; env: Record<string, string>; idleMs?: number; onProgress?: (pct: number) => void }): CloneRun {
  const command = gitCommand(["-c", "advice.detachedHead=false", "clone", "--progress", ...(input.branch ? ["--branch", input.branch] : []), "--", input.url, input.folder], input.env);
  const env = command.env;
  let pct: number | null = null;
  let child: ChildProcess | null = null;
  let cancelled = false;
  const done = runGit({
    git: gitBinary(env),
    args: command.args,
    env,
    cwd: dirname(input.folder),
    idleMs: input.idleMs ?? GIT_CLONE_IDLE_MS,
    onSpawn: (spawned) => {
      child = spawned;
      if (cancelled) killTree(spawned);
    },
    onStderr: (chunk) => {
      const next = parseGitProgress(chunk);
      if (next !== null && next !== pct) {
        pct = next;
        input.onProgress?.(next);
      }
    },
  }).then((result) => {
    if (result.code === 0 && !cancelled) return { ok: true as const };
    const text = result.stderr.replace(/\r/g, "\n").split("\n").filter((line) => line.trim() && !/^(Cloning into|remote: (Counting|Compressing|Enumerating|Total)|Receiving|Resolving)/.test(line.trim())).slice(-3).join(" ").trim();
    // Stalled (nothing written for `idleMs`): said as the network's, the likeliest cause, with Try again.
    return { ok: false as const, error: cancelled ? ("failed" as const) : result.timedOut ? ("network" as const) : classifyGitFailure(result.stderr), text, cancelled };
  });
  return {
    done,
    pct: () => pct,
    cancel: () => {
      cancelled = true;
      if (child) killTree(child);
    },
  };
}
