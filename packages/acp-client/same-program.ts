/**
 * Is a program found under a generic name really the agent's own CLI?
 *
 * Some agents install their CLI under a second, generic name: Cursor's
 * installer links both `cursor-agent` and `agent`. Other tools use the same
 * generic name (Grok Build installs `~/.grok/bin/agent`), so a program named
 * `agent` on PATH is Cursor only when it shows Cursor's own signature:
 *
 *  1. its real path (symlinks resolved) is the agent's own program, by file
 *     name or by a folder of that name (Cursor's installer links `agent` to
 *     `~/.local/share/cursor-agent/versions/<version>/cursor-agent`); no
 *     process is started for this;
 *  2. else its `--version` line has the agent's own shape (Cursor prints
 *     `2026.07.08-0c04a8a`; Grok prints `grok 1.0.70 (f50904eaee6c) [stable]`),
 *     read once per file (cached by real path, size and modification time),
 *     with no stdin, under a time limit.
 *
 * On Windows a `.cmd` or `.bat` found under the generic name is not run (Node
 * cannot start one without a shell); only the path check applies to it.
 */

import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

/** What makes a program found under another name the agent's own CLI. */
export interface SameProgramSignature {
  /** The agent's own program name (no extension): a file or folder of that name in the real path. */
  realName: string;
  /** The first non-empty line `--version` prints. */
  versionLine: RegExp;
}

/** Answers whether the program at `path` (as found on PATH) has the signature. */
export type SameProgramCheck = (path: string, signature: SameProgramSignature) => boolean;

const VERSION_TIMEOUT_MS = 5_000;
const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;
const cache = new Map<string, boolean>();

/** The real path, its file name without extension, and its folders. */
function realParts(path: string): { real: string; name: string; folders: string[] } {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
    // Keep the path as found.
  }
  const file = basename(real);
  const name = file.slice(0, file.length - extname(file).length) || file;
  const folders = real.split(/[\\/]+/).slice(0, -1);
  return { real, name, folders };
}

/** The first non-empty line `program --version` prints, or null when it fails or runs past the limit. */
export function readVersionLine(path: string, timeoutMs = VERSION_TIMEOUT_MS): string | null {
  try {
    const out = execFileSync(path, ["--version"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      windowsHide: true,
      maxBuffer: 64 * 1024,
    });
    return out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null;
  } catch {
    return null;
  }
}

export const isSameProgram: SameProgramCheck = (path, signature) => {
  const { real, name, folders } = realParts(path);
  if (name === signature.realName || folders.includes(signature.realName)) return true;
  if (process.platform === "win32" && WINDOWS_SCRIPT.test(real)) return false;
  let key: string;
  try {
    const st = statSync(real);
    key = [real, st.size, st.mtimeMs, signature.versionLine.source].join("\u0000");
  } catch {
    return false;
  }
  const known = cache.get(key);
  if (known !== undefined) return known;
  const line = readVersionLine(real);
  const same = line !== null && signature.versionLine.test(line);
  cache.set(key, same);
  return same;
};

/** For tests: forget the cached answers. */
export function forgetSameProgramAnswers(): void {
  cache.clear();
}
