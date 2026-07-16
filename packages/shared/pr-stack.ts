import type { DiffResult, ReviewGitRuntime } from "./review-core";
import { ensureObjectAvailable } from "./worktree";
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

const FULL_SHA_RE = /^[0-9a-f]{40,64}$/i;

/**
 * Recompute the PR's LAYER diff locally — the same merge-base..head diff the
 * platform renders, but with no API size limits. Used to upgrade a truncated
 * files-API reconstruction (platforms withhold per-file patches on very large
 * PRs) once a local checkout exists.
 *
 * Prefers the platform-reported merge-base SHA (the exact commit the platform
 * diffed against); falls back to discovering the merge base locally via a
 * three-dot diff against baseSha. Diffs explicit SHAs, not HEAD — agent jobs
 * may move HEAD in the checkout.
 */
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

  // Shallow warmup clones may lack an object; both GitHub and GitLab allow
  // fetching reachable commits by SHA (the warmup already relies on this).
  const ensureObject = (sha: string): Promise<boolean> =>
    ensureObjectAvailable(runtime, sha, { cwd });

  if (!(await ensureObject(metadata.headSha))) {
    return unavailable(`PR head ${metadata.headSha} is not available in the local checkout.`);
  }

  const diffArgsFor = (range: string[]): string[] => [
    "diff",
    "--no-ext-diff",
    // Lift diff.renameLimit: on the multi-thousand-file PRs this path exists
    // for, the default limit (~1000) silently downgrades rename detection and
    // renamed+edited files would render as delete+add pairs. A large literal
    // instead of -l0 because "0 = unlimited" only holds on git >= 2.29.
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

  const diff = await runtime.runGit(diffArgsFor(range), { cwd });
  if (diff.exitCode !== 0) {
    const message = diff.stderr.trim() || "git diff failed";
    return unavailable(message.split("\n").find((line) => line.trim().length > 0) ?? message);
  }
  if (!diff.stdout.trim()) {
    return unavailable("Local recompute produced an empty diff.");
  }

  return { patch: diff.stdout, label: "PR diff (recomputed locally)" };
}

/**
 * Staleness fingerprint for the full-stack diff above. The diff is three-dot
 * (`baseRef...HEAD` = merge-base(baseRef, HEAD)..HEAD), so its content changes
 * exactly when HEAD or the MERGE-BASE moves — and NOT when the base branch
 * merely advances past an unchanged fork point. Fingerprinting (merge-base,
 * HEAD) therefore detects the real stale cases (commits on HEAD, a lower
 * stacked PR merging, a rebase/force-push shifting the fork point) without
 * crying stale on every ordinary `origin/<default>` fetch. `null` = cannot
 * fingerprint (treated as always-fresh).
 */
export async function getPRFullStackFingerprint(
  runtime: ReviewGitRuntime,
  metadata: PRMetadata,
  cwd?: string,
): Promise<string | null> {
  const defaultBranch = metadata.defaultBranch;
  if (!defaultBranch || !branchNameIsSafe(defaultBranch)) return null;
  const baseRef = await resolvePRFullStackBaseRef(runtime, defaultBranch, cwd);
  if (!baseRef) return null;

  // --no-optional-locks: probes run on a background poll and must never take
  // git's index lock alongside concurrent agent git operations.
  const head = await runtime.runGit(["--no-optional-locks", "rev-parse", "HEAD"], { cwd });
  if (head.exitCode !== 0) return null;
  const mergeBase = await runtime.runGit(
    ["--no-optional-locks", "merge-base", "--end-of-options", baseRef, "HEAD"],
    { cwd },
  );
  if (mergeBase.exitCode !== 0) return null;
  return `pr-full-stack:${mergeBase.stdout.trim()}:${head.stdout.trim()}`;
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
