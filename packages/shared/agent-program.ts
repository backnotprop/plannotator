import { spawn } from "node:child_process";
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";

export interface ProgramSignature {
  realName: string;
  versionLine: RegExp;
}

export type SameProgramCheck = (path: string, signature: ProgramSignature) => Promise<boolean>;

export interface ProgramNames {
  command: string;
  alt?: readonly string[];
  signature?: ProgramSignature;
}

export interface ResolvedProgram {
  name: string;
  path: string;
}

export const CURSOR_CLI_SIGNATURE: ProgramSignature = {
  realName: "cursor-agent",
  versionLine: /^\d{4}\.\d{1,2}\.\d{1,2}-[0-9a-f]{6,40}$/,
};

export const VERSION_PROBE_TIMEOUT_MS = 2_000;
const MAX_VERSION_OUTPUT = 64 * 1024;
const WINDOWS_SCRIPT = /\.(cmd|bat)$/i;
const cache = new Map<string, Promise<boolean>>();

function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  try {
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }).on("error", () => {});
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
  }
}

export function readVersionLine(path: string, timeoutMs = VERSION_PROBE_TIMEOUT_MS): Promise<string | null> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ReturnType<typeof spawn>;
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
      setTimeout(() => finish(code === 0 ? (out.split(/\r?\n/).map((l) => l.trim()).find(Boolean) ?? null) : null), 50);
    });
  });
}

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

export function forgetSameProgramAnswers(): void {
  cache.clear();
}

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
