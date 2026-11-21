/**
 * Project Detection Utility
 *
 * Detects the current project name for tagging plans.
 * Priority: git repo name > directory name > null
 *
 * Pure string functions re-exported from @plannotator/shared/project.
 * detectProjectName() is Bun-specific (uses Bun.spawn).
 */

import { childEnv } from "@plannotator/shared/child-env";
import { extractRepoName, extractDirName } from "@plannotator/shared/project";
export { sanitizeTag, extractRepoName, extractDirName } from "@plannotator/shared/project";

/**
 * A git command's stdout, or null when it fails. Bun.spawn rather than Bun
 * Shell, which cannot hide the console window git would open on Windows.
 */
export async function gitStdout(args: string[], cwd: string): Promise<string | null> {
  const proc = Bun.spawn(["git", ...args], { cwd, env: childEnv(), stdin: "ignore", stdout: "pipe", stderr: "ignore", windowsHide: true });
  const [stdout, exitCode] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
  return exitCode === 0 ? stdout : null;
}

/**
 * Detect project name from current context
 *
 * Priority:
 * 1. Git repository name (most reliable)
 * 2. Current directory name (fallback)
 * 3. null (if nothing useful found)
 */
export async function detectProjectName(cwd = process.cwd()): Promise<string | null> {
  // Try git repo name first
  try {
    const toplevel = await gitStdout(["rev-parse", "--show-toplevel"], cwd);
    if (toplevel !== null) {
      const repoName = extractRepoName(toplevel);
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
