/**
 * VCS dispatch layer
 *
 * Auto-detects Git or Perforce and routes to the appropriate backend.
 * Provides a unified interface for the review server.
 */

import {
  type DiffResult,
  type DiffType,
  type GitContext,
  isP4DiffType,
} from "@plannotator/shared/review-core";

import {
  getGitContext,
  runGitDiff,
  getFileContentsForDiff as gitGetFileContentsForDiff,
  gitAddFile,
  gitResetFile,
  parseWorktreeDiffType,
  validateFilePath,
} from "./git";

import {
  detectP4Workspace,
  getP4Context,
  runP4Diff,
  getP4FileContentsForDiff,
} from "./p4";

export type VcsBackend = "git" | "p4";

// Re-export types and utilities consumers need
export type {
  DiffType,
  DiffOption,
  GitContext,
  WorktreeInfo,
} from "./git";

export { parseWorktreeDiffType, validateFilePath } from "./git";
export { gitAddFile, gitResetFile } from "./git";
export { isP4DiffType } from "@plannotator/shared/review-core";

// Cache detected VCS per cwd
const vcsCache = new Map<string, VcsBackend>();

export async function detectVcs(cwd?: string): Promise<VcsBackend> {
  const key = cwd ?? process.cwd();
  const cached = vcsCache.get(key);
  if (cached) return cached;

  // Try git first — only need exit code, ignore output
  const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
    cwd: cwd ?? undefined,
    stdout: "ignore",
    stderr: "ignore",
  });
  const exitCode = await proc.exited;

  if (exitCode === 0) {
    vcsCache.set(key, "git");
    return "git";
  }

  // Try P4
  const p4Info = await detectP4Workspace(cwd);
  if (p4Info) {
    vcsCache.set(key, "p4");
    return "p4";
  }

  // Default to git (existing behavior)
  vcsCache.set(key, "git");
  return "git";
}

export async function getVcsContext(cwd?: string): Promise<GitContext> {
  const vcs = await detectVcs(cwd);
  if (vcs === "p4") return getP4Context(cwd);
  return getGitContext(cwd);
}

export async function runVcsDiff(
  diffType: DiffType,
  defaultBranch: string = "main",
  cwd?: string,
): Promise<DiffResult> {
  if (isP4DiffType(diffType)) {
    return runP4Diff(diffType, cwd);
  }
  return runGitDiff(diffType, defaultBranch, cwd);
}

export async function getVcsFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  if (isP4DiffType(diffType)) {
    return getP4FileContentsForDiff(diffType, filePath, cwd);
  }
  return gitGetFileContentsForDiff(diffType, defaultBranch, filePath, oldPath, cwd);
}
