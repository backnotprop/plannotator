import { isAbsolute, relative, resolve } from "node:path";

import type { DiffOption, DiffResult, DiffType, GitContext, GitDiffOptions } from "./review-core";
import {
  aggregateWorkspacePatch,
  buildWorkspaceRepoLabels,
  discoverWorkspaceRepoPaths,
  normalizeWorkspacePath,
  prefixWorkspacePatchPaths,
  resolveWorkspaceFilePath,
} from "./review-workspace-node";

export type WorkspaceDiffType =
  | "workspace-current"
  | "workspace-staged"
  | "workspace-unstaged"
  | "workspace-last";

export type WorkspaceChildVcsType = "git" | "jj";

export interface WorkspaceRepoState {
  id: string;
  label: string;
  cwd: string;
  selected: boolean;
  vcsType?: WorkspaceChildVcsType;
  diffType?: DiffType;
  gitContext?: GitContext;
  diffOptions?: DiffOption[];
  error?: string;
}

export interface WorkspaceRepoRuntimeState extends WorkspaceRepoState {
  rawPatch: string;
  gitRef: string;
}

export interface WorkspaceReviewState {
  mode: "workspace";
  root: string;
  diffType: WorkspaceDiffType;
  diffOptions: DiffOption[];
  repos: WorkspaceRepoState[];
}

export interface WorkspaceReviewRuntime {
  getVcsContext(cwd?: string): Promise<GitContext>;
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
  /** Optional staleness fingerprint probe (see vcs-core). Absent or `null`
   * results are treated as always-fresh. */
  getVcsDiffFingerprint?(
    diffType: DiffType,
    defaultBranch?: string,
    cwd?: string,
    options?: GitDiffOptions,
  ): Promise<string | null>;
}

export interface WorkspaceReviewBuildOptions {
  requestedDiffType?: DiffType | WorkspaceDiffType;
  configuredDiffType?: DiffType;
  hideWhitespace?: boolean;
}

export interface WorkspacePromptRepoContext {
  label: string;
  cwd: string;
  changed: boolean;
  vcsType?: WorkspaceChildVcsType;
  gitRef?: string;
  error?: string;
}

export interface WorkspaceReviewPromptContext {
  root: string;
  repos: WorkspacePromptRepoContext[];
}

export interface WorkspaceDiffSnapshot {
  rawPatch: string;
  gitRef: string;
  error?: string;
}

const WORKSPACE_CURRENT: DiffOption = { id: "workspace-current", label: "Current changes" };
const WORKSPACE_STAGED: DiffOption = { id: "workspace-staged", label: "Staged changes" };
const WORKSPACE_UNSTAGED: DiffOption = { id: "workspace-unstaged", label: "Unstaged changes" };
const WORKSPACE_LAST: DiffOption = { id: "workspace-last", label: "Last change" };

const WORKSPACE_DIFF_TYPES = new Set<WorkspaceDiffType>([
  "workspace-current",
  "workspace-staged",
  "workspace-unstaged",
  "workspace-last",
]);

function isWorkspaceDiffType(value: string | undefined): value is WorkspaceDiffType {
  return !!value && WORKSPACE_DIFF_TYPES.has(value as WorkspaceDiffType);
}

function normalizeVcsType(value: string | undefined): WorkspaceChildVcsType | undefined {
  return value === "git" || value === "jj" ? value : undefined;
}

export function mapWorkspaceModeToRepoDiffType(
  workspaceDiffType: WorkspaceDiffType,
  vcsType: WorkspaceChildVcsType | undefined,
): DiffType | null {
  if (vcsType === "jj") {
    switch (workspaceDiffType) {
      case "workspace-current":
        return "jj-current";
      case "workspace-last":
        return "jj-last";
      default:
        return null;
    }
  }

  if (vcsType === "git") {
    switch (workspaceDiffType) {
      case "workspace-current":
        return "uncommitted";
      case "workspace-staged":
        return "staged";
      case "workspace-unstaged":
        return "unstaged";
      case "workspace-last":
        return "last-commit";
    }
  }

  return null;
}

export function mapRepoDiffTypeToWorkspaceMode(
  diffType: DiffType | WorkspaceDiffType | undefined,
): WorkspaceDiffType | undefined {
  if (isWorkspaceDiffType(diffType)) return diffType;
  switch (diffType) {
    case "uncommitted":
    case "jj-current":
      return "workspace-current";
    case "staged":
      return "workspace-staged";
    case "unstaged":
      return "workspace-unstaged";
    case "last-commit":
    case "jj-last":
      return "workspace-last";
    default:
      return undefined;
  }
}

export function resolveWorkspaceInitialDiffType(
  repos: WorkspaceRepoRuntimeState[],
  requested?: DiffType | WorkspaceDiffType,
  configured?: DiffType,
): WorkspaceDiffType {
  for (const candidate of [
    mapRepoDiffTypeToWorkspaceMode(requested),
    mapRepoDiffTypeToWorkspaceMode(configured),
    "workspace-current" as const,
  ]) {
    if (candidate && workspaceModeAvailable(repos, candidate)) return candidate;
  }
  return "workspace-current";
}

export function workspaceModeAvailable(
  repos: WorkspaceRepoRuntimeState[],
  diffType: WorkspaceDiffType,
): boolean {
  if (diffType === "workspace-staged" || diffType === "workspace-unstaged") {
    const detectedRepos = repos.filter((repo) => repo.vcsType);
    return detectedRepos.length > 0 && detectedRepos.every((repo) => repo.vcsType === "git");
  }
  return true;
}

export function getWorkspaceDiffOptions(repos: WorkspaceRepoRuntimeState[]): DiffOption[] {
  const options = [WORKSPACE_CURRENT];
  if (workspaceModeAvailable(repos, "workspace-staged")) {
    options.push(WORKSPACE_STAGED, WORKSPACE_UNSTAGED);
  }
  options.push(WORKSPACE_LAST);
  return options;
}

function aggregateRepos(repos: WorkspaceRepoRuntimeState[]): WorkspaceDiffSnapshot {
  const aggregate = aggregateWorkspacePatch(repos);
  return {
    rawPatch: aggregate.rawPatch,
    gitRef: aggregate.gitRef,
    error: aggregate.errors.length > 0 ? aggregate.errors.join("\n") : undefined,
  };
}

function normalizeAgentPath(root: string, repos: WorkspaceRepoRuntimeState[], filePath: string): string {
  const normalized = normalizeWorkspacePath(filePath);
  if (resolveWorkspaceFilePath(repos, normalized)) return normalized;

  const sorted = [...repos].sort((a, b) => b.cwd.length - a.cwd.length);
  for (const repo of sorted) {
    const rel = normalizeWorkspacePath(relative(repo.cwd, filePath));
    if (rel && !rel.startsWith("..") && !rel.startsWith("/")) {
      return `${normalizeWorkspacePath(repo.label)}/${rel}`;
    }
  }

  const rootRel = normalizeWorkspacePath(relative(root, filePath));
  if (rootRel && !rootRel.startsWith("..") && !rootRel.startsWith("/")) {
    if (resolveWorkspaceFilePath(repos, rootRel)) return rootRel;
  }

  const changedRepos = repos.filter((repo) => repo.selected && repo.rawPatch.trim());
  if (!isAbsolute(filePath) && changedRepos.length === 1 && normalized && !normalized.startsWith("..")) {
    return `${normalizeWorkspacePath(changedRepos[0].label)}/${normalized}`;
  }

  if (rootRel && !rootRel.startsWith("..") && !rootRel.startsWith("/")) return rootRel;
  return normalized;
}

export class WorkspaceReviewSession implements WorkspaceReviewState {
  readonly mode = "workspace" as const;
  readonly root: string;
  repos: WorkspaceRepoRuntimeState[];
  diffType: WorkspaceDiffType;
  diffOptions: DiffOption[];
  rawPatch: string;
  gitRef: string;
  error?: string;
  hideWhitespace: boolean;

  private constructor(
    private readonly runtime: WorkspaceReviewRuntime,
    root: string,
    repos: WorkspaceRepoRuntimeState[],
    diffType: WorkspaceDiffType,
    hideWhitespace: boolean,
  ) {
    this.root = resolve(root);
    this.repos = repos;
    this.diffType = diffType;
    this.hideWhitespace = hideWhitespace;
    this.diffOptions = getWorkspaceDiffOptions(repos);
    const snapshot = aggregateRepos(repos);
    this.rawPatch = snapshot.rawPatch;
    this.gitRef = snapshot.gitRef;
    this.error = snapshot.error;
  }

  static async create(
    runtime: WorkspaceReviewRuntime,
    root: string,
    options: WorkspaceReviewBuildOptions = {},
  ): Promise<WorkspaceReviewSession> {
    const resolvedRoot = resolve(root);
    const repoPaths = discoverWorkspaceRepoPaths(resolvedRoot);
    const labels = buildWorkspaceRepoLabels(resolvedRoot, repoPaths);

    const repos = await Promise.all(repoPaths.map(async (cwd, index) => {
      const label = labels[index];
      try {
        const gitContext = await runtime.getVcsContext(cwd);
        const vcsType = normalizeVcsType(gitContext.vcsType);
        return {
          id: `repo-${index + 1}`,
          label,
          cwd,
          selected: false,
          vcsType,
          gitContext,
          diffOptions: gitContext.diffOptions,
          rawPatch: "",
          gitRef: "",
        } satisfies WorkspaceRepoRuntimeState;
      } catch (error) {
        return {
          id: `repo-${index + 1}`,
          label,
          cwd,
          selected: false,
          rawPatch: "",
          gitRef: "",
          error: error instanceof Error ? error.message : String(error),
        } satisfies WorkspaceRepoRuntimeState;
      }
    }));

    const diffType = resolveWorkspaceInitialDiffType(
      repos.filter((repo) => repo.vcsType),
      options.requestedDiffType,
      options.configuredDiffType,
    );
    const session = new WorkspaceReviewSession(
      runtime,
      resolvedRoot,
      repos,
      diffType,
      options.hideWhitespace ?? false,
    );
    await session.rebuild({ diffType, hideWhitespace: options.hideWhitespace });
    return session;
  }

  async rebuild(options: {
    diffType?: DiffType | WorkspaceDiffType;
    hideWhitespace?: boolean;
  } = {}): Promise<WorkspaceDiffSnapshot> {
    const requestedMode = mapRepoDiffTypeToWorkspaceMode(options.diffType) ?? this.diffType;
    if (!workspaceModeAvailable(this.repos, requestedMode)) {
      throw new Error(`Workspace diff mode is not available: ${requestedMode}`);
    }

    if (typeof options.hideWhitespace === "boolean") {
      this.hideWhitespace = options.hideWhitespace;
    }

    const repos = await Promise.all(this.repos.map(async (repo) => {
      if (!repo.vcsType || !repo.gitContext) {
        return { ...repo, selected: false, rawPatch: "", gitRef: "" };
      }

      const repoDiffType = mapWorkspaceModeToRepoDiffType(requestedMode, repo.vcsType);
      if (!repoDiffType) {
        return {
          ...repo,
          selected: false,
          diffType: undefined,
          rawPatch: "",
          gitRef: "",
          error: `Workspace diff mode ${requestedMode} is not available for ${repo.vcsType}`,
        };
      }

      try {
        const diff = await this.runtime.runVcsDiff(repoDiffType, repo.gitContext.defaultBranch, repo.cwd, {
          hideWhitespace: this.hideWhitespace,
        });
        return {
          ...repo,
          selected: !!diff.patch.trim(),
          diffType: repoDiffType,
          rawPatch: prefixWorkspacePatchPaths(diff.patch, repo.label),
          gitRef: diff.label,
          error: diff.error,
        };
      } catch (error) {
        return {
          ...repo,
          selected: false,
          diffType: repoDiffType,
          rawPatch: "",
          gitRef: "",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }));

    this.repos = repos;
    this.diffType = requestedMode;
    this.diffOptions = getWorkspaceDiffOptions(repos);
    const snapshot = aggregateRepos(repos);
    this.rawPatch = snapshot.rawPatch;
    this.gitRef = snapshot.gitRef;
    this.error = snapshot.error;
    return snapshot;
  }

  /** Combined staleness fingerprint across EVERY child repo (selected or not —
   * a repo with no changes at snapshot time still alters the workspace diff if
   * it gains changes later). `null` when the runtime has no fingerprint probe. */
  async getFingerprint(): Promise<string | null> {
    const probe = this.runtime.getVcsDiffFingerprint;
    if (!probe) return null;
    const parts: string[] = ["workspace", this.diffType];
    for (const repo of this.repos) {
      if (!repo.vcsType || !repo.gitContext) continue;
      const repoDiffType =
        repo.diffType ?? mapWorkspaceModeToRepoDiffType(this.diffType, repo.vcsType);
      if (!repoDiffType) continue;
      const fingerprint = await probe(repoDiffType, repo.gitContext.defaultBranch, repo.cwd, {
        hideWhitespace: this.hideWhitespace,
      });
      // "unknown" is stable across probes, so an unfingerprintable child never
      // flip-flops the combined result.
      parts.push(`${repo.id}=${fingerprint ?? "unknown"}`);
    }
    return parts.join("|");
  }

  getPromptContext(): WorkspaceReviewPromptContext {
    return {
      root: this.root,
      repos: this.repos
        .filter((repo) => (repo.selected && repo.rawPatch.trim()) || repo.error)
        .map((repo) => ({
          label: repo.label,
          cwd: repo.cwd,
          changed: repo.selected && !!repo.rawPatch.trim(),
          vcsType: repo.vcsType,
          gitRef: repo.gitRef,
          error: repo.error,
        })),
    };
  }

  normalizeAnnotationPath(filePath: string): string {
    return normalizeAgentPath(this.root, this.repos, filePath);
  }

  async getFileContents(
    filePath: string,
    oldPath?: string,
  ): Promise<{ oldContent: string | null; newContent: string | null }> {
    const resolved = resolveWorkspaceFilePath(this.repos, filePath);
    if (!resolved) throw new Error("File is not part of this workspace review");

    const resolvedOld = oldPath ? resolveWorkspaceFilePath(this.repos, oldPath) : null;
    if (oldPath && (!resolvedOld || resolvedOld.repo.id !== resolved.repo.id)) {
      throw new Error("Old path is not part of the same workspace repository");
    }

    return this.runtime.getVcsFileContentsForDiff(
      resolved.repo.diffType ?? mapWorkspaceModeToRepoDiffType(this.diffType, resolved.repo.vcsType) ?? "uncommitted",
      resolved.repo.gitContext?.defaultBranch ?? "main",
      resolved.repoRelativePath,
      resolvedOld?.repoRelativePath,
      resolved.repo.cwd,
    );
  }

  async stageFile(filePath: string, undo?: boolean): Promise<void> {
    const resolved = resolveWorkspaceFilePath(this.repos, filePath);
    if (!resolved) throw new Error("File is not part of this workspace review");

    const diffType = resolved.repo.diffType ?? mapWorkspaceModeToRepoDiffType(this.diffType, resolved.repo.vcsType) ?? "uncommitted";
    if (!(await this.runtime.canStageFiles(diffType, resolved.repo.cwd))) {
      throw new Error("Staging not available");
    }

    if (undo) {
      await this.runtime.unstageFile(diffType, resolved.repoRelativePath, resolved.repo.cwd);
    } else {
      await this.runtime.stageFile(diffType, resolved.repoRelativePath, resolved.repo.cwd);
    }
  }
}
