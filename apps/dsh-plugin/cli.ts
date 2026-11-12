import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface DshPlanResult {
  approved: boolean;
  feedback?: string;
  message?: string;
  savedPath?: string;
  answersOnly?: boolean;
}

function isExecutableFile(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== "win32") accessSync(path, fsConstants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolvePlannotatorBinary(options: {
  configured?: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  home?: string;
} = {}): string | undefined {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const configured = options.configured?.trim();
  if (configured) return configured;
  const fromEnv = env.PLANNOTATOR_BIN?.trim();
  if (fromEnv) return fromEnv;

  const name = platform === "win32" ? "plannotator.exe" : "plannotator";
  for (const dir of (env.PATH ?? "").split(platform === "win32" ? ";" : ":")) {
    if (!dir) continue;
    const candidate = join(dir, name);
    if (isExecutableFile(candidate, platform)) return candidate;
  }

  const installed = platform === "win32"
    ? (env.LOCALAPPDATA ? join(env.LOCALAPPDATA, "plannotator", name) : undefined)
    : join(options.home ?? homedir(), ".local", "bin", name);
  return installed && isExecutableFile(installed, platform) ? installed : undefined;
}

export function parseDshPlanOutput(stdout: string): DshPlanResult {
  const line = stdout.split(/\r?\n/).map((l) => l.trim()).filter((l) => l.startsWith("{")).pop();
  if (!line) throw new Error("plannotator dsh-plan printed no JSON");
  const raw = JSON.parse(line) as Record<string, unknown>;
  if (typeof raw.approved !== "boolean") throw new Error("plannotator dsh-plan output has no boolean `approved`");
  const text = (key: string) => (typeof raw[key] === "string" && raw[key] ? { [key]: raw[key] as string } : {});
  return {
    approved: raw.approved,
    ...text("feedback"),
    ...text("message"),
    ...text("savedPath"),
    ...(raw.answersOnly === true && { answersOnly: true }),
  };
}

function abortReason(signal: AbortSignal): unknown {
  return signal.reason ?? new DOMException("The operation was aborted", "AbortError");
}

export function runDshPlan(options: {
  binary: string;
  plan: string;
  cwd?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  onStderr?: (chunk: string) => void;
}): Promise<DshPlanResult> {
  return new Promise((resolve, reject) => {
    const { signal } = options;
    if (signal?.aborted) {
      reject(abortReason(signal));
      return;
    }

    const cwd = options.cwd && isDirectory(options.cwd) ? options.cwd : undefined;
    const child = spawn(options.binary, ["dsh-plan"], {
      cwd,
      env: {
        ...(options.env ?? process.env),
        PLANNOTATOR_ORIGIN: "dsh",
        ...(cwd && { PLANNOTATOR_CWD: cwd }),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    let stdout = "";
    let stderr = "";
    let startError: Error | undefined;
    let forceKill: ReturnType<typeof setTimeout> | undefined;
    const onAbort = () => {
      child.kill("SIGTERM");
      forceKill = setTimeout(() => child.kill("SIGKILL"), 1000);
    };
    signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      options.onStderr?.(chunk);
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ plan: options.plan, ...(cwd && { cwd }) }));

    child.once("error", (error) => {
      startError = error;
    });
    child.once("close", (code) => {
      signal?.removeEventListener("abort", onAbort);
      if (forceKill !== undefined) clearTimeout(forceKill);
      if (signal?.aborted) {
        reject(abortReason(signal));
        return;
      }
      if (startError) {
        reject(startError);
        return;
      }
      if (code !== 0) {
        const lastLine = stderr.trim().split(/\r?\n/).pop();
        reject(new Error(lastLine || `plannotator dsh-plan exited with code ${code}`));
        return;
      }
      try {
        resolve(parseDshPlanOutput(stdout));
      } catch (error) {
        reject(error);
      }
    });
  });
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}
