/**
 * Bun command adapter for the shared GitButler review provider.
 *
 * GitButler support was originally proposed by Dan Susman in PR #566.
 */

import type {
  GitCommandOptions,
  GitCommandResult,
} from "@plannotator/shared/review-core";
import type { ReviewGitButlerRuntime } from "@plannotator/shared/gitbutler-core";

import { runtime as gitRuntime } from "./git";

async function runBut(
  args: string[],
  options?: GitCommandOptions,
): Promise<GitCommandResult> {
  try {
    const proc = Bun.spawn(["but", ...args], {
      cwd: options?.cwd,
      detached: true,
      env: { ...process.env, NO_BG_TASKS: "1" },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      windowsHide: true,
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    if (options?.timeoutMs) {
      timer = setTimeout(() => {
        if (process.platform !== "win32") {
          try {
            process.kill(-proc.pid, "SIGKILL");
            return;
          } catch {
            // Fall through when the process exited between the timer and signal.
          }
        } else {
          const killed = Bun.spawnSync(
            ["taskkill.exe", "/pid", String(proc.pid), "/t", "/f"],
            { stdin: "ignore", stdout: "ignore", stderr: "ignore", windowsHide: true },
          );
          if (killed.exitCode === 0) return;
        }
        proc.kill("SIGKILL");
      }, options.timeoutMs);
    }

    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    if (timer) clearTimeout(timer);
    return { stdout, stderr, exitCode };
  } catch {
    return { stdout: "", stderr: "but not found", exitCode: 1 };
  }
}

/** Bun Git + GitButler runtime used by the review server. */
export const runtime: ReviewGitButlerRuntime = {
  ...gitRuntime,
  runBut,
};
