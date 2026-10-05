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

import { checkGhAuth, getGhUser, fetchGhPR, fetchGhPRContext, fetchGhPRFileContent, fetchGhPRFileBytes, fetchGhPRLfsFileBytes, submitGhPRReview, foldFileLevelComments, fetchGhPRViewedFiles, markGhFilesViewed, fetchGhPRStack, fetchGhPRList } from "./pr-github";
import { checkGlAuth, getGlUser, fetchGlMR, fetchGlMRContext, fetchGlFileContent, fetchGlFileBytes, submitGlMRReview } from "./pr-gitlab";
import { checkBbAuth, getBbUser, fetchBbPR, fetchBbPRContext, fetchBbFileContent, fetchBbFileBytes, submitBbPRReview, fetchBbPRList } from "./pr-bitbucket";
import type { BitbucketPRRef, GithubPRRef, GitlabMRRef, Platform, PRFileBytesResult, PRRuntime, PRRef, PRMetadata, PRContext, PRReviewFileComment, PRReviewFileLevelComment, PRReviewAction, PRReviewSubmissionResult, PRStackTree, PRListItem } from "./pr-types";

// Re-export the browser-safe surface so server callers can keep using
// pr-provider as a single facade. Browser code imports from pr-types
// directly to avoid pulling pr-github / pr-gitlab into the client bundle.
export * from "./pr-types";

// --- Provider contract ---

/** One PR platform's server implementation. */
export interface PRProvider<R extends PRRef = PRRef> {
  checkAuth(runtime: PRRuntime, ref: R): Promise<void>;
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
  /**
   * The real bytes of a Git LFS file at one commit (#1665), capped at
   * `maxBytes`. Absent: the platform has no LFS route and LFS images keep the
   * `lfs-pointer` answer. The caller verifies the bytes against the pointer.
   */
  fetchLfsFileBytes?(
    runtime: PRRuntime,
    ref: R,
    sha: string,
    filePath: string,
    maxBytes: number,
    signal?: AbortSignal,
  ): Promise<PRFileBytesResult>;
}

const githubProvider: PRProvider<GithubPRRef> = {
  checkAuth: (runtime, ref) => checkGhAuth(runtime, ref.host),
  getUser: (runtime, ref) => getGhUser(runtime, ref.host),
  fetchPR: fetchGhPR,
  fetchContext: fetchGhPRContext,
  fetchFileContent: fetchGhPRFileContent,
  fetchFileBytes: fetchGhPRFileBytes,
  fetchLfsFileBytes: fetchGhPRLfsFileBytes,
  submitReview: submitGhPRReview,
  fetchViewedFiles: fetchGhPRViewedFiles,
  markFilesViewed: markGhFilesViewed,
  fetchStack: fetchGhPRStack,
  fetchList: fetchGhPRList,
};

const gitlabProvider: PRProvider<GitlabMRRef> = {
  checkAuth: (runtime, ref) => checkGlAuth(runtime, ref.host),
  getUser: (runtime, ref) => getGlUser(runtime, ref.host),
  fetchPR: fetchGlMR,
  fetchContext: fetchGlMRContext,
  fetchFileContent: fetchGlFileContent,
  fetchFileBytes: fetchGlFileBytes,
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

// --- Dispatch Functions ---

export async function checkAuth(runtime: PRRuntime, ref: PRRef): Promise<void> {
  return getPRProvider(ref).checkAuth(runtime, ref);
}

export async function getUser(runtime: PRRuntime, ref: PRRef): Promise<string | null> {
  return getPRProvider(ref).getUser(runtime, ref);
}

export async function fetchPR(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
  return getPRProvider(ref).fetchPR(runtime, ref);
}

export async function fetchPRContext(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRContext> {
  return getPRProvider(ref).fetchContext(runtime, ref);
}

export async function fetchPRFileContent(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  return getPRProvider(ref).fetchFileContent(runtime, ref, sha, filePath);
}

/** One file at one commit as raw bytes (image preview), capped at `maxBytes`. */
export async function fetchPRFileBytes(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
  maxBytes: number,
): Promise<PRFileBytesResult> {
  return getPRProvider(ref).fetchFileBytes(runtime, ref, sha, filePath, maxBytes);
}

/**
 * One Git LFS file at one commit as its real bytes (#1665). Null when the
 * platform has no LFS route (GitLab, Bitbucket).
 */
export async function fetchPRLfsFileBytes(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
  maxBytes: number,
  signal?: AbortSignal,
): Promise<PRFileBytesResult | null> {
  const provider = getPRProvider(ref);
  return provider.fetchLfsFileBytes ? provider.fetchLfsFileBytes(runtime, ref, sha, filePath, maxBytes, signal) : null;
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
  return getPRProvider(ref).submitReview(runtime, ref, headSha, action, body, fileComments, fileLevelComments);
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
  return provider.fetchViewedFiles ? provider.fetchViewedFiles(runtime, ref) : {};
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
  if (provider.markFilesViewed) return provider.markFilesViewed(runtime, ref, prNodeId, filePaths, viewed);
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
  return provider.fetchStack ? provider.fetchStack(runtime, ref, metadata) : null;
}

export async function fetchPRList(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRListItem[]> {
  const provider = getPRProvider(ref);
  return provider.fetchList ? provider.fetchList(runtime, ref) : [];
}
