/**
 * VCS dispatch layer
 *
 * Provides a provider-based abstraction over version control systems.
 * Each VCS (Git, P4, etc.) registers as a provider. The dispatch layer
 * auto-detects the active VCS and routes operations accordingly.
 *
 * To add a new VCS:
 * 1. Implement the VcsProvider interface
 * 2. Add it to the `providers` array below (detection order matters)
 */

import {
  type DiffResult,
  type DiffType,
  type GitContext,
  type GitDiffOptions,
  detectRemoteDefaultBranch,
} from "@plannotator/shared/review-core";

import {
  getGitContext,
  runGitDiff,
  getFileContentsForDiff as gitGetFileContentsForDiff,
  gitAddFile,
  gitResetFile,
  parseWorktreeDiffType,
  validateFilePath,
  runtime as gitRuntime,
} from "./git";

import {
  detectP4Workspace,
  getP4Context,
  runP4Diff,
  getP4FileContentsForDiff,
} from "./p4";
import {
  detectJjWorkspace,
  getJjContext,
  runJjDiff,
  getJjFileContentsForDiff,
} from "./jj";

// --- VCS Provider interface ---

export interface VcsProvider {
  /** Unique identifier for this VCS backend */
  readonly id: string;

  /** Detect whether the given directory is managed by this VCS */
  detect(cwd?: string): Promise<boolean>;

  /** Check if a DiffType belongs to this provider */
  ownsDiffType(diffType: string): boolean;

  /** Build context with branch info and available diff options */
  getContext(cwd?: string): Promise<GitContext>;

  /** Get unified diff patch for the given diff type */
  runDiff(diffType: DiffType, defaultBranch: string, cwd?: string, options?: GitDiffOptions): Promise<DiffResult>;

  /** Get old/new file contents for hunk expansion */
  getFileContents(
    diffType: DiffType,
    defaultBranch: string,
    filePath: string,
    oldPath?: string,
    cwd?: string,
  ): Promise<{ oldContent: string | null; newContent: string | null }>;

  /** Stage a file (optional — not all VCS support staging) */
  stageFile?(filePath: string, cwd?: string): Promise<void>;

  /** Unstage a file (optional — not all VCS support staging) */
  unstageFile?(filePath: string, cwd?: string): Promise<void>;

  /** Resolve effective cwd from a diff type (e.g. worktree path) */
  resolveCwd?(diffType: string, fallbackCwd?: string): string | undefined;

  /** Detect a remote/default compare target when supported */
  detectRemoteDefaultCompareTarget?(cwd?: string): Promise<string | null>;
}

// --- Git provider ---

const GIT_DIFF_TYPES = new Set(["uncommitted", "staged", "unstaged", "last-commit", "branch", "merge-base", "all"]);

const gitProvider: VcsProvider = {
  id: "git",

  async detect(cwd?: string): Promise<boolean> {
    try {
      const proc = Bun.spawn(["git", "rev-parse", "--is-inside-work-tree"], {
        cwd: cwd ?? undefined,
        stdout: "ignore",
        stderr: "ignore",
      });
      return (await proc.exited) === 0;
    } catch {
      // git not installed or not in PATH
      return false;
    }
  },

  ownsDiffType(diffType: string): boolean {
    return GIT_DIFF_TYPES.has(diffType) || diffType.startsWith("worktree:");
  },

  getContext: getGitContext,

  runDiff(diffType: DiffType, defaultBranch: string, cwd?: string, options?: GitDiffOptions) {
    return runGitDiff(diffType, defaultBranch, cwd, options);
  },

  getFileContents(diffType, defaultBranch, filePath, oldPath?, cwd?) {
    return gitGetFileContentsForDiff(diffType, defaultBranch, filePath, oldPath, cwd);
  },

  stageFile: gitAddFile,
  unstageFile: gitResetFile,

  detectRemoteDefaultCompareTarget(cwd?: string): Promise<string | null> {
    return detectRemoteDefaultBranch(gitRuntime, cwd);
  },

  resolveCwd(diffType: string, fallbackCwd?: string): string | undefined {
    if (diffType.startsWith("worktree:")) {
      const parsed = parseWorktreeDiffType(diffType);
      if (parsed) {
        return parsed.path;
      }
    }
    return fallbackCwd;
  },
};

// --- JJ provider ---

const JJ_DIFF_TYPES = new Set(["jj-current", "jj-last", "jj-line", "jj-all"]);

const jjProvider: VcsProvider = {
  id: "jj",

  async detect(cwd?: string): Promise<boolean> {
    return (await detectJjWorkspace(cwd)) !== null;
  },

  ownsDiffType(diffType: string): boolean {
    return JJ_DIFF_TYPES.has(diffType);
  },

  getContext: getJjContext,

  runDiff(diffType: DiffType, defaultBranch: string, cwd?: string, options?: GitDiffOptions) {
    return runJjDiff(diffType, defaultBranch, cwd, options);
  },

  getFileContents(diffType, defaultBranch, filePath, oldPath?, cwd?) {
    return getJjFileContentsForDiff(diffType, defaultBranch, filePath, oldPath, cwd);
  },
};

// --- P4 provider ---

const p4Provider: VcsProvider = {
  id: "p4",

  async detect(cwd?: string): Promise<boolean> {
    return (await detectP4Workspace(cwd)) !== null;
  },

  ownsDiffType(diffType: string): boolean {
    return diffType === "p4-default" || diffType.startsWith("p4-changelist:");
  },

  getContext: getP4Context,

  runDiff(diffType: DiffType, _defaultBranch: string, cwd?: string, _options?: GitDiffOptions) {
    return runP4Diff(diffType, cwd);
  },

  getFileContents(diffType, _defaultBranch, filePath, _oldPath?, cwd?) {
    return getP4FileContentsForDiff(diffType, filePath, cwd);
  },

  // P4 has no staging concept — stageFile/unstageFile intentionally omitted
};

// --- Provider registry ---

/** Providers in detection priority order. First match wins. */
const providers: VcsProvider[] = [jjProvider, gitProvider, p4Provider];

// Re-export types consumers need
export type {
  DiffType,
  DiffOption,
  GitContext,
  WorktreeInfo,
} from "./git";

export { parseWorktreeDiffType, validateFilePath, runtime as gitRuntime } from "./git";

// --- Detection cache ---

const vcsCache = new Map<string, VcsProvider>();

/** Detect which VCS manages the given directory */
export async function detectVcs(cwd?: string): Promise<VcsProvider> {
  const key = cwd ?? process.cwd();
  const cached = vcsCache.get(key);
  if (cached) {
    return cached;
  }

  for (const provider of providers) {
    if (await provider.detect(cwd)) {
      vcsCache.set(key, provider);
      return provider;
    }
  }

  // Default to git (existing behavior)
  vcsCache.set(key, gitProvider);
  return gitProvider;
}

/** Find the provider that owns a given diff type */
function getProviderForDiffType(diffType: string): VcsProvider | null {
  for (const provider of providers) {
    if (provider.ownsDiffType(diffType)) {
      return provider;
    }
  }
  return null;
}

async function getProviderForOperation(
  diffType: string,
  cwd?: string,
): Promise<VcsProvider> {
  return getProviderForDiffType(diffType) ?? detectVcs(cwd);
}

// --- Public API ---

export async function getVcsContext(cwd?: string): Promise<GitContext> {
  const provider = await detectVcs(cwd);
  return provider.getContext(cwd);
}

export async function detectRemoteDefaultCompareTarget(cwd?: string): Promise<string | null> {
  const provider = await detectVcs(cwd);
  return provider.detectRemoteDefaultCompareTarget?.(cwd) ?? null;
}

export function resolveInitialDiffType(
  gitContext: GitContext,
  configuredDiffType: DiffType,
): DiffType {
  if (gitContext.vcsType === "p4") {
    return "p4-default";
  }
  if (gitContext.vcsType === "jj") {
    return "jj-current";
  }
  if (gitContext.diffOptions.some((option) => option.id === configuredDiffType)) {
    return configuredDiffType;
  }

  const fallback = gitContext.diffOptions[0]?.id;
  return fallback ? fallback as DiffType : configuredDiffType;
}

export async function runVcsDiff(
  diffType: DiffType,
  defaultBranch: string = "main",
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  const provider = await getProviderForOperation(diffType, cwd);
  return provider.runDiff(diffType, defaultBranch, cwd, options);
}

export async function getVcsFileContentsForDiff(
  diffType: DiffType,
  defaultBranch: string,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  const provider = await getProviderForOperation(diffType, cwd);
  return provider.getFileContents(diffType, defaultBranch, filePath, oldPath, cwd);
}

/** Check if the given diff type supports file staging */
export async function canStageFiles(diffType: string, cwd?: string): Promise<boolean> {
  const provider = await getProviderForOperation(diffType, cwd);
  return provider.stageFile !== undefined;
}

/** Stage a file. Throws if the VCS doesn't support staging. */
export async function stageFile(
  diffType: string,
  filePath: string,
  cwd?: string,
): Promise<void> {
  const provider = await getProviderForOperation(diffType, cwd);
  if (!provider.stageFile) {
    throw new Error(`Staging not available for ${provider.id}`);
  }
  return provider.stageFile(filePath, cwd);
}

/** Unstage a file. Throws if the VCS doesn't support staging. */
export async function unstageFile(
  diffType: string,
  filePath: string,
  cwd?: string,
): Promise<void> {
  const provider = await getProviderForOperation(diffType, cwd);
  if (!provider.unstageFile) {
    throw new Error(`Unstaging not available for ${provider.id}`);
  }
  return provider.unstageFile(filePath, cwd);
}

/**
 * Resolve the operation cwd for diff types that encode their own workspace
 * path (for example Git worktree diffs), otherwise preserve the fallback cwd.
 */
export function resolveVcsCwd(
  diffType: string,
  fallbackCwd?: string,
): string | undefined {
  if (diffType.startsWith("worktree:")) {
    const provider = getProviderForDiffType(diffType);
    return provider?.resolveCwd?.(diffType, fallbackCwd) ?? fallbackCwd;
  }

  return fallbackCwd;
}
