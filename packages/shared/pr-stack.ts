import type { DiffResult, ReviewGitRuntime } from "./review-core";
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
  const diff = await runtime.runGit(diffArgs, { cwd });
  if (diff.exitCode !== 0) {
    const message = diff.stderr.trim() || `git ${diffArgs.join(" ")} failed`;
    return {
      patch: "",
      label: "Full stack diff unavailable",
      error: message.split("\n").find((line) => line.trim().length > 0) ?? message,
    };
  }

  return {
    patch: diff.stdout,
    label: `Full stack diff vs ${baseRef}`,
  };
}

/**
 * Fetch and checkout a PR/MR head in a local worktree.
 * Returns true if the checkout succeeded, false otherwise.
 */
export async function checkoutPRHead(
  runtime: ReviewGitRuntime,
  metadata: PRMetadata,
  cwd: string,
): Promise<boolean> {
  const refSpec = metadata.platform === "github"
    ? `refs/pull/${metadata.number}/head`
    : `refs/merge-requests/${metadata.iid}/head`;

  const fetch = await runtime.runGit(["fetch", "origin", refSpec], { cwd });
  if (fetch.exitCode !== 0) return false;

  const checkout = await runtime.runGit(["checkout", "FETCH_HEAD"], { cwd });
  return checkout.exitCode === 0;
}

/**
 * Build a minimal stack tree from existing metadata (no API calls).
 * Used as a fallback when the full stack tree hasn't loaded yet.
 */
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
    number: metadata.platform === "github" ? metadata.number : metadata.iid,
    title: metadata.title,
    url: metadata.url,
    isCurrent: true,
    isDefaultBranch: false,
  });

  return { nodes };
}
