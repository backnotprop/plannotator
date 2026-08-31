/**
 * Project Detection Utility
 *
 * Detects the current project name for tagging plans.
 * Priority: git repo name > directory name > null
 *
 * Pure string functions re-exported from @plannotator/shared/project.
 * detectProjectName() is Bun-specific (uses Bun.$).
 */

import { $ } from "bun";
import { extractRepoName, extractDirName } from "@plannotator/shared/project";
export { sanitizeTag, extractRepoName, extractDirName } from "@plannotator/shared/project";

/**
 * Detect project name from current context
 *
 * Priority:
 * 1. Git repository name (most reliable)
 * 2. Current directory name (fallback)
 * 3. null (if nothing useful found)
 */
export async function detectProjectName(directory?: string): Promise<string | null> {
  let cwd: string;
  try {
    cwd = directory ?? process.cwd();
  } catch {
    return null;
  }

  // Try git repo name first
  try {
    const result = await $`git rev-parse --show-toplevel`.cwd(cwd).quiet().nothrow();
    if (result.exitCode === 0) {
      const repoName = extractRepoName(result.stdout.toString());
      if (repoName) return repoName;
    }
  } catch {
    // Git not available or not in a repo - continue to fallback
  }

  // Fallback to current directory name
  try {
    const dirName = extractDirName(cwd);
    if (dirName) return dirName;
  } catch {
    // process.cwd() failed (rare)
  }

  return null;
}
