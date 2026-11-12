import { execFileSync } from "node:child_process";
import { realpathSync, statSync } from "node:fs";
import { basename, extname } from "node:path";

export interface SameProgramSignature {
  realName: string;
  versionLine: RegExp;
}

export type SameProgramCheck = (path: string, signature: SameProgramSignature) => boolean;

const VERSION_TIMEOUT_MS = 5_000;
const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;
const cache = new Map<string, boolean>();

function realParts(path: string): { real: string; name: string; folders: string[] } {
  let real = path;
  try {
    real = realpathSync(path);
  } catch {
  }
  const file = basename(real);
  const name = file.slice(0, file.length - extname(file).length) || file;
  const folders = real.split(/[\\/]+/).slice(0, -1);
  return { real, name, folders };
}

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

export function forgetSameProgramAnswers(): void {
  cache.clear();
}
