/**
 * Git utilities for code review
 *
 * Centralized git operations for diff collection and branch detection.
 * Used by both Claude Code hook and OpenCode plugin.
 */

import {
  type DiffOption,
  type DiffResult,
  type DiffType,
  type GitCommandResult,
  type GitCommandOptions,
  type GitContext,
  type GitDiffOptions,
  type ReviewGitRuntime,
  type WorktreeInfo,
  getCurrentBranch as getCurrentBranchCore,
  getDefaultBranch as getDefaultBranchCore,
  getWorktrees as getWorktreesCore,
  getGitContext as getGitContextCore,
  getFileContentsForDiff as getFileContentsForDiffCore,
  gitAddFile as gitAddFileCore,
  gitResetFile as gitResetFileCore,
  parseWorktreeDiffType,
  prepareGitCommand,
  runGitDiff as runGitDiffCore,
  runGitDiffWithContext as runGitDiffWithContextCore,
  validateFilePath,
} from "@plannotator/shared/review-core";

export type {
  DiffOption,
  DiffType,
  DiffResult,
  GitContext,
  GitDiffOptions,
  WorktreeInfo,
} from "@plannotator/shared/review-core";

async function runGit(
  args: string[],
  options?: GitCommandOptions,
): Promise<GitCommandResult> {
  const command = prepareGitCommand(args, options, process.env);
  const proc = Bun.spawn(["git", ...command.args], {
    cwd: options?.cwd,
    detached: command.isolateProcessGroup,
    env: command.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  if (options?.timeoutMs) {
    timer = setTimeout(() => {
      if (command.isolateProcessGroup && process.platform !== "win32") {
        try {
          process.kill(-proc.pid, "SIGKILL");
          return;
        } catch {
          // Fall through when the process exited between the timer and signal.
        }
      }
      if (command.isolateProcessGroup && process.platform === "win32") {
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
}

/** Bun-based git runtime. Exported for use with shared utilities (worktree, etc.) */
export const runtime: ReviewGitRuntime = {
  runGit,
  async readTextFile(path: string): Promise<string | null> {
    try {
      return await Bun.file(path).text();
    } catch {
      return null;
    }
  },
};

export function getCurrentBranch(): Promise<string> {
  return getCurrentBranchCore(runtime);
}

export function getDefaultBranch(): Promise<string> {
  return getDefaultBranchCore(runtime);
}

export function getWorktrees(): Promise<WorktreeInfo[]> {
  return getWorktreesCore(runtime);
}

export function getGitContext(cwd?: string): Promise<GitContext> {
  return getGitContextCore(runtime, cwd);
}

export function runGitDiff(
  diffType: DiffType,
  defaultBranch: string = "main",
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runGitDiffCore(runtime, diffType, defaultBranch, cwd, options);
}

export function runGitDiffWithContext(
  diffType: DiffType,
  gitContext: GitContext,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  return runGitDiffWithContextCore(runtime, diffType, gitContext, options);
}

export function getFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  return getFileContentsForDiffCore(
    runtime,
    diffType,
    defaultBranch,
    filePath,
    oldPath,
    cwd,
  );
}

export function gitAddFile(
  filePath: string,
  cwd?: string,
): Promise<void> {
  return gitAddFileCore(runtime, filePath, cwd);
}

export function gitResetFile(
  filePath: string,
  cwd?: string,
): Promise<void> {
  return gitResetFileCore(runtime, filePath, cwd);
}

export { parseWorktreeDiffType, validateFilePath };
