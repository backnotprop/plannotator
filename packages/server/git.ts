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
      case "uncommitted":
        patch = (await $`git diff HEAD`.quiet()).text();
        label = "Uncommitted changes";
        break;

      case "staged":
        patch = (await $`git diff --staged`.quiet()).text();
        label = "Staged changes";
        break;

      case "unstaged":
        patch = (await $`git diff`.quiet()).text();
        label = "Unstaged changes";
        break;

      case "last-commit":
        patch = (await $`git diff HEAD~1..HEAD`.quiet()).text();
        label = "Last commit";
        break;

      case "branch":
        patch = (await $`git diff ${defaultBranch}..HEAD`.quiet()).text();
        label = `Changes vs ${defaultBranch}`;
        break;

      default:
        patch = "";
        label = "Unknown diff type";
    }
  } catch (error) {
    // Handle errors gracefully (e.g., no commits yet, invalid ref)
    console.error(`Git diff error for ${diffType}:`, error);
    patch = "";
    label = `Error: ${diffType}`;
  }

  return { patch, label };
}
