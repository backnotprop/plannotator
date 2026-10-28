/**
 * The hover cards' `gh` / `glab` runner on Node (the Pi extension's servers;
 * vendored to Pi). The same contract as the Bun runner in
 * `packages/server/ref-cards.ts`: the live env plus no prompt and no color,
 * stdin closed, killed after `REF_TIMEOUT_MS`, exit 127 when the CLI is not
 * installed. No shell: the arguments go to the program as they are.
 */

import { spawn } from "node:child_process";
import { REF_TIMEOUT_MS, type RefRunner } from "./ref-cards";

/** A runner with its own time limit (tests); `nodeRefCliRunner` is the real one. */
export function createNodeRefCliRunner(timeoutMs: number = REF_TIMEOUT_MS): RefRunner {
  return (cli, args, env) =>
    new Promise((resolve) => {
      let child: ReturnType<typeof spawn>;
      try {
        child = spawn(cli, args, {
          env: { ...process.env, GH_PROMPT_DISABLED: "1", NO_COLOR: "1", NO_PROMPT: "1", ...env },
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
      } catch {
        resolve({ stdout: "", stderr: `${cli}: not found`, exitCode: 127 });
        return;
      }
      const out: Buffer[] = [];
      const err: Buffer[] = [];
      let settled = false;
      // At the limit: kill it and answer at once (a grandchild may keep the pipes open).
      const timer = setTimeout(() => {
        child.kill();
        child.stdout?.destroy();
        child.stderr?.destroy();
        finish(1, `${cli}: timed out`);
      }, timeoutMs);
      const finish = (exitCode: number, stderr?: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout: Buffer.concat(out).toString("utf8"), stderr: stderr ?? Buffer.concat(err).toString("utf8"), exitCode });
      };
      child.stdout?.on("data", (chunk: Buffer) => out.push(chunk));
      child.stderr?.on("data", (chunk: Buffer) => err.push(chunk));
      child.on("error", (e: NodeJS.ErrnoException) => {
        if (e.code === "ENOENT") finish(127, `${cli}: not found`);
        else finish(1, e.message);
      });
      // `close`, not `exit`: the pipes are drained by then. A killed child has no code.
      child.on("close", (code) => finish(code ?? 1));
    });
}

export const nodeRefCliRunner: RefRunner = createNodeRefCliRunner();
