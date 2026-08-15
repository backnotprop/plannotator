import {
  type DiffResult,
  type DiffType,
  type GitContext,
  type GitDiffOptions,
  type ReviewGitRuntime,
  detectRemoteDefaultBranch,
  getFileContentsForDiff as getGitFileContentsForDiff,
  getGitContext,
  getGitDiffFingerprint,
  getGitSnapshotMaterializationPatch,
  gitAddFile,
  gitResetFile,
  parseWorktreeDiffType,
  runGitDiff,
} from "./review-core";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";
import { rmSync } from "node:fs";
import {
  type ReviewJjRuntime,
  detectJjWorkspace,
  getJjContext,
  getJjSnapshotRevsets,
  getJjDiffFingerprint,
  getJjFileContentsForDiff,
  isJjSnapshotDiffType,
  resolveJjSnapshotEndpoint,
  runJjDiff,
} from "./jj-core";
import {
  type ReviewGitButlerRuntime,
  detectGitButlerWorkspace,
  getGitButlerContext,
  getGitButlerDiffFingerprint,
  getGitButlerFileContentsForDiff,
  parseGitButlerDiffType,
  runGitButlerDiff,
} from "./gitbutler-core";

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
  parseCommitDiffType,
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
  /** Cheap staleness fingerprint for a diff (see review-core/jj-core). Providers
   * without an implementation (e.g. p4) are treated as always-fresh. */
  getDiffFingerprint?(
    diffType: DiffType,
    defaultBranch: string,
    cwd?: string,
    options?: GitDiffOptions,
  ): Promise<string | null>;
  stageFile?(filePath: string, cwd?: string): Promise<void>;
  unstageFile?(filePath: string, cwd?: string): Promise<void>;
  resolveCwd?(diffType: string, fallbackCwd?: string): string | undefined;
  detectRemoteDefaultCompareTarget?(cwd?: string): Promise<string | null>;
  supportsSnapshot?(diffType: string): boolean;
  materializeSnapshot?(options: VcsSnapshotOptions): Promise<VcsSnapshot>;
}

export interface VcsSnapshotOptions {
  diffType: DiffType;
  base: string;
  cwd: string;
  rawPatch: string;
  includedExtensions: readonly string[];
  prCommitPair?: { from: string; to: string };
  signal?: AbortSignal;
}

export interface VcsSnapshot {
  cwd: string;
  from: string;
  to: string;
  cleanup(): void;
}

export type VcsSelection = "auto" | "git" | "gitbutler" | "jj" | "p4";

export interface VcsApi {
  detectVcs(cwd?: string): Promise<VcsProvider>;
  detectManagedVcs(cwd?: string, vcsType?: VcsSelection): Promise<VcsProvider | null>;
  vcsOwnsDiffType(vcsType: Exclude<VcsSelection, "auto">, diffType: string): boolean;
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
  /** Best-effort staleness fingerprint for the given diff parameters. `null`
   * means "cannot fingerprint" and must be treated as always-fresh. */
  getVcsDiffFingerprint(
    diffType: DiffType,
    defaultBranch?: string,
    cwd?: string,
    options?: GitDiffOptions,
  ): Promise<string | null>;
  canStageFiles(diffType: string, cwd?: string): Promise<boolean>;
  stageFile(diffType: string, filePath: string, cwd?: string): Promise<void>;
  unstageFile(diffType: string, filePath: string, cwd?: string): Promise<void>;
  resolveVcsCwd(diffType: string, fallbackCwd?: string): string | undefined;
  vcsSupportsSnapshot(vcsType: Exclude<VcsSelection, "auto">, diffType: string): boolean;
  materializeVcsSnapshot(
    vcsType: Exclude<VcsSelection, "auto">,
    options: VcsSnapshotOptions,
  ): Promise<VcsSnapshot>;
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
  /** Provider freshness token captured atomically with the initial patch. */
  fingerprint?: string;
}

const GIT_DIFF_TYPES = new Set(["since-base", "uncommitted", "staged", "unstaged", "last-commit", "branch", "merge-base", "all"]);
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
      return (
        GIT_DIFF_TYPES.has(diffType) ||
        diffType.startsWith("worktree:") ||
        diffType.startsWith("commit:")
      );
    },

    canStageFiles(diffType: string): boolean {
      const effectiveDiffType = parseWorktreeDiffType(diffType)?.subType ?? diffType;
      return (
        effectiveDiffType === "since-base" ||
        effectiveDiffType === "uncommitted" ||
        effectiveDiffType === "unstaged"
      );
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

    getDiffFingerprint(diffType, defaultBranch, cwd?, options?) {
      return getGitDiffFingerprint(runtime, diffType, defaultBranch, cwd, options);
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

    supportsSnapshot: supportsGitSnapshot,

    materializeSnapshot(options: VcsSnapshotOptions): Promise<VcsSnapshot> {
      return materializeGitSnapshot(runtime, options);
    },
  };
}

export function createJjProvider(runtime: ReviewJjRuntime, gitRuntime: ReviewGitRuntime): VcsProvider {
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

    getDiffFingerprint(diffType, defaultBranch, cwd?) {
      return getJjDiffFingerprint(runtime, diffType, defaultBranch, cwd);
    },

    supportsSnapshot: isJjSnapshotDiffType,

    materializeSnapshot(options: VcsSnapshotOptions): Promise<VcsSnapshot> {
      return materializeJjSnapshot(runtime, gitRuntime, options);
    },
  };
}

/** Create the provider for an actively checked-out GitButler workspace. */
export function createGitButlerProvider(runtime: ReviewGitButlerRuntime): VcsProvider {
  return {
    id: "gitbutler",

    async detect(cwd?: string): Promise<boolean> {
      return (await detectGitButlerWorkspace(runtime, cwd)) !== null;
    },

    getRoot(cwd?: string): Promise<string | null> {
      return detectGitButlerWorkspace(runtime, cwd);
    },

    ownsDiffType(diffType: string): boolean {
      return parseGitButlerDiffType(diffType) !== null;
    },

    getContext(cwd?: string): Promise<GitContext> {
      return getGitButlerContext(runtime, cwd);
    },

    runDiff(diffType: DiffType, _defaultBranch: string, cwd?: string, options?: GitDiffOptions): Promise<DiffResult> {
      return runGitButlerDiff(runtime, diffType, cwd, options);
    },

    getFileContents(diffType, _defaultBranch, filePath, oldPath?, cwd?) {
      return getGitButlerFileContentsForDiff(runtime, diffType, filePath, oldPath, cwd);
    },

    getDiffFingerprint(diffType, _defaultBranch, cwd?, options?) {
      return getGitButlerDiffFingerprint(runtime, diffType, cwd, options);
    },
  };
}

export function createVcsApi(providers: readonly VcsProvider[]): VcsApi {
  const providerList = [...providers];
  const defaultProvider = providerList.find((provider) => provider.id === "git") ?? providerList[0];

  if (!defaultProvider) {
    throw new Error("createVcsApi requires at least one provider");
  }

  async function collectDetectedProviders(cwd?: string): Promise<Array<{ provider: VcsProvider; root: string | null; order: number }>> {
    const candidates: Array<{ provider: VcsProvider; root: string | null; order: number }> = [];
    for (let index = 0; index < providerList.length; index++) {
      const provider = providerList[index];
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
        candidates.push({ provider, root, order: index });
      }
    }
    return candidates;
  }

  async function detectManagedVcs(cwd?: string, vcsType?: VcsSelection): Promise<VcsProvider | null> {
    if (vcsType && vcsType !== "auto") {
      const provider = getProviderById(vcsType);
      let detected = false;
      try {
        detected = provider ? await provider.detect(cwd) : false;
      } catch {
        detected = false;
      }
      return detected ? provider : null;
    }

    const candidates = await collectDetectedProviders(cwd);
    return selectNearestProvider(candidates, cwd);
  }

  async function detectVcs(cwd?: string): Promise<VcsProvider> {
    // OpenCode and Pi keep this module alive across review sessions. Always
    // re-detect at the session boundary so `but setup`/`but teardown`, JJ
    // colocating, or nested-repo changes cannot leave a stale provider with
    // the wrong staging semantics cached for this cwd.
    return (await detectManagedVcs(cwd)) ?? defaultProvider;
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
      case "gitbutler":
        return "GitButler";
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
    if (gitContext.vcsType === "jj" || gitContext.vcsType === "gitbutler") {
      if (diffType === "jj-line" && ownsRequestedDiffType && requestedBase) {
        return requestedBase;
      }
      return gitContext.defaultBranch;
    }
    return requestedBase ?? gitContext.defaultBranch;
  }

  return {
    detectVcs,
    detectManagedVcs,

    vcsOwnsDiffType(vcsType: Exclude<VcsSelection, "auto">, diffType: string): boolean {
      return getProviderById(vcsType)?.ownsDiffType(diffType) ?? false;
    },

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
      const effectiveContext = result.gitContext ?? gitContext;

      return {
        gitContext: effectiveContext,
        diffType,
        base: result.gitContext?.defaultBranch ?? base,
        rawPatch: result.patch,
        gitRef: result.label,
        error: result.error,
        fingerprint: result.fingerprint,
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

    async getVcsDiffFingerprint(
      diffType: DiffType,
      defaultBranch: string = "main",
      cwd?: string,
      options?: GitDiffOptions,
    ): Promise<string | null> {
      try {
        const provider = await getProviderForOperation(diffType, cwd);
        if (!provider.getDiffFingerprint) return null;
        return await provider.getDiffFingerprint(diffType, defaultBranch, cwd, options);
      } catch {
        // Fingerprinting is best-effort: failure means "always fresh", never
        // a user-facing error.
        return null;
      }
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

    vcsSupportsSnapshot(vcsType: Exclude<VcsSelection, "auto">, diffType: string): boolean {
      return getProviderById(vcsType)?.supportsSnapshot?.(diffType) ?? false;
    },

    async materializeVcsSnapshot(
      vcsType: Exclude<VcsSelection, "auto">,
      options: VcsSnapshotOptions,
    ): Promise<VcsSnapshot> {
      const provider = getProviderById(vcsType);
      if (!provider?.materializeSnapshot || (!options.prCommitPair && !(provider.supportsSnapshot?.(options.diffType) ?? false))) {
        throw new Error(`Snapshot materialization does not support the ${options.diffType} ${formatVcsName(vcsType)} review mode.`);
      }
      return provider.materializeSnapshot(options);
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

const SNAPSHOT_TIMEOUT_MS = 20_000;
const MAX_JJ_SNAPSHOT_PATCH_BYTES = 64 * 1024 * 1024;

async function git(runtime: ReviewGitRuntime, cwd: string, args: string[], stdin?: string): Promise<string> {
  const result = await runtime.runGit(args, { cwd, stdin, timeoutMs: SNAPSHOT_TIMEOUT_MS });
  if (result.exitCode !== 0) {
    throw new Error((result.stderr.trim() || result.stdout.trim() || `git ${args[0]} failed`).slice(0, 2_000));
  }
  return result.stdout.trim();
}

async function resolveCommit(runtime: ReviewGitRuntime, cwd: string, ref: string): Promise<string> {
  return git(runtime, cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
}

async function firstParent(runtime: ReviewGitRuntime, cwd: string, ref: string): Promise<string> {
  try {
    return await resolveCommit(runtime, cwd, `${ref}^`);
  } catch {
    throw new Error("Snapshot materialization requires a commit with a parent.");
  }
}

async function commitIndex(
  runtime: ReviewGitRuntime,
  cwd: string,
  parent: string | undefined,
  message: string,
): Promise<string> {
  const tree = await git(runtime, cwd, ["write-tree"]);
  return git(runtime, cwd, [
    "-c", "user.name=Plannotator",
    "-c", "user.email=snapshot@plannotator.invalid",
    "commit-tree", tree,
    ...(parent ? ["-p", parent] : []),
    "-m", message,
  ]);
}

async function applyPatchToIndex(runtime: ReviewGitRuntime, cwd: string, patch: string): Promise<void> {
  if (!patch.trim()) return;
  const normalizedPatch = patch.endsWith("\n") ? patch : `${patch}\n`;
  await git(runtime, cwd, ["apply", "--cached", "--binary", "--recount", "--whitespace=nowarn", "-"], normalizedPatch);
}

function removeDirectoryBestEffort(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    // Snapshot cleanup must never replace the caller-visible analysis result.
  }
}

async function createSyntheticSnapshot(
  runtime: ReviewGitRuntime,
  sourceCwd: string,
  baseCommit: string,
  patches: readonly string[],
): Promise<VcsSnapshot> {
  const tempRoot = await mkdtemp(join(tmpdir(), "plannotator-review-snapshot-"));
  const snapshotCwd = join(tempRoot, "repo");
  const cleanup = () => removeDirectoryBestEffort(tempRoot);
  try {
    await git(runtime, sourceCwd, ["clone", "--shared", "--no-checkout", "--quiet", "--", sourceCwd, snapshotCwd]);
    await git(runtime, snapshotCwd, ["read-tree", baseCommit]);
    let parent = baseCommit;
    const commits: string[] = [];
    for (let index = 0; index < patches.length; index += 1) {
      await applyPatchToIndex(runtime, snapshotCwd, patches[index]);
      parent = await commitIndex(runtime, snapshotCwd, parent, `Plannotator review snapshot ${index + 1}`);
      commits.push(parent);
    }
    return {
      cwd: snapshotCwd,
      from: commits.length > 1 ? commits[commits.length - 2] : baseCommit,
      to: commits[commits.length - 1] ?? baseCommit,
      cleanup,
    };
  } catch (error) {
    cleanup();
    throw error;
  }
}

function supportsGitSnapshot(diffType: string): boolean {
  const effective = parseWorktreeDiffType(diffType)?.subType ?? diffType;
  return effective !== "all" && (
    effective === "since-base"
    || effective === "uncommitted"
    || effective === "staged"
    || effective === "unstaged"
    || effective === "branch"
    || effective === "merge-base"
    || effective === "last-commit"
    || effective.startsWith("commit:")
  );
}

async function materializeGitSnapshot(
  runtime: ReviewGitRuntime,
  options: VcsSnapshotOptions,
): Promise<VcsSnapshot> {
  if (options.prCommitPair) {
    return {
      cwd: options.cwd,
      from: await resolveCommit(runtime, options.cwd, options.prCommitPair.from),
      to: await resolveCommit(runtime, options.cwd, options.prCommitPair.to),
      cleanup: () => {},
    };
  }

  const worktree = parseWorktreeDiffType(options.diffType);
  const cwd = worktree?.path ?? options.cwd;
  const diffType = worktree?.subType ?? options.diffType;
  const commit = diffType.startsWith("commit:") ? diffType.slice("commit:".length) : null;
  if (commit) {
    const to = await resolveCommit(runtime, cwd, commit);
    return { cwd, from: await firstParent(runtime, cwd, to), to, cleanup: () => {} };
  }
  if (diffType === "last-commit") {
    const to = await resolveCommit(runtime, cwd, "HEAD");
    return { cwd, from: await firstParent(runtime, cwd, to), to, cleanup: () => {} };
  }
  if (diffType === "branch") {
    return {
      cwd,
      from: await resolveCommit(runtime, cwd, options.base),
      to: await resolveCommit(runtime, cwd, "HEAD"),
      cleanup: () => {},
    };
  }
  if (diffType === "merge-base") {
    const from = await git(runtime, cwd, ["merge-base", "--", options.base, "HEAD"]);
    return { cwd, from, to: await resolveCommit(runtime, cwd, "HEAD"), cleanup: () => {} };
  }
  if (!supportsGitSnapshot(diffType)) {
    throw new Error(`Snapshot materialization does not support the ${diffType} review mode.`);
  }

  const patch = await getGitSnapshotMaterializationPatch(runtime, diffType as DiffType, options.base, cwd) ?? options.rawPatch;
  if (diffType === "since-base") {
    const mergeBase = await git(runtime, cwd, ["merge-base", "--", options.base, "HEAD"]);
    return createSyntheticSnapshot(runtime, cwd, mergeBase, [patch]);
  }
  const head = await resolveCommit(runtime, cwd, "HEAD");
  if (diffType === "uncommitted" || diffType === "staged") {
    return createSyntheticSnapshot(runtime, cwd, head, [patch]);
  }
  const stagedPatch = await git(runtime, cwd, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff"]);
  return createSyntheticSnapshot(runtime, cwd, head, [stagedPatch, patch]);
}

/**
 * One `jj diff` between two revisions, bounded and stripped of the entries
 * `git apply` cannot replay.
 *
 * The byte cap is passed to the runtime so it stops READING at the limit; the
 * post-check only covers runtimes that ignore the option, so a 64 MB tree can
 * never be fully buffered just to be rejected afterwards.
 */
async function jjSnapshotPatch(
  runtime: ReviewJjRuntime,
  options: VcsSnapshotOptions,
  from: string,
  to: string,
  filesets: readonly string[],
): Promise<string> {
  if (options.signal?.aborted) throw new Error("Snapshot materialization was superseded by a newer review snapshot.");
  if (filesets.length === 0) return "";

  const result = await runtime.runJj([
    "--ignore-working-copy",
    "diff",
    "--git",
    "--from",
    from,
    "--to",
    to,
    ...filesets,
  ], { cwd: options.cwd, timeoutMs: SNAPSHOT_TIMEOUT_MS, maxOutputBytes: MAX_JJ_SNAPSHOT_PATCH_BYTES });

  if (result.truncated || Buffer.byteLength(result.stdout, "utf8") > MAX_JJ_SNAPSHOT_PATCH_BYTES) {
    throw new Error("Jujutsu snapshot exceeded the 64 MB materialization limit.");
  }
  if (result.exitCode !== 0) {
    throw new Error((result.stderr.trim() || "Jujutsu diff failed.").slice(0, 2_000));
  }
  return result.stdout
    .split(/(?=^diff --git )/m)
    .filter((chunk) => !/^Binary files /m.test(chunk))
    .join("");
}

async function materializeJjSnapshot(
  jjRuntime: ReviewJjRuntime,
  gitRuntime: ReviewGitRuntime,
  options: VcsSnapshotOptions,
): Promise<VcsSnapshot> {
  const endpoints = getJjSnapshotRevsets(options.diffType, options.base);
  if (!endpoints) throw new Error(`Snapshot materialization does not support the ${options.diffType} Jujutsu review mode.`);

  // Parent hops resolve against the repo before any diff runs, so a merge
  // revision cannot hand `jj diff` an ambiguous `--to`.
  const fromRevision = await resolveJjSnapshotEndpoint(jjRuntime, endpoints.from, options.cwd);
  const toRevision = await resolveJjSnapshotEndpoint(jjRuntime, endpoints.to, options.cwd);

  // `root-glob-i:`, not `glob-i:`: plain filesets are relative to the INVOCATION
  // directory, so reviewing from a subdirectory would silently drop every source
  // file above it and hand CallDiff a partial repository call graph.
  const filesets = options.includedExtensions.map((extension) => `root-glob-i:"**/*${extension}"`);

  const tempRoot = await mkdtemp(join(tmpdir(), "plannotator-review-jj-snapshot-"));
  const snapshotCwd = join(tempRoot, "repo");
  const cleanup = () => removeDirectoryBestEffort(tempRoot);
  try {
    await git(gitRuntime, tempRoot, ["init", "--quiet", "--", snapshotCwd]);
    const emptyCommit = await commitIndex(gitRuntime, snapshotCwd, undefined, "Plannotator review empty snapshot");

    // Only the base side materializes the whole parseable tree.
    const basePatch = await jjSnapshotPatch(jjRuntime, options, "root()", fromRevision, filesets);
    await git(gitRuntime, snapshotCwd, ["read-tree", "--empty"]);
    await applyPatchToIndex(gitRuntime, snapshotCwd, basePatch);
    const fromCommit = await commitIndex(gitRuntime, snapshotCwd, emptyCommit, "Plannotator review Jujutsu snapshot");

    // The second side is the base tree plus the CHANGED files, so materialization
    // cost scales with the review instead of with the repository. Falling back to
    // a second whole-tree pass keeps a patch git cannot replay from failing the
    // analysis outright.
    let toCommit: string;
    try {
      const deltaPatch = await jjSnapshotPatch(jjRuntime, options, fromRevision, toRevision, filesets);
      await git(gitRuntime, snapshotCwd, ["read-tree", fromCommit]);
      await applyPatchToIndex(gitRuntime, snapshotCwd, deltaPatch);
      toCommit = await commitIndex(gitRuntime, snapshotCwd, fromCommit, "Plannotator review Jujutsu snapshot");
    } catch (error) {
      if (options.signal?.aborted) throw error;
      const wholePatch = await jjSnapshotPatch(jjRuntime, options, "root()", toRevision, filesets);
      await git(gitRuntime, snapshotCwd, ["read-tree", "--empty"]);
      await applyPatchToIndex(gitRuntime, snapshotCwd, wholePatch);
      toCommit = await commitIndex(gitRuntime, snapshotCwd, emptyCommit, "Plannotator review Jujutsu snapshot");
    }

    return { cwd: snapshotCwd, from: fromCommit, to: toCommit, cleanup };
  } catch (error) {
    cleanup();
    throw error;
  }
}

