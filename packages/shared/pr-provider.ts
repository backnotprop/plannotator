/**
 * Server-only PR/MR dispatch.
 *
 * Each platform is one `PRProvider` implementation (pr-github.ts,
 * pr-gitlab.ts, pr-bitbucket.ts) registered in `PROVIDERS`; the exported
 * functions look the provider up from `PRRef.platform` and delegate. Optional
 * provider methods are capabilities: a platform that omits one gets the
 * documented neutral answer (no viewed state, no stack, empty PR list), and
 * the UI hides the feature through `getPRPlatformCapabilities` (pr-types.ts).
 *
 * These implementations may use Node built-ins (fs, os, path) for things
 * like persisting failed comments — they must never be imported
 * from browser code.
 *
 * Pure types and label helpers live in pr-types.ts, which is
 * browser-safe.
 */

import { checkGhAuth, getGhUser, fetchGhPR, fetchGhPRContext, fetchGhPRFileContent, fetchGhPRFileBytes, submitGhPRReview, foldFileLevelComments, fetchGhPRViewedFiles, markGhFilesViewed, fetchGhPRStack, fetchGhPRList, fetchGhPRTree } from "./pr-github";
import { checkGlAuth, getGlUser, fetchGlMR, fetchGlMRContext, fetchGlFileContent, fetchGlFileBytes, submitGlMRReview, fetchGlTree } from "./pr-gitlab";
import { checkBbAuth, getBbUser, fetchBbPR, fetchBbPRContext, fetchBbFileContent, fetchBbFileBytes, submitBbPRReview, fetchBbPRList, fetchBbTree } from "./pr-bitbucket";
import { ensureGhPRAccess, ghScopedRuntime } from "./pr-github-account";
import type { BitbucketPRRef, GithubPRRef, GitlabMRRef, Platform, PRAuthResult, PRFileBytesResult, PRRuntime, PRRef, PRMetadata, PRContext, PRReviewFileComment, PRReviewFileLevelComment, PRReviewAction, PRReviewSubmissionResult, PRStackTree, PRListItem, PRTreeResult } from "./pr-types";

// Re-export the browser-safe surface so server callers can keep using
// pr-provider as a single facade. Browser code imports from pr-types
// directly to avoid pulling pr-github / pr-gitlab into the client bundle.
export * from "./pr-types";

// --- Provider contract ---

/** One PR platform's server implementation. */
export interface PRProvider<R extends PRRef = PRRef> {
  /**
   * Fails (throws) when the review cannot start. May answer what it learned,
   * e.g. GitHub's choice of another signed-in account (pr-github-account.ts).
   */
  checkAuth(runtime: PRRuntime, ref: R): Promise<PRAuthResult | void>;
  getUser(runtime: PRRuntime, ref: R): Promise<string | null>;
  fetchPR(runtime: PRRuntime, ref: R): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }>;
  fetchContext(runtime: PRRuntime, ref: R): Promise<PRContext>;
  fetchFileContent(runtime: PRRuntime, ref: R, sha: string, filePath: string): Promise<string | null>;
  fetchFileBytes(runtime: PRRuntime, ref: R, sha: string, filePath: string, maxBytes: number): Promise<PRFileBytesResult>;
  submitReview(
    runtime: PRRuntime,
    ref: R,
    headSha: string,
    action: PRReviewAction,
    body: string,
    fileComments: PRReviewFileComment[],
    fileLevelComments: PRReviewFileLevelComment[],
  ): Promise<PRReviewSubmissionResult>;
  /** Server-side per-file viewed state. Absent: no viewed sync. */
  fetchViewedFiles?(runtime: PRRuntime, ref: R): Promise<Record<string, boolean>>;
  markFilesViewed?(runtime: PRRuntime, ref: R, prNodeId: string, filePaths: string[], viewed: boolean): Promise<void>;
  /** Stack discovery. Absent: the client falls back to a branch-inferred stack. */
  fetchStack?(runtime: PRRuntime, ref: R, metadata: PRMetadata): Promise<PRStackTree | null>;
  /** Recent PRs for the switcher. Absent: an empty list. */
  fetchList?(runtime: PRRuntime, ref: R): Promise<PRListItem[]>;
  /** Every file of one commit (All files without a checkout). Absent: no listing. */
  fetchTree?(runtime: PRRuntime, ref: R, sha: string): Promise<PRTreeResult | null>;
}

const githubProvider: PRProvider<GithubPRRef> = {
  // gh is signed in, then the account in use can see THIS PR (#2157): when it
  // can't, another signed-in account that can is used for this review only.
  checkAuth: async (runtime, ref) => {
    await checkGhAuth(runtime, ref.host);
    return ensureGhPRAccess(runtime, ref);
  },
  getUser: (runtime, ref) => getGhUser(runtime, ref.host),
  fetchPR: fetchGhPR,
  fetchContext: fetchGhPRContext,
  fetchFileContent: fetchGhPRFileContent,
  fetchFileBytes: fetchGhPRFileBytes,
  submitReview: submitGhPRReview,
  fetchViewedFiles: fetchGhPRViewedFiles,
  markFilesViewed: markGhFilesViewed,
  fetchStack: fetchGhPRStack,
  fetchList: fetchGhPRList,
  fetchTree: fetchGhPRTree,
};

const gitlabProvider: PRProvider<GitlabMRRef> = {
  checkAuth: (runtime, ref) => checkGlAuth(runtime, ref.host),
  getUser: (runtime, ref) => getGlUser(runtime, ref.host),
  fetchPR: fetchGlMR,
  fetchContext: fetchGlMRContext,
  fetchFileContent: fetchGlFileContent,
  fetchFileBytes: fetchGlFileBytes,
  fetchTree: fetchGlTree,
  // GitLab has no file-level discussion: file comments ride the body (#1599).
  submitReview: (runtime, ref, headSha, action, body, fileComments, fileLevelComments) =>
    submitGlMRReview(runtime, ref, headSha, action, foldFileLevelComments(body, fileLevelComments), fileComments),
};

const bitbucketProvider: PRProvider<BitbucketPRRef> = {
  checkAuth: (runtime) => checkBbAuth(runtime),
  getUser: (runtime) => getBbUser(runtime),
  fetchPR: fetchBbPR,
  fetchContext: fetchBbPRContext,
  fetchFileContent: fetchBbFileContent,
  fetchFileBytes: fetchBbFileBytes,
  // File comments fold into the body like GitLab (see the capability note).
  submitReview: (runtime, ref, headSha, action, body, fileComments, fileLevelComments) =>
    submitBbPRReview(runtime, ref, headSha, action, foldFileLevelComments(body, fileLevelComments), fileComments),
  fetchList: fetchBbPRList,
  fetchTree: fetchBbTree,
};

type ProviderRegistry = { [P in Platform]: PRProvider<Extract<PRRef, { platform: P }>> };

const PROVIDERS: ProviderRegistry = {
  github: githubProvider,
  gitlab: gitlabProvider,
  bitbucket: bitbucketProvider,
};

/** The provider for a ref's platform. */
export function getPRProvider(ref: PRRef): PRProvider {
  return PROVIDERS[ref.platform] as PRProvider;
}

/**
 * The runtime a ref's calls go through: for a GitHub PR whose active gh
 * account could not see it, `gh` runs as the signed-in account that can
 * (chosen by `checkAuth`); otherwise the runtime as given.
 */
function runtimeFor(runtime: PRRuntime, ref: PRRef): PRRuntime {
  return ref.platform === "github" ? ghScopedRuntime(runtime, ref) : runtime;
}

// --- Dispatch Functions ---

export async function checkAuth(runtime: PRRuntime, ref: PRRef): Promise<PRAuthResult> {
  return (await getPRProvider(ref).checkAuth(runtime, ref)) ?? {};
}

export async function getUser(runtime: PRRuntime, ref: PRRef): Promise<string | null> {
  return getPRProvider(ref).getUser(runtimeFor(runtime, ref), ref);
}

export async function fetchPR(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
  return getPRProvider(ref).fetchPR(runtimeFor(runtime, ref), ref);
}

export async function fetchPRContext(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRContext> {
  return getPRProvider(ref).fetchContext(runtimeFor(runtime, ref), ref);
}

export async function fetchPRFileContent(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  return getPRProvider(ref).fetchFileContent(runtimeFor(runtime, ref), ref, sha, filePath);
}

/** One file at one commit as raw bytes (image preview), capped at `maxBytes`. */
export async function fetchPRFileBytes(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
  maxBytes: number,
): Promise<PRFileBytesResult> {
  return getPRProvider(ref).fetchFileBytes(runtimeFor(runtime, ref), ref, sha, filePath, maxBytes);
}

/** Every file of one commit from the platform's tree API; null when unavailable. */
export async function fetchPRTree(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
): Promise<PRTreeResult | null> {
  const provider = getPRProvider(ref);
  return provider.fetchTree ? provider.fetchTree(runtimeFor(runtime, ref), ref, sha) : null;
}

/** Submit a platform review and preserve any provider-specific partial result. */
export async function submitPRReview(
  runtime: PRRuntime,
  ref: PRRef,
  headSha: string,
  action: PRReviewAction,
  body: string,
  fileComments: PRReviewFileComment[],
  fileLevelComments: PRReviewFileLevelComment[] = [],
): Promise<PRReviewSubmissionResult> {
  return getPRProvider(ref).submitReview(runtimeFor(runtime, ref), ref, headSha, action, body, fileComments, fileLevelComments);
}

/**
 * Fetch per-file "viewed" state for a PR.
 * GitHub: returns { filePath: isViewed } map.
 * Platforms without server-side viewed state (GitLab, Bitbucket): {}.
 */
export async function fetchPRViewedFiles(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<Record<string, boolean>> {
  const provider = getPRProvider(ref);
  return provider.fetchViewedFiles ? provider.fetchViewedFiles(runtimeFor(runtime, ref), ref) : {};
}

/**
 * Mark or unmark files as viewed in a PR.
 * GitHub: fires markFileAsViewed / unmarkFileAsViewed GraphQL mutations.
 * Other platforms: no-op (no server-side viewed state API).
 */
export async function markPRFilesViewed(
  runtime: PRRuntime,
  ref: PRRef,
  prNodeId: string,
  filePaths: string[],
  viewed: boolean,
): Promise<void> {
  const provider = getPRProvider(ref);
  if (provider.markFilesViewed) return provider.markFilesViewed(runtimeFor(runtime, ref), ref, prNodeId, filePaths, viewed);
}

/**
 * Fetch the full stack tree for a stacked PR.
 * Walks up from the current PR to the default branch, resolving
 * PR numbers and titles for each intermediate branch.
 * Returns null if the PR is not stacked, the API call fails, or the
 * platform has no stack discovery.
 */
export async function fetchPRStack(
  runtime: PRRuntime,
  ref: PRRef,
  metadata: PRMetadata,
): Promise<PRStackTree | null> {
  const provider = getPRProvider(ref);
  return provider.fetchStack ? provider.fetchStack(runtimeFor(runtime, ref), ref, metadata) : null;
}

export async function fetchPRList(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRListItem[]> {
  const provider = getPRProvider(ref);
  return provider.fetchList ? provider.fetchList(runtimeFor(runtime, ref), ref) : [];
}
