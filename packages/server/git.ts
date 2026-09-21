/**
 * Git utilities for code review
 *
 * Centralized git operations for diff collection and branch detection.
 * Used by both Claude Code hook and OpenCode plugin.
 */

import { lstat, readlink } from "node:fs/promises";
import { resolve as resolvePath } from "node:path";

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

/**
 * Process-group leaders of git commands started with `interaction: "forbid"`
 * (#1553). Those run detached in their own group so a timeout can kill the
 * whole transport tree — but a server that exits while one is still in flight
 * left the git/ssh pair orphaned: the parent-side timer dies with the parent,
 * so nothing was ever going to reap them. On a smartcard-backed SSH setup the
 * orphan keeps the agent busy long after the review window closed.
 *
 * POSIX only: the negative-pid group signal has no Windows equivalent, and the
 * timeout path already special-cases win32 with taskkill. A Windows exit is
 * left as it was rather than spawning a process from an exit handler.
 */
const isolatedGitGroups = new Set<number>();
let isolatedGitExitHookInstalled = false;

function reapIsolatedGitGroups(): void {
  for (const pid of isolatedGitGroups) {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone, or the group leader exited between the last read and here.
    }
  }
  isolatedGitGroups.clear();
}

function trackIsolatedGitGroup(pid: number): () => void {
  if (process.platform === "win32") return () => {};
  if (!isolatedGitExitHookInstalled) {
    isolatedGitExitHookInstalled = true;
    // "exit" only: it runs on every process.exit(), which is where this
    // server's SIGINT/SIGTERM handling already routes, and the callback must
    // be synchronous — process.kill is.
    process.on("exit", reapIsolatedGitGroups);
  }
  isolatedGitGroups.add(pid);
  return () => isolatedGitGroups.delete(pid);
}

async function runGit(
  args: string[],
  options?: GitCommandOptions,
): Promise<GitCommandResult> {
  const command = prepareGitCommand(args, options, process.env);
  const proc = Bun.spawn(["git", ...command.args], {
    cwd: options?.cwd,
    detached: command.isolateProcessGroup,
    env: command.env,
    stdin: options?.stdin === undefined
      ? "ignore"
      : new TextEncoder().encode(options.stdin),
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });

  const untrack = command.isolateProcessGroup
    ? trackIsolatedGitGroup(proc.pid)
    : undefined;

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
  untrack?.();

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
  async getFileInfo(basePath, path) {
    const fullPath = resolvePath(basePath ?? "", path);
    try {
      const fileStat = await lstat(fullPath);
      return {
        path: fullPath,
        size: fileStat.size,
        mtimeMs: fileStat.mtimeMs,
        isFile: fileStat.isFile(),
        isSymbolicLink: fileStat.isSymbolicLink(),
        isExecutable: (fileStat.mode & 0o111) !== 0,
      };
    } catch {
      return null;
    }
  },
  async readLink(path: string): Promise<string | null> {
    try {
      return await readlink(path);
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
