/**
 * The hover cards' `gh` / `glab` runner on Node (the Pi extension's servers;
 * vendored to Pi). The same contract as the Bun runner in
 * `packages/server/ref-cards.ts`: the live env plus no prompt and no color,
 * stdin closed, exit 127 when the CLI is not installed, and a hard deadline
 * at `REF_TIMEOUT_MS`: the CLI and everything it started (its own process
 * group on POSIX) get TERM, then KILL (`refRunnerKill`), and the answer comes
 * at once. A CLI that exits while something it started still holds its output
 * is answered `REF_DRAIN_MS` later with what it printed, and that leftover is
 * ended. No shell: the arguments go to the program as they are.
 */

import { spawn } from "node:child_process";
import { childEnv } from "./child-env";
import { REF_DRAIN_MS, REF_TIMEOUT_MS, refRunnerKill, type RefRunner } from "./ref-cards";

/** A runner with its own time limit (tests); `nodeRefCliRunner` is the real one. */
export function createNodeRefCliRunner(timeoutMs: number = REF_TIMEOUT_MS): RefRunner {
  return (cli, args, env) =>
    new Promise((resolve) => {
      // Its own process group (POSIX), so the deadline reaches a wrapper's child or a helper the CLI started.
      const group = process.platform !== "win32";
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cli, args, {
          env: childEnv({ GH_PROMPT_DISABLED: "1", NO_COLOR: "1", NO_PROMPT: "1", ...env }),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
          detached: group,
        });
      } catch {
        resolve({ stdout: "", stderr: `${cli}: not found`, exitCode: 127 });
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      let drainTimer: ReturnType<typeof setTimeout> | null = null;
      const end = () =>
        refRunnerKill((signal) => {
          if (group && child.pid !== undefined) process.kill(-child.pid, signal);
          else if (!child.kill(signal)) throw new Error("gone");
        });
      const finish = (exitCode: number, stderr?: string, timedOut = false) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (drainTimer) clearTimeout(drainTimer);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: stderr ?? Buffer.concat(err).toString("utf8"), exitCode, ...(timedOut ? { timedOut } : {}) });
      };
      // At the limit: end it and everything it started, and answer at once.
      const timer = setTimeout(() => {
        end();
        finish(1, `${cli}: timed out`, true);
      }, timeoutMs);
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") finish(127, `${cli}: not found`);
        else finish(1, e.message);
      });
      // `close` once the pipes are drained. A killed child has no code.
      child.on("close", (code) => finish(code ?? 1));
      // Exited, but something it started may still hold the pipes: answer with what came, and end that leftover.
      child.on("exit", (code) => {
        if (settled) return;
        drainTimer = setTimeout(() => {
          end();
          finish(code ?? 1);
        }, REF_DRAIN_MS);
      });
    });
}

export const nodeRefCliRunner: RefRunner = createNodeRefCliRunner();
