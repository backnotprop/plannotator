/**
 * The Plannotator CLI as the DSH plugin runs it: finding the binary and the
 * internal `plannotator dsh-plan` round trip (contract in
 * apps/hook/server/dsh-plan.ts).
 *
 * Plain Node only: DSH loads the plugin in its own Node runtime.
 */

import { spawn } from "node:child_process";
import { accessSync, constants as fsConstants, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** One `dsh-plan` decision, as the CLI prints it on stdout. */
export interface DshPlanResult {
  approved: boolean;
  feedback?: string;
  /** The agent-facing text, already composed from the `dsh` prompt templates. */
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

/**
 * The plannotator binary to run: the plugin's `binary` config, then
 * PLANNOTATOR_BIN, then `plannotator` on PATH, then where the install scripts
 * put it (~/.local/bin, or %LOCALAPPDATA%\plannotator on Windows). The last
 * step matters for DSH Desktop, whose PATH often lacks ~/.local/bin.
 * Undefined when none is found.
 */
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

/** The last JSON line of the CLI's stdout, checked for the fields the plugin reads. */
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

/**
 * Run `plannotator dsh-plan` with the plan on stdin and resolve with its
 * decision. Rejects when the binary cannot start, exits non-zero, or prints
 * no decision, and with the signal's reason once an abort has stopped the
 * child (SIGTERM, then SIGKILL after a second). Settles only after the child
 * has exited.
 */
export function runDshPlan(options: {
  binary: string;
  plan: string;
  /** The DSH session's working directory; the review's project root. */
  cwd?: string;
  signal?: AbortSignal;
  env?: NodeJS.ProcessEnv;
  /** Each stderr chunk as it arrives (the CLI prints its URL there). */
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
    // A child that exits before reading stdin (a missing binary, an old CLI)
    // breaks the pipe; the close handler reports the real failure.
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
