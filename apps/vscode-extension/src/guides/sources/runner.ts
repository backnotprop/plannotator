/**
 * Running `git` and `gh` for the Guides view. Every data source takes a
 * `Runner`, so tests inject a scripted one and never touch a real repository
 * or the GitHub CLI.
 */

import { spawn } from "node:child_process";
import { augmentedPath, findExecutable } from "@plannotator/acp-client/which";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  stdin?: string;
  env?: Record<string, string | undefined>;
  /** Stop reading stdout past this many bytes (the result is then marked truncated). */
  maxOutputBytes?: number;
}

export type Runner = (command: string, args: string[], options?: RunOptions) => Promise<RunResult & { truncated?: boolean }>;

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_MAX_OUTPUT = 256 * 1024 * 1024;

// Finding programs lives with the ACP client (packages/acp-client/which.ts); kept here for the data sources.
export { augmentedPath, findExecutable };

/** The real runner: no shell, a timeout that kills the process, bounded output. */
export const defaultRunner: Runner = (command, args, options = {}) =>
  new Promise((resolve) => {
    const resolved = findExecutable(command) ?? command;
    let child;
    try {
      child = spawn(resolved, args, {
        cwd: options.cwd,
        env: { ...process.env, PATH: augmentedPath(), ...options.env },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch (err) {
      resolve({ code: 127, stdout: "", stderr: err instanceof Error ? err.message : String(err) });
      return;
    }
    const max = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT;
    const out: Buffer[] = [];
    const errOut: Buffer[] = [];
    let outBytes = 0;
    let truncated = false;
    let settled = false;
    const finish = (result: RunResult & { truncated?: boolean }) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ code: 124, stdout: Buffer.concat(out).toString("utf8"), stderr: `${Buffer.concat(errOut).toString("utf8")}\n(timed out)` });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      if (truncated) return;
      outBytes += chunk.length;
      if (outBytes > max) {
        truncated = true;
        child.kill("SIGKILL");
        return;
      }
      out.push(chunk);
    });
    child.stderr.on("data", (chunk: Buffer) => {
      if (errOut.reduce((n, b) => n + b.length, 0) < 1024 * 1024) errOut.push(chunk);
    });
    child.on("error", (err) => finish({ code: 127, stdout: "", stderr: err.message }));
    child.on("close", (code) =>
      finish({ code: code ?? 1, stdout: Buffer.concat(out).toString("utf8"), stderr: Buffer.concat(errOut).toString("utf8"), ...(truncated && { truncated }) }),
    );
    if (options.stdin !== undefined) child.stdin.end(options.stdin);
    else child.stdin.end();
  });
