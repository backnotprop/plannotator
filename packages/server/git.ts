/**
 * Git utilities for code review
 *
 * Centralized git operations for diff collection and branch detection.
 * Used by both Claude Code hook and OpenCode plugin.
 */

import { $ } from "bun";

export type DiffType =
  | "uncommitted"
  | "staged"
  | "unstaged"
  | "last-commit"
  | "branch";

export interface DiffOption {
  id: DiffType | "separator";
  label: string;
}

export interface GitContext {
  currentBranch: string;
  defaultBranch: string;
  diffOptions: DiffOption[];
}

export interface DiffResult {
  patch: string;
  label: string;
  error?: string;
}

/**
 * Get the current branch name
 */
export async function getCurrentBranch(): Promise<string> {
  try {
    const result = await $`git rev-parse --abbrev-ref HEAD`.quiet();
    return result.text().trim();
  } catch {
    return "HEAD"; // Detached HEAD state
  }
}

/**
 * Detect the default branch (main, master, etc.)
 *
 * Strategy:
 * 1. Check origin's HEAD reference
 * 2. Fallback to checking if 'main' exists
 * 3. Final fallback to 'master'
 */
export async function getDefaultBranch(): Promise<string> {
  // Try origin's HEAD first (most reliable for repos with remotes)
  try {
    const result =
      await $`git symbolic-ref refs/remotes/origin/HEAD`.quiet();
    const ref = result.text().trim();
    return ref.replace("refs/remotes/origin/", "");
  } catch {
    // No remote or no HEAD set - check local branches
  }

  // Fallback: check if main exists locally
  try {
    await $`git show-ref --verify refs/heads/main`.quiet();
    return "main";
  } catch {
    // main doesn't exist
  }

  // Final fallback
  return "master";
}

/**
 * Get git context including branch info and available diff options
 */
export async function getGitContext(): Promise<GitContext> {
  const [currentBranch, defaultBranch] = await Promise.all([
    getCurrentBranch(),
    getDefaultBranch(),
  ]);

  const diffOptions: DiffOption[] = [
    { id: "uncommitted", label: "Uncommitted changes" },
    { id: "last-commit", label: "Last commit" },
  ];

  // Only show branch diff if not on default branch
  if (currentBranch !== defaultBranch) {
    diffOptions.push({ id: "branch", label: `vs ${defaultBranch}` });
  }

  return { currentBranch, defaultBranch, diffOptions };
}

/**
 * Get diffs for untracked (new) files not yet added to git.
 *
 * `git diff HEAD` and `git diff` only show tracked files. Newly created files
 * that haven't been staged with `git add` are invisible to those commands.
 * This helper discovers them via `git ls-files --others --exclude-standard` and
 * generates a proper unified diff for each using `git diff --no-index`.
 *
 * Note: `git diff --no-index` exits with code 1 when files differ (standard git
 * behaviour), so we use `.nothrow()` to avoid treating that as an error.
 */
async function getUntrackedFileDiffs(srcPrefix = 'a/', dstPrefix = 'b/'): Promise<string> {
  try {
    const output = (await $`git ls-files --others --exclude-standard`.quiet()).text();
    const files = output.trim().split('\n').filter((f) => f.length > 0);
    if (files.length === 0) return '';

    const diffs = await Promise.all(
      files.map(async (file) => {
        try {
          const result = await $`git diff --no-index --src-prefix=${srcPrefix} --dst-prefix=${dstPrefix} /dev/null ${file}`
            .quiet()
            .nothrow();
          return result.text();
        } catch {
          return '';
        }
      }),
    );
    return diffs.join('');
  } catch {
    return '';
  }
}

/**
 * Run git diff with the specified type
 */
export async function runGitDiff(
  diffType: DiffType,
  defaultBranch: string = "main"
): Promise<DiffResult> {
  let patch: string;
  let label: string;

  try {
    switch (diffType) {
      case "uncommitted": {
        // Include tracked changes (staged + unstaged vs HEAD) and untracked new files
        const trackedDiff = (await $`git diff HEAD --src-prefix=a/ --dst-prefix=b/`.quiet()).text();
        const untrackedDiff = await getUntrackedFileDiffs();
        patch = trackedDiff + untrackedDiff;
        label = "Uncommitted changes";
        break;
      }

      case "staged":
        patch = (await $`git diff --staged --src-prefix=a/ --dst-prefix=b/`.quiet()).text();
        label = "Staged changes";
        break;

      case "unstaged": {
        // Include unstaged changes to tracked files and untracked new files
        const trackedDiff = (await $`git diff --src-prefix=a/ --dst-prefix=b/`.quiet()).text();
        const untrackedDiff = await getUntrackedFileDiffs();
        patch = trackedDiff + untrackedDiff;
        label = "Unstaged changes";
        break;
      }

      case "last-commit":
        patch = (await $`git diff HEAD~1..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet()).text();
        label = "Last commit";
        break;

      case "branch":
        patch = (await $`git diff ${defaultBranch}..HEAD --src-prefix=a/ --dst-prefix=b/`.quiet()).text();
        label = `Changes vs ${defaultBranch}`;
        break;

      default:
        patch = "";
        label = "Unknown diff type";
    }
  } catch (error) {
    // Handle errors gracefully (e.g., no commits yet, invalid ref)
    console.error(`Git diff error for ${diffType}:`, error);
    const errorMessage = error instanceof Error ? error.message : String(error);
    patch = "";
    label = `Error: ${diffType}`;
    return { patch, label, error: errorMessage };
  }

  return { patch, label };
}
