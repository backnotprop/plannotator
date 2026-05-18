import { spawn } from "node:child_process";
import type { PluginSessionInfo } from "@plannotator/shared/plugin-protocol";
import type { ScenarioCommand } from "../scenarios/types";
import { parseSessionReadyLine } from "./session-ready";

export interface ProcessRunResult {
  command: ScenarioCommand;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  timedOut: boolean;
  session?: PluginSessionInfo;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
  onSessionReady?: (session: PluginSessionInfo) => void;
  onLog?: (line: string) => void;
}

export function runPlannotatorCommand(
  command: ScenarioCommand,
  options: ProcessRunOptions = {},
): Promise<ProcessRunResult> {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const child = spawn(command.command, command.args, {
    cwd: command.cwd,
    env: { ...process.env, ...command.env },
    stdio: ["pipe", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let pendingStderr = "";
  let session: PluginSessionInfo | undefined;
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGTERM");
    const killTimer = setTimeout(() => child.kill("SIGKILL"), 1_000);
    killTimer.unref?.();
  }, timeoutMs);
  timeout.unref?.();

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  child.stdout.on("data", (chunk: string) => {
    stdout += chunk;
  });

  child.stderr.on("data", (chunk: string) => {
    stderr += chunk;
    pendingStderr += chunk;
    const lines = pendingStderr.split(/\r?\n/);
    pendingStderr = lines.pop() ?? "";
    for (const line of lines) {
      if (!line) continue;
      options.onLog?.(line);
      const ready = parseSessionReadyLine(line);
      if (ready && !session) {
        session = ready;
        options.onSessionReady?.(ready);
      }
    }
  });

  child.stdin.end(command.stdin ?? "");

  return new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (exitCode, signal) => {
      clearTimeout(timeout);
      if (pendingStderr) {
        options.onLog?.(pendingStderr);
        const ready = parseSessionReadyLine(pendingStderr);
        if (ready && !session) session = ready;
      }
      resolve({
        command,
        stdout,
        stderr,
        exitCode,
        signal,
        timedOut,
        ...(session && { session }),
      });
    });
  });
}
