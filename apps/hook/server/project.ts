/**
 * Project Detection Utility
 *
 * Detects the current project name for tagging plans.
 * Priority: git repo name > directory name > null
 */

import { $ } from "bun";

/**
 * Sanitize a string for use as a tag
 * - lowercase
 * - replace spaces/underscores with hyphens
 * - remove special characters
 * - trim to reasonable length
 */
export function sanitizeTag(name: string): string | null {
  if (!name || typeof name !== "string") return null;

  const sanitized = name
    .toLowerCase()
    .trim()
    .replace(/[\s_]+/g, "-")      // spaces/underscores -> hyphens
    .replace(/[^a-z0-9-]/g, "")   // remove special chars
    .replace(/-+/g, "-")          // collapse multiple hyphens
    .replace(/^-|-$/g, "")        // trim leading/trailing hyphens
    .slice(0, 30);                // max 30 chars

  return sanitized.length >= 2 ? sanitized : null;
}

/**
 * Extract repo name from a git root path
 */
export function extractRepoName(gitRootPath: string): string | null {
  if (!gitRootPath || typeof gitRootPath !== "string") return null;

  const trimmed = gitRootPath.trim().replace(/\/+$/, ""); // remove trailing slashes
  const parts = trimmed.split("/");
  const name = parts[parts.length - 1];

  return sanitizeTag(name);
}

/**
 * Extract directory name from a path
 */
export function extractDirName(path: string): string | null {
  if (!path || typeof path !== "string") return null;

  const trimmed = path.trim().replace(/\/+$/, "");
  if (trimmed === "" || trimmed === "/") return null;

  const parts = trimmed.split("/");
  const name = parts[parts.length - 1];

  // Skip generic names
  const skipNames = new Set(["home", "users", "user", "root", "tmp", "var"]);
  if (skipNames.has(name.toLowerCase())) return null;

  return sanitizeTag(name);
}

/**
 * Detect project name from current context
 *
 * Priority:
 * 1. Git repository name (most reliable)
 * 2. Current directory name (fallback)
 * 3. null (if nothing useful found)
 */
export async function detectProjectName(): Promise<string | null> {
  // Try git repo name first
  try {
    const result = await $`git rev-parse --show-toplevel`.quiet().nothrow();
    if (result.exitCode === 0) {
      const repoName = extractRepoName(result.stdout.toString());
      if (repoName) return repoName;
    }
  } catch {
    // Git not available or not in a repo - continue to fallback
  }

  // Fallback to current directory name
  try {
    const cwd = process.cwd();
    const dirName = extractDirName(cwd);
    if (dirName) return dirName;
  } catch {
    // process.cwd() failed (rare)
  }

  return null;
}
