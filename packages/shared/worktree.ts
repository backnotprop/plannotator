import type { ReviewGitRuntime } from "./review-core";

export interface CreateWorktreeOptions {
  ref: string;
  path: string;
  detach?: boolean;
  cwd?: string;
}

export interface RemoveWorktreeOptions {
  force?: boolean;
  cwd?: string;
}

export async function fetchRef(
  runtime: ReviewGitRuntime,
  ref: string,
  options?: { cwd?: string; remote?: string },
): Promise<void> {
  const remote = options?.remote ?? "origin";
  const result = await runtime.runGit(["fetch", remote, "--", ref], { cwd: options?.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git fetch ${remote} ${ref} failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }
}

export async function ensureObjectAvailable(
  runtime: ReviewGitRuntime,
  sha: string,
  options?: { cwd?: string },
): Promise<boolean> {
  const check = await runtime.runGit(["cat-file", "-t", sha], { cwd: options?.cwd });
  if (check.exitCode === 0) return true;

  const fetch = await runtime.runGit(["fetch", "origin", "--", sha], { cwd: options?.cwd });
  if (fetch.exitCode !== 0) return false;

  const recheck = await runtime.runGit(["cat-file", "-t", sha], { cwd: options?.cwd });
  return recheck.exitCode === 0;
}

export async function createWorktree(
  runtime: ReviewGitRuntime,
  options: CreateWorktreeOptions,
): Promise<{ worktreePath: string }> {
  const args = ["worktree", "add"];
  if (options.detach) args.push("--detach");
  args.push(options.path, options.ref);

  const result = await runtime.runGit(args, { cwd: options.cwd });
  if (result.exitCode !== 0) {
    throw new Error(`git worktree add failed: ${result.stderr.trim() || `exit code ${result.exitCode}`}`);
  }

  return { worktreePath: options.path };
}

/** Best-effort: logs errors but does not throw. */
export async function removeWorktree(
  runtime: ReviewGitRuntime,
  worktreePath: string,
  options?: RemoveWorktreeOptions,
): Promise<void> {
  const args = ["worktree", "remove"];
  if (options?.force) args.push("--force");
  args.push(worktreePath);

  try {
    const result = await runtime.runGit(args, { cwd: options?.cwd });
    if (result.exitCode !== 0) {
      console.error(`Warning: git worktree remove failed for ${worktreePath}: ${result.stderr.trim()}`);
    }
  } catch (err) {
    console.error(`Warning: worktree cleanup error: ${err instanceof Error ? err.message : String(err)}`);
  }
}
