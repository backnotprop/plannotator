import {
  runBoundedTrackedDiff,
  type DiffResult,
  type ReviewGitRuntime,
} from "./review-core";
import { ensureObjectAvailable } from "./worktree";
import { getPRHeadFetchSpec, getPRNumber } from "./pr-types";
import type {
  PRDiffScopeOption,
  PRMetadata,
  PRStackInfo,
  PRStackTree,
  PRStackNode,
} from "./pr-types";
export type { PRDiffScope, PRDiffScopeOption, PRStackInfo, PRStackTree, PRStackNode } from "./pr-types";

function branchNameIsSafe(branch: string): boolean {
  return branch.trim().length > 0 && !branch.startsWith("-") && !branch.includes("\0");
}

function diffFailureMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const failedAt = message.indexOf(" failed: ");
  return failedAt === -1 ? message : message.slice(failedAt + " failed: ".length);
}

export function getPRStackInfo(metadata: PRMetadata | undefined): PRStackInfo | null {
  if (!metadata?.defaultBranch) return null;
  if (metadata.baseBranch === metadata.defaultBranch) return null;

  return {
    isStacked: true,
    baseBranch: metadata.baseBranch,
    defaultBranch: metadata.defaultBranch,
    label: `${metadata.headBranch} stacked on ${metadata.baseBranch}`,
    source: "branch-inferred",
  };
}

export function resolveStackInfo(
  metadata: PRMetadata,
  stackTree: PRStackTree | null,
  existing?: PRStackInfo | null,
): PRStackInfo | null {
  if (existing) return existing;
  if (!stackTree || stackTree.nodes.filter(n => !n.isDefaultBranch).length <= 1) return null;
  return getPRStackInfo(metadata) ?? {
    isStacked: true,
    baseBranch: metadata.baseBranch,
    defaultBranch: metadata.defaultBranch!,
    label: `Root of stack — ${metadata.headBranch}`,
    source: "tree-discovered",
  };
}

export function getPRDiffScopeOptions(
  metadata: PRMetadata | undefined,
  hasLocalCheckout: boolean,
): PRDiffScopeOption[] {
  const stackInfo = getPRStackInfo(metadata);

  return [
    {
      id: "layer",
      label: "Layer",
      description: metadata?.baseBranch
        ? `Only changes relative to ${metadata.baseBranch}.`
        : "Only changes from this review.",
      enabled: true,
    },
    {
      id: "full-stack",
      label: "Full stack",
      description: stackInfo?.defaultBranch
        ? `All changes from ${stackInfo.defaultBranch} to HEAD in the local checkout.`
        : "All changes from the default branch to HEAD in the local checkout.",
      enabled: Boolean(stackInfo && hasLocalCheckout),
    },
  ];
}

export async function resolvePRFullStackBaseRef(
  runtime: ReviewGitRuntime,
  defaultBranch: string,
  cwd?: string,
): Promise<string | null> {
  const remoteRef = `origin/${defaultBranch}`;
  const remote = await runtime.runGit(
    ["show-ref", "--verify", "--quiet", `refs/remotes/${remoteRef}`],
    { cwd },
  );
  if (remote.exitCode === 0) return remoteRef;

  const local = await runtime.runGit(
    ["show-ref", "--verify", "--quiet", `refs/heads/${defaultBranch}`],
    { cwd },
  );
  if (local.exitCode === 0) return defaultBranch;

  return null;
}

export async function runPRFullStackDiff(
  runtime: ReviewGitRuntime,
  metadata: PRMetadata,
  cwd?: string,
): Promise<DiffResult> {
  const defaultBranch = metadata.defaultBranch;
  if (!defaultBranch || !branchNameIsSafe(defaultBranch)) {
    return {
      patch: "",
      label: "Full stack diff unavailable",
      error: "Could not determine a safe default branch for this review.",
    };
  }

  const baseRef = await resolvePRFullStackBaseRef(runtime, defaultBranch, cwd);
  if (!baseRef) {
    return {
      patch: "",
      label: "Full stack diff unavailable",
      error: `Could not find origin/${defaultBranch} or local ${defaultBranch} in this checkout.`,
    };
  }

  const diffArgs = [
    "diff",
    "--no-ext-diff",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--end-of-options",
    `${baseRef}...HEAD`,
  ];
  let patch: string;
  try {
    patch = await runBoundedTrackedDiff(runtime, diffArgs, cwd);
  } catch (error) {
    const message = diffFailureMessage(error) || `git diff failed`;
    return {
      patch: "",
      label: "Full stack diff unavailable",
      error: message.split("\n").find((line) => line.trim().length > 0) ?? message,
    };
  }

  return {
    patch,
    label: `Full stack diff vs ${baseRef}`,
  };
}

const FULL_SHA_RE = /^[0-9a-f]{40,64}$/i;

export async function runPRLayerLocalDiff(
  runtime: ReviewGitRuntime,
  metadata: PRMetadata,
  cwd: string,
): Promise<DiffResult> {
  const unavailable = (error: string): DiffResult => ({
    patch: "",
    label: "PR diff unavailable",
    error,
  });

  if (!FULL_SHA_RE.test(metadata.headSha)) {
    return unavailable(`Invalid PR head SHA: ${metadata.headSha}`);
  }

  const ensureObject = (sha: string): Promise<boolean> =>
    ensureObjectAvailable(runtime, sha, { cwd });

  if (!(await ensureObject(metadata.headSha))) {
    return unavailable(`PR head ${metadata.headSha} is not available in the local checkout.`);
  }

  const diffArgsFor = (range: string[]): string[] => [
    "diff",
    "--no-ext-diff",
    "--find-renames",
    "-l100000",
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "--end-of-options",
    ...range,
  ];

  let range: string[] | null = null;
  if (metadata.mergeBaseSha && FULL_SHA_RE.test(metadata.mergeBaseSha) && (await ensureObject(metadata.mergeBaseSha))) {
    range = [metadata.mergeBaseSha, metadata.headSha];
  } else if (FULL_SHA_RE.test(metadata.baseSha) && (await ensureObject(metadata.baseSha))) {
    range = [`${metadata.baseSha}...${metadata.headSha}`];
  }
  if (!range) {
    return unavailable("Could not resolve the PR base commit in the local checkout.");
  }

  let patch: string;
  try {
    patch = await runBoundedTrackedDiff(runtime, diffArgsFor(range), cwd);
  } catch (error) {
    const message = diffFailureMessage(error) || "git diff failed";
    return unavailable(message.split("\n").find((line) => line.trim().length > 0) ?? message);
  }
  if (!patch.trim()) {
    return unavailable("Local recompute produced an empty diff.");
  }

  return { patch, label: "PR diff (recomputed locally)" };
}

export async function getPRFullStackFingerprint(
  runtime: ReviewGitRuntime,
  metadata: PRMetadata,
  cwd?: string,
): Promise<string | null> {
  const defaultBranch = metadata.defaultBranch;
  if (!defaultBranch || !branchNameIsSafe(defaultBranch)) return null;
  const baseRef = await resolvePRFullStackBaseRef(runtime, defaultBranch, cwd);
  if (!baseRef) return null;

  const head = await runtime.runGit(["--no-optional-locks", "rev-parse", "HEAD"], { cwd });
  if (head.exitCode !== 0) return null;
  const mergeBase = await runtime.runGit(
    ["--no-optional-locks", "merge-base", "--end-of-options", baseRef, "HEAD"],
    { cwd },
  );
  if (mergeBase.exitCode !== 0) return null;
  return `pr-full-stack:${mergeBase.stdout.trim()}:${head.stdout.trim()}`;
}

export async function checkoutPRHead(
  runtime: ReviewGitRuntime,
  metadata: PRMetadata,
  cwd: string,
): Promise<boolean> {
  let head: { remote: string | null; ref: string };
  try {
    head = getPRHeadFetchSpec(metadata);
  } catch {
    return false;
  }

  const fetch = await runtime.runGit(["fetch", head.remote ?? "origin", head.ref], { cwd });
  if (fetch.exitCode !== 0) return false;

  const checkout = await runtime.runGit(["checkout", "FETCH_HEAD"], { cwd });
  return checkout.exitCode === 0;
}

export function buildMinimalStackTree(
  metadata: PRMetadata,
  stackInfo: PRStackInfo,
): PRStackTree {
  const nodes: PRStackNode[] = [];

  if (stackInfo.defaultBranch) {
    nodes.push({
      branch: stackInfo.defaultBranch,
      isCurrent: false,
      isDefaultBranch: true,
    });
  }

  if (stackInfo.baseBranch !== stackInfo.defaultBranch) {
    nodes.push({
      branch: stackInfo.baseBranch,
      isCurrent: false,
      isDefaultBranch: false,
    });
  }

  nodes.push({
    branch: metadata.headBranch,
    number: getPRNumber(metadata),
    title: metadata.title,
    url: metadata.url,
    isCurrent: true,
    isDefaultBranch: false,
  });

  return { nodes };
}
