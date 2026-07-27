/**
 * Runtime-neutral GitButler code-review support.
 *
 * GitButler integration was originally proposed by Dan Susman in PR #566.
 * This implementation keeps that user flow while using the modern VCS seam
 * and authoritative Git object-to-object diffs.
 */

import { basename, resolve } from "node:path";

import {
  type DiffResult,
  type DiffType,
  type GitCommandOptions,
  type GitCommandResult,
  type GitContext,
  type GitDiffOptions,
  type ReviewGitRuntime,
  getEmptyTreeSha,
  getWorkingTreeDiffFromBase,
  hashFingerprintPart,
  validateFilePath,
} from "./review-core";

/** Oldest GitButler CLI release whose status contract this integration supports. */
export const GITBUTLER_MIN_VERSION = "0.21.0";

/** Diff id for all applied GitButler workspace changes. */
export const GITBUTLER_WORKSPACE_DIFF = "gitbutler:workspace" as const;

const GITBUTLER_STACK_PREFIX = "gitbutler:stack:";
const GITBUTLER_BRANCH_PREFIX = "gitbutler:branch:";
const GITBUTLER_WORKSPACE_REFS = new Set([
  "refs/heads/gitbutler/workspace",
  "refs/heads/gitbutler/integration",
]);
const STATUS_TIMEOUT_MS = 30_000;
const VERSION_TIMEOUT_MS = 5_000;
const OBJECT_ID_RE = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const STATUS_CACHE_MS = 1_000;

/** Runtime operations needed by the shared GitButler provider. */
export interface ReviewGitButlerRuntime extends ReviewGitRuntime {
  runBut(args: string[], options?: GitCommandOptions): Promise<GitCommandResult>;
}

/** Validated subset of one GitButler status commit. */
export interface GitButlerCommit {
  commitId: string;
  /** GitButler synthetic conflict commits contain internal resolution trees. */
  conflicted?: boolean;
}

/** Validated subset of one GitButler virtual branch. */
export interface GitButlerBranch {
  name: string;
  /** Newest commit first, matching the GitButler status contract. */
  commits: GitButlerCommit[];
}

/** Validated subset of one GitButler stack. */
export interface GitButlerStack {
  /** Top-most branch first, matching the GitButler status contract. */
  branches: GitButlerBranch[];
}

/** Validated subset of `but --format json status`. */
export interface GitButlerStatus {
  mergeBase: GitButlerCommit;
  stacks: GitButlerStack[];
}

/** A parsed Plannotator GitButler diff id. */
export type ParsedGitButlerDiffType =
  | { kind: "workspace" }
  | { kind: "stack"; branchName: string }
  | { kind: "branch"; branchName: string };

/** Explicit boundary error for unsupported CLI versions or invalid CLI data. */
export class GitButlerContractError extends Error {
  readonly _tag = "GitButlerContractError";

  constructor(message: string) {
    super(message);
    this.name = "GitButlerContractError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new GitButlerContractError(`GitButler status field ${path} must be an object.`);
  }
  return value;
}

function requireArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new GitButlerContractError(`GitButler status field ${path} must be an array.`);
  }
  return value;
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new GitButlerContractError(`GitButler status field ${path} must be a non-empty string.`);
  }
  return value;
}

function parseCommit(value: unknown, path: string): GitButlerCommit {
  const record = requireRecord(value, path);
  const commitId = requireString(record.commitId, `${path}.commitId`);
  if (!OBJECT_ID_RE.test(commitId)) {
    throw new GitButlerContractError(`GitButler status field ${path}.commitId is not a Git object id.`);
  }
  return {
    commitId,
    ...(record.conflicted === true ? { conflicted: true } : {}),
  };
}

function parseBranch(value: unknown, path: string): GitButlerBranch {
  const record = requireRecord(value, path);
  if (typeof record.name !== "string") {
    throw new GitButlerContractError(`GitButler status field ${path}.name must be a string.`);
  }
  // Current GitButler can emit an empty name for a deleted, advanced, or
  // otherwise ambiguous stack segment. Workspace remains authoritative; such
  // a segment simply cannot back a stable named selector.
  const name = record.name;
  const commits = requireArray(record.commits, `${path}.commits`)
    .map((commit, index) => parseCommit(commit, `${path}.commits[${index}]`));
  // Validate this current-schema field even though committed-only views do not
  // consume it. Its presence distinguishes the supported status contract from
  // older, incompatible output.
  requireArray(record.upstreamCommits, `${path}.upstreamCommits`);
  return { name, commits };
}

function parseStack(value: unknown, path: string): GitButlerStack {
  const record = requireRecord(value, path);
  requireArray(record.assignedChanges, `${path}.assignedChanges`);
  const branches = requireArray(record.branches, `${path}.branches`)
    .map((branch, index) => parseBranch(branch, `${path}.branches[${index}]`));
  return { branches };
}

/** Parse and validate the status fields Plannotator relies on. Unknown fields are allowed. */
export function parseGitButlerStatus(output: string): GitButlerStatus {
  let decoded: unknown;
  try {
    decoded = JSON.parse(output);
  } catch {
    throw new GitButlerContractError("GitButler returned invalid JSON from `but --format json status`.");
  }

  const root = requireRecord(decoded, "root");
  requireArray(root.uncommittedChanges, "uncommittedChanges");
  const stacks = requireArray(root.stacks, "stacks")
    .map((stack, index) => parseStack(stack, `stacks[${index}]`));
  return {
    mergeBase: parseCommit(root.mergeBase, "mergeBase"),
    stacks,
  };
}

interface ParsedVersion {
  core: [number, number, number];
  prerelease: boolean;
  display: string;
}

function parseVersion(output: string): ParsedVersion | null {
  const match = output.match(/\b(\d+)\.(\d+)\.(\d+)(-[0-9A-Za-z.-]+)?\b/);
  if (!match) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  return Number.isSafeInteger(major) && Number.isSafeInteger(minor) && Number.isSafeInteger(patch)
    ? {
        core: [major, minor, patch],
        prerelease: match[4] !== undefined,
        display: `${major}.${minor}.${patch}${match[4] ?? ""}`,
      }
    : null;
}

function versionAtLeast(actual: ParsedVersion, minimum: ParsedVersion): boolean {
  for (let index = 0; index < actual.core.length; index += 1) {
    const actualPart = actual.core[index] ?? 0;
    const minimumPart = minimum.core[index] ?? 0;
    if (actualPart !== minimumPart) return actualPart > minimumPart;
  }
  return !actual.prerelease || minimum.prerelease;
}

const versionChecks = new WeakMap<ReviewGitButlerRuntime, Promise<void>>();
const statusCaches = new WeakMap<
  ReviewGitButlerRuntime,
  Map<string, { expiresAt: number; inFlight: boolean; status: Promise<GitButlerStatus> }>
>();

async function verifyGitButlerVersion(runtime: ReviewGitButlerRuntime, cwd: string): Promise<void> {
  const existing = versionChecks.get(runtime);
  if (existing) return existing;

  const check = (async () => {
    const result = await runtime.runBut(["--version"], { cwd, timeoutMs: VERSION_TIMEOUT_MS });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim();
      throw new GitButlerContractError(
        detail === "but not found"
          ? `GitButler workspace detected, but the \`but\` CLI is not on PATH (requires ${GITBUTLER_MIN_VERSION} or newer).`
          : `Could not run the GitButler CLI${detail ? `: ${detail}` : "."}`,
      );
    }

    const actual = parseVersion(result.stdout);
    const minimum = parseVersion(GITBUTLER_MIN_VERSION);
    if (!actual || !minimum) {
      throw new GitButlerContractError(`Could not parse GitButler version from: ${result.stdout.trim() || "<empty>"}`);
    }
    if (!versionAtLeast(actual, minimum)) {
      throw new GitButlerContractError(
        `GitButler ${actual.display} is unsupported; Plannotator requires ${GITBUTLER_MIN_VERSION} or newer.`,
      );
    }
  })();

  versionChecks.set(runtime, check);
  try {
    await check;
  } catch (error) {
    versionChecks.delete(runtime);
    throw error;
  }
}

async function loadStatus(runtime: ReviewGitButlerRuntime, cwd: string): Promise<GitButlerStatus> {
  await verifyGitButlerVersion(runtime, cwd);
  let cache = statusCaches.get(runtime);
  if (!cache) {
    cache = new Map();
    statusCaches.set(runtime, cache);
  }
  const now = Date.now();
  const existing = cache.get(cwd);
  if (existing && (existing.inFlight || existing.expiresAt > now)) return existing.status;

  const status = (async () => {
    const result = await runtime.runBut(["--format", "json", "status"], {
      cwd,
      timeoutMs: STATUS_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim();
      throw new GitButlerContractError(
        `GitButler status failed${detail ? `: ${detail}` : ` with exit code ${result.exitCode}`}`,
      );
    }
    return parseGitButlerStatus(result.stdout);
  })();
  const entry = { expiresAt: 0, inFlight: true, status };
  cache.set(cwd, entry);
  try {
    const resolved = await status;
    if (cache.get(cwd) === entry) {
      entry.inFlight = false;
      entry.expiresAt = Date.now() + STATUS_CACHE_MS;
    }
    return resolved;
  } catch (error) {
    if (cache.get(cwd)?.status === status) cache.delete(cwd);
    throw error;
  }
}

async function getActiveWorkspaceRoot(
  runtime: ReviewGitButlerRuntime,
  cwd?: string,
): Promise<string | null> {
  const activeRef = await runtime.runGit(["symbolic-ref", "--quiet", "HEAD"], { cwd });
  if (activeRef.exitCode !== 0 || !GITBUTLER_WORKSPACE_REFS.has(activeRef.stdout.trim())) {
    return null;
  }
  const targetRef = await runtime.runGit(
    ["config", "--local", "--get", "gitbutler.project.targetref"],
    { cwd },
  );
  if (targetRef.exitCode !== 0 || !targetRef.stdout.trim().startsWith("refs/")) {
    return null;
  }
  const root = await runtime.runGit(["rev-parse", "--show-toplevel"], { cwd });
  return root.exitCode === 0 ? root.stdout.trim() || null : null;
}

/** Detect an actively checked-out GitButler workspace and return its repository root. */
export function detectGitButlerWorkspace(
  runtime: ReviewGitButlerRuntime,
  cwd?: string,
): Promise<string | null> {
  return getActiveWorkspaceRoot(runtime, cwd);
}

function encodeTarget(prefix: string, branchName: string): DiffType {
  return `${prefix}${encodeURIComponent(branchName)}` as DiffType;
}

function decodeTarget(diffType: string, prefix: string): string | null {
  if (!diffType.startsWith(prefix)) return null;
  const encoded = diffType.slice(prefix.length);
  if (!encoded) return null;
  try {
    const branchName = decodeURIComponent(encoded);
    return branchName || null;
  } catch {
    return null;
  }
}

/** Parse one namespaced GitButler diff id. */
export function parseGitButlerDiffType(diffType: string): ParsedGitButlerDiffType | null {
  if (diffType === GITBUTLER_WORKSPACE_DIFF) return { kind: "workspace" };
  const stackBranch = decodeTarget(diffType, GITBUTLER_STACK_PREFIX);
  if (stackBranch) return { kind: "stack", branchName: stackBranch };
  const branch = decodeTarget(diffType, GITBUTLER_BRANCH_PREFIX);
  return branch ? { kind: "branch", branchName: branch } : null;
}

function branchTip(branch: GitButlerBranch): string | null {
  return branch.commits[0]?.commitId ?? null;
}

function stackTip(stack: GitButlerStack): string | null {
  for (const branch of stack.branches) {
    const tip = branchTip(branch);
    if (tip) return tip;
  }
  return null;
}

function stackLabel(stack: GitButlerStack): string {
  return [...stack.branches].reverse().map((branch) => branch.name).join(" → ");
}

function branchHasConflicts(branch: GitButlerBranch): boolean {
  return branch.commits.some((commit) => commit.conflicted === true);
}

function branchRangeHasConflicts(stack: GitButlerStack, branchIndex: number): boolean {
  return stack.branches.slice(branchIndex).some(branchHasConflicts);
}

function stackHasConflicts(stack: GitButlerStack): boolean {
  return stack.branches.some(branchHasConflicts);
}

function buildDiffOptions(status: GitButlerStatus): GitContext["diffOptions"] {
  const options: GitContext["diffOptions"] = [
    { id: GITBUTLER_WORKSPACE_DIFF, label: "Workspace (all applied changes)" },
  ];

  for (const stack of status.stacks) {
    const stackAnchor = stack.branches[stack.branches.length - 1];
    const hasStableNames = stack.branches.every((branch) => branch.name.length > 0);
    if (
      stackAnchor &&
      hasStableNames &&
      stack.branches.length > 1 &&
      stackTip(stack) &&
      !stackHasConflicts(stack)
    ) {
      options.push({
        id: encodeTarget(GITBUTLER_STACK_PREFIX, stackAnchor.name),
        label: `Stack: ${stackLabel(stack)} (committed)`,
      });
    }
    for (const [index, branch] of stack.branches.entries()) {
      if (!branch.name || !branchTip(branch) || branchRangeHasConflicts(stack, index)) continue;
      options.push({
        id: encodeTarget(GITBUTLER_BRANCH_PREFIX, branch.name),
        label: `Branch: ${branch.name} (committed)`,
      });
    }
  }
  return options;
}

function buildGitButlerContext(root: string, status: GitButlerStatus): GitContext {
  const gitButlerRevision = hashFingerprintPart(JSON.stringify([
    status.mergeBase.commitId,
    status.stacks.map((stack) => stack.branches.map((branch) => [
      branch.name,
      branch.commits.map((commit) => [commit.commitId, commit.conflicted === true]),
    ])),
  ]));
  return {
    currentBranch: "GitButler Workspace",
    defaultBranch: status.mergeBase.commitId,
    diffOptions: buildDiffOptions(status),
    worktrees: [],
    availableBranches: { local: [], remote: [] },
    repository: { displayFallback: basename(root) },
    cwd: root,
    vcsType: "gitbutler",
    gitButlerRevision,
  };
}

/** Build review context for the active GitButler workspace. */
export async function getGitButlerContext(
  runtime: ReviewGitButlerRuntime,
  cwd?: string,
): Promise<GitContext> {
  const root = await getActiveWorkspaceRoot(runtime, cwd);
  if (!root) throw new GitButlerContractError("GitButler workspace not found.");
  const status = await loadStatus(runtime, root);
  return buildGitButlerContext(root, status);
}

/** Stable revision for the picker topology carried beside a diff snapshot. */
export function getGitButlerContextRevision(context?: GitContext): string | null {
  if (context?.vcsType !== "gitbutler") return null;
  return hashFingerprintPart(JSON.stringify([
    context.defaultBranch,
    context.diffOptions,
    context.gitButlerRevision ?? null,
  ]));
}

/**
 * Fingerprint a patch and the exact GitButler topology snapshot that produced
 * it. The server can compute the startup baseline without asking the mutable
 * workspace for a second status revision.
 */
export function getGitButlerPatchFingerprint(
  diffType: DiffType,
  patch: string,
  context?: GitContext,
): string | null {
  const revision = getGitButlerContextRevision(context);
  if (!revision) return null;
  return `gitbutler:${diffType}:${revision}:${hashFingerprintPart(patch)}`;
}

function findStack(status: GitButlerStatus, branchName: string): GitButlerStack | null {
  return status.stacks.find((stack) =>
    stack.branches.every((branch) => branch.name.length > 0) &&
    stack.branches[stack.branches.length - 1]?.name === branchName
  ) ?? null;
}

function findBranch(status: GitButlerStatus, branchName: string): GitButlerBranch | null {
  for (const stack of status.stacks) {
    const branch = stack.branches.find((candidate) => candidate.name === branchName);
    if (branch) return branch;
  }
  return null;
}

function findBranchLocation(
  status: GitButlerStatus,
  branchName: string,
): { branch: GitButlerBranch; stack: GitButlerStack; index: number } | null {
  for (const stack of status.stacks) {
    const index = stack.branches.findIndex((candidate) => candidate.name === branchName);
    const branch = stack.branches[index];
    if (index >= 0 && branch) return { branch, stack, index };
  }
  return null;
}

async function branchRange(
  runtime: ReviewGitButlerRuntime,
  branch: GitButlerBranch,
  cwd: string,
): Promise<{ base: string; tip: string } | null> {
  const tip = branchTip(branch);
  if (!tip || branch.commits.length === 0) return null;
  const history = await runtime.runGit([
    "rev-list",
    "--first-parent",
    `--max-count=${branch.commits.length + 1}`,
    "--end-of-options",
    tip,
  ], { cwd });
  if (history.exitCode !== 0) {
    throw new GitButlerContractError(
      `Could not resolve GitButler branch commit ${tip}${history.stderr.trim() ? `: ${history.stderr.trim()}` : "."}`,
    );
  }
  const objects = history.stdout.trim().split(/\s+/).filter(Boolean);
  if (objects.some((objectId) => !OBJECT_ID_RE.test(objectId))) {
    throw new GitButlerContractError(`Git returned invalid ancestry data for GitButler branch commit ${tip}.`);
  }
  for (let index = 0; index < branch.commits.length; index += 1) {
    if (objects[index] !== branch.commits[index]?.commitId) {
      throw new GitButlerContractError(`GitButler branch ${JSON.stringify(branch.name)} no longer matches its reported commit chain.`);
    }
  }
  return {
    base: objects[branch.commits.length] ?? await getEmptyTreeSha(runtime, cwd),
    tip,
  };
}

async function resolvedBranchRange(
  runtime: ReviewGitButlerRuntime,
  status: GitButlerStatus,
  branchName: string,
  cwd: string,
): Promise<{ branch: GitButlerBranch; base: string; tip: string } | null> {
  const location = findBranchLocation(status, branchName);
  if (!location) return null;
  if (branchRangeHasConflicts(location.stack, location.index)) {
    throw new GitButlerContractError(
      `GitButler branch ${JSON.stringify(location.branch.name)} is conflicted; use the Workspace view until its stack is resolved.`,
    );
  }
  const range = await branchRange(runtime, location.branch, cwd);
  if (!range) return null;

  let expectedBase = status.mergeBase.commitId;
  for (const lowerBranch of location.stack.branches.slice(location.index + 1)) {
    const lowerTip = branchTip(lowerBranch);
    if (lowerTip) {
      expectedBase = lowerTip;
      break;
    }
  }
  if (range.base !== expectedBase) {
    throw new GitButlerContractError(
      `GitButler branch ${JSON.stringify(location.branch.name)} no longer matches its reported stack base.`,
    );
  }
  return { branch: location.branch, ...range };
}

async function validateWorkspaceMergeBase(
  runtime: ReviewGitButlerRuntime,
  mergeBase: string,
  cwd: string,
): Promise<void> {
  const ancestor = await runtime.runGit(
    ["merge-base", "--is-ancestor", mergeBase, "HEAD"],
    { cwd },
  );
  if (ancestor.exitCode !== 0) {
    throw new GitButlerContractError(
      "GitButler's reported merge base is missing or is not an ancestor of the workspace HEAD.",
    );
  }
}

async function resolvedStackRange(
  runtime: ReviewGitButlerRuntime,
  status: GitButlerStatus,
  stack: GitButlerStack,
  cwd: string,
): Promise<{ base: string; tip: string } | null> {
  if (stackHasConflicts(stack)) {
    throw new GitButlerContractError(
      `GitButler stack ${JSON.stringify(stackLabel(stack))} is conflicted; use the Workspace view until it is resolved.`,
    );
  }
  const tip = stackTip(stack);
  if (!tip) return null;
  const ancestor = await runtime.runGit(
    ["merge-base", "--is-ancestor", status.mergeBase.commitId, tip],
    { cwd },
  );
  if (ancestor.exitCode !== 0) {
    throw new GitButlerContractError("The GitButler stack is not descended from the reported workspace merge base.");
  }
  return { base: status.mergeBase.commitId, tip };
}

async function diffObjects(
  runtime: ReviewGitButlerRuntime,
  base: string,
  tip: string,
  cwd: string,
  options?: GitDiffOptions,
): Promise<string> {
  const args = [
    "diff",
    "--no-ext-diff",
    ...(options?.hideWhitespace ? ["-w"] : []),
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--end-of-options",
    `${base}..${tip}`,
  ];
  const result = await runtime.runGit(args, { cwd });
  if (result.exitCode !== 0) {
    throw new GitButlerContractError(
      `Git failed while building the GitButler diff${result.stderr.trim() ? `: ${result.stderr.trim()}` : "."}`,
    );
  }
  return result.stdout;
}

function errorResult(diffType: DiffType, error: unknown): DiffResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    patch: "",
    label: "GitButler error",
    error: message,
    fingerprint: `gitbutler:${diffType}:error:${hashFingerprintPart(message)}`,
  };
}

function snapshotResult(
  diffType: DiffType,
  context: GitContext,
  patch: string,
  label: string,
): DiffResult {
  return {
    patch,
    label,
    gitContext: context,
    fingerprint: getGitButlerPatchFingerprint(diffType, patch, context) ?? undefined,
  };
}

/** Produce an authoritative patch for one GitButler workspace, stack, or branch view. */
export async function runGitButlerDiff(
  runtime: ReviewGitButlerRuntime,
  diffType: DiffType,
  cwd?: string,
  options?: GitDiffOptions,
): Promise<DiffResult> {
  try {
    const parsed = parseGitButlerDiffType(diffType);
    if (!parsed) {
      return errorResult(diffType, "Invalid GitButler diff type.");
    }
    const root = await getActiveWorkspaceRoot(runtime, cwd);
    if (!root) throw new GitButlerContractError("The GitButler workspace is no longer active.");
    const status = await loadStatus(runtime, root);
    const context = buildGitButlerContext(root, status);

    if (parsed.kind === "workspace") {
      await validateWorkspaceMergeBase(runtime, status.mergeBase.commitId, root);
      const patch = await getWorkingTreeDiffFromBase(
        runtime,
        status.mergeBase.commitId,
        root,
        options,
        "strict",
      );
      return snapshotResult(diffType, context, patch, "GitButler workspace (all applied changes)");
    }

    if (parsed.kind === "stack") {
      const stack = findStack(status, parsed.branchName);
      if (!stack) {
        throw new GitButlerContractError(`GitButler stack ${JSON.stringify(parsed.branchName)} no longer exists.`);
      }
      const range = await resolvedStackRange(runtime, status, stack, root);
      if (!range) {
        return snapshotResult(diffType, context, "", `Stack: ${stackLabel(stack)} (no committed changes)`);
      }
      const patch = await diffObjects(runtime, range.base, range.tip, root, options);
      return snapshotResult(diffType, context, patch, `Stack: ${stackLabel(stack)} (committed changes)`);
    }

    const branch = findBranch(status, parsed.branchName);
    if (!branch) {
      throw new GitButlerContractError(`GitButler branch ${JSON.stringify(parsed.branchName)} no longer exists.`);
    }
    const range = await resolvedBranchRange(runtime, status, parsed.branchName, root);
    if (!range) {
      return snapshotResult(diffType, context, "", `Branch: ${branch.name} (no committed changes)`);
    }
    const patch = await diffObjects(runtime, range.base, range.tip, root, options);
    return snapshotResult(diffType, context, patch, `Branch: ${branch.name} (committed changes)`);
  } catch (error) {
    return errorResult(diffType, error);
  }
}

async function gitShow(
  runtime: ReviewGitButlerRuntime,
  ref: string,
  path: string,
  cwd: string,
): Promise<string | null> {
  const result = await runtime.runGit(["show", "--end-of-options", `${ref}:${path}`], { cwd });
  return result.exitCode === 0 ? result.stdout : null;
}

/** Resolve full old/new file content for expandable GitButler diffs. */
export async function getGitButlerFileContentsForDiff(
  runtime: ReviewGitButlerRuntime,
  diffType: DiffType,
  filePath: string,
  oldPath?: string,
  cwd?: string,
): Promise<{ oldContent: string | null; newContent: string | null }> {
  validateFilePath(filePath);
  const oldFilePath = oldPath ?? filePath;
  validateFilePath(oldFilePath);

  const parsed = parseGitButlerDiffType(diffType);
  if (!parsed) return { oldContent: null, newContent: null };
  const root = await getActiveWorkspaceRoot(runtime, cwd);
  if (!root) return { oldContent: null, newContent: null };
  const status = await loadStatus(runtime, root);

  if (parsed.kind === "workspace") {
    await validateWorkspaceMergeBase(runtime, status.mergeBase.commitId, root);
    return {
      oldContent: await gitShow(runtime, status.mergeBase.commitId, oldFilePath, root),
      newContent: await runtime.readTextFile(resolve(root, filePath)),
    };
  }

  let range: { base: string; tip: string } | null = null;
  if (parsed.kind === "stack") {
    const stack = findStack(status, parsed.branchName);
    if (stack) range = await resolvedStackRange(runtime, status, stack, root);
  } else {
    const resolved = await resolvedBranchRange(runtime, status, parsed.branchName, root);
    if (resolved) range = resolved;
  }
  if (!range) return { oldContent: null, newContent: null };
  return {
    oldContent: await gitShow(runtime, range.base, oldFilePath, root),
    newContent: await gitShow(runtime, range.tip, filePath, root),
  };
}

/** Fingerprint the exact visible GitButler patch for the freshness endpoint. */
export async function getGitButlerDiffFingerprint(
  runtime: ReviewGitButlerRuntime,
  diffType: DiffType,
  cwd?: string,
  options?: GitDiffOptions,
): Promise<string> {
  const result = await runGitButlerDiff(runtime, diffType, cwd, options);
  if (result.fingerprint) return result.fingerprint;
  const detail = result.error ?? `No fingerprint for ${result.label}`;
  return `gitbutler:${diffType}:error:${hashFingerprintPart(detail)}`;
}
