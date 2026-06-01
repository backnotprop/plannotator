import {
  type DiffResult,
  type DiffType,
  type GitContext,
  type GitDiffOptions,
  type ReviewGitRuntime,
  detectRemoteDefaultBranch,
  getFileContentsForDiff as getGitFileContentsForDiff,
  getGitContext,
  gitAddFile,
  gitResetFile,
  parseWorktreeDiffType,
  runGitDiff,
} from "./review-core";
import { isAbsolute, relative, resolve } from "node:path";
import {
  type ReviewJjRuntime,
  detectJjWorkspace,
  getJjContext,
  getJjFileContentsForDiff,
  runJjDiff,
} from "./jj-core";

export type {
  DiffOption,
  DiffResult,
  DiffType,
  GitContext,
  GitDiffOptions,
  WorktreeInfo,
} from "./review-core";

export {
  JJ_TRUNK_REVSET,
  jjCompareTargetRevset,
  jjLineBaseRevset,
  parseRemoteBookmark,
  parseWorktreeDiffType,
  validateFilePath,
} from "./review-core";

export interface VcsProvider {
  readonly id: string;
  detect(cwd?: string): Promise<boolean>;
  getRoot?(cwd?: string): Promise<string | null>;
  ownsDiffType(diffType: string): boolean;
  canStageFiles?(diffType: string): boolean;
  getContext(cwd?: string): Promise<GitContext>;
  runDiff(diffType: DiffType, defaultBranch: string, cwd?: string, options?: GitDiffOptions): Promise<DiffResult>;
  getFileContents(
    diffType: DiffType,
    defaultBranch: string,
    filePath: string,
    oldPath?: string,
    cwd?: string,
  ): Promise<{ oldContent: string | null; newContent: string | null }>;
  stageFile?(filePath: string, cwd?: string): Promise<void>;
  unstageFile?(filePath: string, cwd?: string): Promise<void>;
  resolveCwd?(diffType: string, fallbackCwd?: string): string | undefined;
  detectRemoteDefaultCompareTarget?(cwd?: string): Promise<string | null>;
}

export type VcsSelection = "auto" | "git" | "jj" | "p4";

export interface VcsApi {
  detectVcs(cwd?: string): Promise<VcsProvider>;
  getVcsContext(cwd?: string, vcsType?: VcsSelection): Promise<GitContext>;
  detectRemoteDefaultCompareTarget(cwd?: string, vcsType?: VcsSelection): Promise<string | null>;
  prepareLocalReviewDiff(options: PrepareLocalReviewDiffOptions): Promise<PreparedLocalReviewDiff>;
  runVcsDiff(
    diffType: DiffType,
    defaultBranch?: string,
    cwd?: string,
    options?: GitDiffOptions,
  ): Promise<DiffResult>;
  getVcsFileContentsForDiff(
    diffType: DiffType,
    defaultBranch: string,
    filePath: string,
    oldPath?: string,
    cwd?: string,
  ): Promise<{ oldContent: string | null; newContent: string | null }>;
  canStageFiles(diffType: string, cwd?: string): Promise<boolean>;
  stageFile(diffType: string, filePath: string, cwd?: string): Promise<void>;
  unstageFile(diffType: string, filePath: string, cwd?: string): Promise<void>;
  resolveVcsCwd(diffType: string, fallbackCwd?: string): string | undefined;
}

export interface PrepareLocalReviewDiffOptions {
  cwd?: string;
  vcsType?: VcsSelection;
  requestedDiffType?: DiffType;
  requestedBase?: string;
  configuredDiffType: DiffType;
  hideWhitespace?: boolean;
}

export interface PreparedLocalReviewDiff {
  gitContext: GitContext;
  diffType: DiffType;
  base: string;
  rawPatch: string;
  gitRef: string;
  error?: string;
}

const GIT_DIFF_TYPES = new Set(["uncommitted", "staged", "unstaged", "last-commit", "branch", "merge-base", "all"]);
const JJ_DIFF_TYPES = new Set(["jj-current", "jj-last", "jj-line", "jj-evolog", "jj-all"]);

function selectNearestProvider(
  candidates: Array<{ provider: VcsProvider; root: string | null; order: number }>,
  cwd?: string,
): VcsProvider | null {
  if (candidates.length === 0) return null;

  const effectiveCwd = resolve(cwd ?? process.cwd());
  const ranked = candidates
    .map((candidate) => ({
      ...candidate,
      rootDepth: candidate.root ? vcsRootDepth(candidate.root) : -1,
      containsCwd: candidate.root ? isSameOrAncestor(candidate.root, effectiveCwd) : false,
    }))
    .sort((a, b) => {
      if (a.containsCwd !== b.containsCwd) return a.containsCwd ? -1 : 1;
      if (a.rootDepth !== b.rootDepth) return b.rootDepth - a.rootDepth;
      return a.order - b.order;
    });

  return ranked[0]?.provider ?? null;
}

function isSameOrAncestor(root: string, child: string): boolean {
  const relativePath = relative(resolve(root), child);
  return relativePath === "" || (!relativePath.startsWith("..") && !isAbsolute(relativePath));
}

function vcsRootDepth(root: string): number {
  return resolve(root).split(/[\\/]+/).filter(Boolean).length;
}

export function createGitProvider(runtime: ReviewGitRuntime): VcsProvider {
  return {
    id: "git",

    async detect(cwd?: string): Promise<boolean> {
      try {
        const result = await runtime.runGit(["rev-parse", "--is-inside-work-tree"], { cwd });
        return result.exitCode === 0;
      } catch {
        return false;
      }
    },

    async getRoot(cwd?: string): Promise<string | null> {
      const result = await runtime.runGit(["rev-parse", "--show-toplevel"], { cwd });
      return result.exitCode === 0 ? result.stdout.trim() || null : null;
    },

    ownsDiffType(diffType: string): boolean {
      return GIT_DIFF_TYPES.has(diffType) || diffType.startsWith("worktree:");
    },

    canStageFiles(diffType: string): boolean {
      const effectiveDiffType = parseWorktreeDiffType(diffType)?.subType ?? diffType;
      return effectiveDiffType === "uncommitted" || effectiveDiffType === "unstaged";
    },

    getContext(cwd?: string): Promise<GitContext> {
      return getGitContext(runtime, cwd);
    },

    runDiff(diffType: DiffType, defaultBranch: string, cwd?: string, options?: GitDiffOptions): Promise<DiffResult> {
      return runGitDiff(runtime, diffType, defaultBranch, cwd, options);
    },

    getFileContents(diffType, defaultBranch, filePath, oldPath?, cwd?) {
      return getGitFileContentsForDiff(runtime, diffType, defaultBranch, filePath, oldPath, cwd);
    },

    stageFile(filePath: string, cwd?: string): Promise<void> {
      return gitAddFile(runtime, filePath, cwd);
    },

    unstageFile(filePath: string, cwd?: string): Promise<void> {
      return gitResetFile(runtime, filePath, cwd);
    },

    detectRemoteDefaultCompareTarget(cwd?: string): Promise<string | null> {
      return detectRemoteDefaultBranch(runtime, cwd);
    },

    resolveCwd(diffType: string, fallbackCwd?: string): string | undefined {
      const parsed = parseWorktreeDiffType(diffType);
      return parsed?.path ?? fallbackCwd;
    },
  };
}

export function createJjProvider(runtime: ReviewJjRuntime): VcsProvider {
  return {
    id: "jj",

    async detect(cwd?: string): Promise<boolean> {
      return (await detectJjWorkspace(runtime, cwd)) !== null;
    },

    getRoot(cwd?: string): Promise<string | null> {
      return detectJjWorkspace(runtime, cwd);
    },

    ownsDiffType(diffType: string): boolean {
      return JJ_DIFF_TYPES.has(diffType);
    },

    getContext(cwd?: string): Promise<GitContext> {
      return getJjContext(runtime, cwd);
    },

    runDiff(diffType: DiffType, defaultBranch: string, cwd?: string, options?: GitDiffOptions): Promise<DiffResult> {
      return runJjDiff(runtime, diffType, defaultBranch, cwd, options);
    },

    getFileContents(diffType, defaultBranch, filePath, oldPath?, cwd?) {
      return getJjFileContentsForDiff(runtime, diffType, defaultBranch, filePath, oldPath, cwd);
    },
  };
}

export function createVcsApi(providers: readonly VcsProvider[]): VcsApi {
  const providerList = [...providers];
  const defaultProvider = providerList.find((provider) => provider.id === "git") ?? providerList[0];
  const vcsCache = new Map<string, VcsProvider>();

  if (!defaultProvider) {
    throw new Error("createVcsApi requires at least one provider");
  }

  async function detectVcs(cwd?: string): Promise<VcsProvider> {
    const key = cwd ?? process.cwd();
    const cached = vcsCache.get(key);
    if (cached) return cached;

    const candidates: Array<{ provider: VcsProvider; root: string | null; order: number }> = [];
    for (const provider of providerList) {
      let root: string | null = null;
      let detected = false;
      try {
        if (provider.getRoot) {
          root = await provider.getRoot(cwd);
          detected = root !== null;
        } else {
          detected = await provider.detect(cwd);
        }
      } catch {
        continue;
      }
      if (detected) {
        candidates.push({ provider, root, order: candidates.length });
      }
    }

    const detected = selectNearestProvider(candidates, cwd) ?? defaultProvider;
    vcsCache.set(key, detected);
    return detected;
  }

  function getProviderForDiffType(diffType: string): VcsProvider | null {
    for (const provider of providerList) {
      if (provider.ownsDiffType(diffType)) {
        return provider;
      }
    }
    return null;
  }

  function getProviderById(id: Exclude<VcsSelection, "auto">): VcsProvider | null {
    return providerList.find((provider) => provider.id === id) ?? null;
  }

  function formatVcsName(id: Exclude<VcsSelection, "auto">): string {
    switch (id) {
      case "git":
        return "Git";
      case "jj":
        return "JJ";
      case "p4":
        return "P4";
    }
  }

  async function getProviderForSelection(
    vcsType: VcsSelection | undefined,
    cwd?: string,
  ): Promise<VcsProvider> {
    if (!vcsType || vcsType === "auto") {
      return detectVcs(cwd);
    }

    const provider = getProviderById(vcsType);
    const vcsName = formatVcsName(vcsType);
    if (!provider) {
      throw new Error(`${vcsName} support is not available in this runtime.`);
    }
    if (!(await provider.detect(cwd))) {
      throw new Error(`${vcsName} workspace not found.`);
    }
    return provider;
  }

  async function getProviderForOperation(diffType: string, cwd?: string): Promise<VcsProvider> {
    return getProviderForDiffType(diffType) ?? detectVcs(cwd);
  }

  async function getContextWithProvider(
    cwd?: string,
    vcsType?: VcsSelection,
  ): Promise<{ provider: VcsProvider; gitContext: GitContext }> {
    const provider = await getProviderForSelection(vcsType, cwd);
    return { provider, gitContext: await provider.getContext(cwd) };
  }

  function resolveRequestedDiffType(
    provider: VcsProvider,
    gitContext: GitContext,
    requestedDiffType: DiffType | undefined,
    configuredDiffType: DiffType,
  ): DiffType {
    if (requestedDiffType && provider.ownsDiffType(requestedDiffType)) {
      return requestedDiffType;
    }
    return resolveInitialDiffType(gitContext, configuredDiffType);
  }

  function resolveInitialBase(
    gitContext: GitContext,
    diffType: DiffType,
    requestedBase: string | undefined,
    ownsRequestedDiffType: boolean,
  ): string {
    if (gitContext.vcsType === "jj") {
      if (diffType === "jj-line" && ownsRequestedDiffType && requestedBase) {
        return requestedBase;
      }
      return gitContext.defaultBranch;
    }
    return requestedBase ?? gitContext.defaultBranch;
  }

  return {
    detectVcs,

    async getVcsContext(cwd?: string, vcsType?: VcsSelection): Promise<GitContext> {
      return (await getContextWithProvider(cwd, vcsType)).gitContext;
    },

    async detectRemoteDefaultCompareTarget(cwd?: string, vcsType?: VcsSelection): Promise<string | null> {
      const provider = await getProviderForSelection(vcsType, cwd);
      return provider.detectRemoteDefaultCompareTarget?.(cwd) ?? null;
    },

    async prepareLocalReviewDiff(options: PrepareLocalReviewDiffOptions): Promise<PreparedLocalReviewDiff> {
      const { provider, gitContext } = await getContextWithProvider(options.cwd, options.vcsType);
      const ownsRequestedDiffType = options.requestedDiffType !== undefined
        && provider.ownsDiffType(options.requestedDiffType);
      const diffType = resolveRequestedDiffType(
        provider,
        gitContext,
        options.requestedDiffType,
        options.configuredDiffType,
      );
      const base = resolveInitialBase(gitContext, diffType, options.requestedBase, ownsRequestedDiffType);
      const result = await provider.runDiff(diffType, base, gitContext.cwd ?? options.cwd, {
        hideWhitespace: options.hideWhitespace,
      });

      return {
        gitContext,
        diffType,
        base,
        rawPatch: result.patch,
        gitRef: result.label,
        error: result.error,
      };
    },

    async runVcsDiff(
      diffType: DiffType,
      defaultBranch: string = "main",
      cwd?: string,
      options?: GitDiffOptions,
    ): Promise<DiffResult> {
      const provider = await getProviderForOperation(diffType, cwd);
      return provider.runDiff(diffType, defaultBranch, cwd, options);
    },

    async getVcsFileContentsForDiff(
      diffType: DiffType,
      defaultBranch: string,
      filePath: string,
      oldPath?: string,
      cwd?: string,
    ): Promise<{ oldContent: string | null; newContent: string | null }> {
      const provider = await getProviderForOperation(diffType, cwd);
      return provider.getFileContents(diffType, defaultBranch, filePath, oldPath, cwd);
    },

    async canStageFiles(diffType: string, cwd?: string): Promise<boolean> {
      const provider = await getProviderForOperation(diffType, cwd);
      return provider.stageFile !== undefined && (provider.canStageFiles?.(diffType) ?? false);
    },

    async stageFile(diffType: string, filePath: string, cwd?: string): Promise<void> {
      const provider = await getProviderForOperation(diffType, cwd);
      if (!provider.stageFile || !(provider.canStageFiles?.(diffType) ?? false)) {
        throw new Error(`Staging not available for ${provider.id}`);
      }
      return provider.stageFile(filePath, cwd);
    },

    async unstageFile(diffType: string, filePath: string, cwd?: string): Promise<void> {
      const provider = await getProviderForOperation(diffType, cwd);
      if (!provider.unstageFile || !(provider.canStageFiles?.(diffType) ?? false)) {
        throw new Error(`Unstaging not available for ${provider.id}`);
      }
      return provider.unstageFile(filePath, cwd);
    },

    resolveVcsCwd(diffType: string, fallbackCwd?: string): string | undefined {
      const provider = getProviderForDiffType(diffType);
      return provider?.resolveCwd?.(diffType, fallbackCwd) ?? fallbackCwd;
    },
  };
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
