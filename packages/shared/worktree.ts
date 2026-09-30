/**
 * Worktree — runtime-agnostic git worktree primitives.
 *
 * Uses ReviewGitRuntime so both Bun and Node runtimes can use the same logic.
 * Lives in packages/shared/ and gets vendored to Pi via vendor.sh.
 *
 * Designed as composable primitives, not tied to any specific use case.
 * PR local checkout, agent sandboxes, parallel sessions — all compose from these.
 */

import type { ReviewGitRuntime } from "./review-core";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CreateWorktreeOptions {
  /** Git ref to check out (branch name, SHA, FETCH_HEAD, etc.) */
  ref: string;
  /** Absolute path where the worktree will be created. */
  path: string;
  /** Create in detached HEAD mode (no branch). Default: false. */
  detach?: boolean;
  /** CWD of the source repository. Defaults to process.cwd(). */
  cwd?: string;
}

export interface RemoveWorktreeOptions {
  /** Force removal even if the worktree has modifications. Default: false. */
  force?: boolean;
  /** CWD of the source repository. Required if the worktree was created from a different cwd. */
  cwd?: string;
}

// ---------------------------------------------------------------------------
// Primitives
// ---------------------------------------------------------------------------

/**
 * Fetch a ref from origin.
 * Runs: `git fetch origin <ref>`
 * Throws on failure.
 */
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

/**
 * Ensure a git object (commit SHA) is available locally.
 * Checks with `git cat-file -t`, fetches from origin if missing.
 * Returns true if the object is available after the attempt.
 */
export async function ensureObjectAvailable(
  runtime: ReviewGitRuntime,
  sha: string,
  options?: { cwd?: string },
): Promise<boolean> {
  const check = await runtime.runGit(["cat-file", "-t", sha], { cwd: options?.cwd });
  if (check.exitCode === 0) return true;

  // Object missing locally — try fetching it
  const fetch = await runtime.runGit(["fetch", "origin", "--", sha], { cwd: options?.cwd });
  if (fetch.exitCode !== 0) return false;

  // Verify it's now available
  const recheck = await runtime.runGit(["cat-file", "-t", sha], { cwd: options?.cwd });
  return recheck.exitCode === 0;
}

/**
 * Create a git worktree.
 * Runs: `git worktree add [--detach] <path> <ref>`
 * Throws on failure with a descriptive error.
 */
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

/**
 * Remove a git worktree. Best-effort — logs errors but does not throw.
 * Runs: `git worktree remove [--force] <path>`
 */
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
