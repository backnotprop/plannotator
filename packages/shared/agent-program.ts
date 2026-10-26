/**
 * Which program to start for an agent that is installed under a second,
 * generic name.
 *
 * Cursor's installer links both `cursor-agent` and `agent` to its CLI. Other
 * tools install an `agent` too (Grok Build's `~/.grok/bin/agent`), so a
 * program named `agent` on PATH is Cursor only when it shows Cursor's own
 * signature:
 *
 *  1. its real path (symlinks resolved) is in the installer's layout, checked
 *     without starting anything: on macOS and Linux
 *     `…/cursor-agent/versions/<version>/cursor-agent` (Cursor's installer
 *     links `agent` to `~/.local/share/cursor-agent/versions/<v>/cursor-agent`);
 *     on Windows a folder that also holds `cursor-agent.exe` or
 *     `cursor-agent.cmd` (not verified on Windows);
 *  2. else its `--version` line has the agent's own shape (Cursor prints
 *     `2026.07.08-0c04a8a`; Grok prints `grok 1.0.70 (f50904eaee6c) [stable]`).
 *     The probe is asynchronous, with no stdin and a 2 s limit; it runs in its
 *     own process group, which is killed whole when it is done or out of time,
 *     so a wrapper's child never outlives it. Each file is asked once (cached
 *     by real path, size and modification time; callers share one probe).
 *
 * The program's own name (`cursor-agent`) is always used as found. On Windows
 * a `.cmd` or `.bat` found under the generic name is not run (Node cannot
 * start one without a shell); only the path check applies to it.
 *
 * Node built-ins only, so the Bun server and the Pi extension (vendored) run
 * the same code.
 */

import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

/** What makes a program found under another name the agent's own CLI. */
export interface ProgramSignature {
  /**
   * The agent's own program name, without extension (`cursor-agent`). Its
   * installer's layout: `<realName>/versions/<version>/<realName>` on macOS and
   * Linux; a folder holding `<realName>.exe` or `<realName>.cmd` on Windows.
   */
  realName: string;
  /** The first non-empty line `--version` prints. */
  versionLine: RegExp;
}

/** Answers whether the program at `path` (as found on PATH) has the signature. */
export type SameProgramCheck = (path: string, signature: ProgramSignature) => Promise<boolean>;

/** The names an agent's CLI is installed under. */
export interface ProgramNames {
  /** Its own name, used whenever it is found. */
  command: string;
  /** Other names, tried in order after `command`. */
  alt?: readonly string[];
  /** Required of a program found under an `alt` name. Without it, any is used. */
  signature?: ProgramSignature;
}

/** A program found on PATH: the name to start it by and where it is. */
export interface ResolvedProgram {
  name: string;
  path: string;
}

/**
 * Cursor's CLI. Verified on Cursor CLI 2026.07.08 (macOS): both
 * `cursor-agent --version` and `agent --version` print `2026.07.08-0c04a8a`.
 */
export const CURSOR_CLI_SIGNATURE: ProgramSignature = {
  realName: "cursor-agent",
  versionLine: /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,40}$/,
};

export const VERSION_PROBE_TIMEOUT_MS = 2_000;
const MAX_VERSION_OUTPUT = 64 * 1024;
const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;
const cache = new Map<string, Promise<boolean>>();

/** Kill the probe and everything it started. */
function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      // The probe leads its own group (detached): signal the group.
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

/**
 * The first non-empty line `program --version` prints, or null when it fails,
 * exits non-zero or runs past the limit.
 */
export function readVersionLine(path: string, timeoutMs = VERSION_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
    // `stuck`: out of time or output; on Windows the tree is killed only then
    // (taskkill is a process of its own). Elsewhere the group is always
    // signalled, so nothing the probe started is left behind.
    const finish = (line: string | null, stuck = false) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      if (stuck || process.platform !== "win32") killTree(child?.pid);
      resolve(line);
    };
    try {
      child = spawn(path, ["--version"], {
        stdio: ["ignore", "pipe", "ignore"],
        detached: process.platform !== "win32",
        windowsHide: true,
      });
    } catch {
      resolve(null);
      return;
    }
    timer = setTimeout(() => finish(null, true), timeoutMs);
    child.on("error", () => finish(null));
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      out += chunk;
      if (out.length > MAX_VERSION_OUTPUT) finish(null, true);
    });
    child.on("exit", (code) => {
      // Output may still be in flight; a child left holding stdout must not
      // keep the answer waiting, so the line is read a moment after exit.
      setTimeout(() => finish(code === 0 ? (out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null) : null), 50);
    });
  });
}

/** The real path is in the installer's layout (no process is started). */
function inInstallLayout(real: string, realName: string, platform: NodeJS.Platform): boolean {
  if (platform === "win32") {
    const dir = dirname(real);
    return existsSync(join(dir, `${realName}.exe`)) || existsSync(join(dir, `${realName}.cmd`));
  }
  const parts = real.split("/");
  const n = parts.length;
  return n >= 4 && parts[n - 1] === realName && parts[n - 3] === "versions" && parts[n - 4] === realName && !!parts[n - 2];
}

export const isSameProgram: SameProgramCheck = async (path, signature) => {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Keep the path as found.
  }
  if (inInstallLayout(real, signature.realName, process.platform)) return true;
  if (process.platform === "win32" && WINDOWS_SCRIPT.test(real)) return false;
  let key: string;
  try {
    const st = statSync(real);
    if (!st.isFile()) return false;
    key = [real, st.size, st.mtimeMs, signature.versionLine.source].join("\u0000");
  } catch {
    return false;
  }
  let answer = cache.get(key);
  if (!answer) {
    answer = readVersionLine(real).then((line) => line !== null && signature.versionLine.test(line));
    cache.set(key, answer);
  }
  return answer;
};

/** For tests: forget the cached answers. */
export function forgetSameProgramAnswers(): void {
  cache.clear();
}

/**
 * The program to start: `command` when it is on PATH, else the first `alt`
 * name on PATH that has the signature (when one is required). Null when none
 * is, so the agent reads as not installed.
 */
export async function resolveProgram(
  names: ProgramNames,
  which: (name: string) => string | null,
  sameProgram: SameProgramCheck = isSameProgram,
): Promise<ResolvedProgram | null> {
  const own = which(names.command);
  if (own) return { name: names.command, path: own };
  for (const name of names.alt ?? []) {
    const path = which(name);
    if (!path) continue;
    if (names.signature && !(await sameProgram(path, names.signature))) continue;
    return { name, path };
  }
  return null;
}
