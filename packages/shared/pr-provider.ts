/**
 * Server-only PR/MR dispatch.
 *
 * Picks GitHub vs GitLab from PRRef.platform and delegates to the
 * platform implementation in pr-github.ts / pr-gitlab.ts. These
 * implementations may use Node built-ins (fs, os, path) for things
 * like persisting failed comments — they must never be imported
 * from browser code.
 *
 * Pure types and label helpers live in pr-types.ts, which is
 * browser-safe.
 */

import { checkGhAuth, getGhUser, fetchGhPR, fetchGhPRContext, fetchGhPRFileContent, submitGhPRReview, fetchGhPRViewedFiles, markGhFilesViewed, fetchGhPRStack, fetchGhPRList } from "./pr-github";
import { checkGlAuth, getGlUser, fetchGlMR, fetchGlMRContext, fetchGlFileContent, submitGlMRReview } from "./pr-gitlab";
import type { PRRuntime, PRRef, PRMetadata, PRContext, PRReviewFileComment, PRStackTree, PRListItem } from "./pr-types";

// Re-export the browser-safe surface so server callers can keep using
// pr-provider as a single facade. Browser code imports from pr-types
// directly to avoid pulling pr-github / pr-gitlab into the client bundle.
export * from "./pr-types";

// --- Dispatch Functions ---

export async function checkAuth(runtime: PRRuntime, ref: PRRef): Promise<void> {
  if (ref.platform === "github") return checkGhAuth(runtime, ref.host);
  return checkGlAuth(runtime, ref.host);
}

export async function getUser(runtime: PRRuntime, ref: PRRef): Promise<string | null> {
  if (ref.platform === "github") return getGhUser(runtime, ref.host);
  return getGlUser(runtime, ref.host);
}

export async function fetchPR(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  if (ref.platform === "github") return fetchGhPR(runtime, ref);
  return fetchGlMR(runtime, ref);
}

export async function fetchPRContext(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRContext> {
  if (ref.platform === "github") return fetchGhPRContext(runtime, ref);
  return fetchGlMRContext(runtime, ref);
}

export async function fetchPRFileContent(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  if (ref.platform === "github") return fetchGhPRFileContent(runtime, ref, sha, filePath);
  return fetchGlFileContent(runtime, ref, sha, filePath);
}

export async function submitPRReview(
  runtime: PRRuntime,
  ref: PRRef,
  headSha: string,
  action: "approve" | "comment",
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<void> {
  if (ref.platform === "github") return submitGhPRReview(runtime, ref, headSha, action, body, fileComments);
  return submitGlMRReview(runtime, ref, headSha, action, body, fileComments);
}

/**
 * Fetch per-file "viewed" state for a PR.
 * GitHub: returns { filePath: isViewed } map.
 * GitLab: always returns {} (no server-side viewed state API).
 */
export async function fetchPRViewedFiles(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<Record<string, boolean>> {
  if (ref.platform === "github") return fetchGhPRViewedFiles(runtime, ref);
  return {}; // GitLab has no server-side viewed state
}

/**
 * Mark or unmark files as viewed in a PR.
 * GitHub: fires markFileAsViewed / unmarkFileAsViewed GraphQL mutations.
 * GitLab: no-op (no server-side viewed state API).
 */
export async function markPRFilesViewed(
  runtime: PRRuntime,
  ref: PRRef,
  prNodeId: string,
  filePaths: string[],
  viewed: boolean,
): Promise<void> {
  if (ref.platform === "github") return markGhFilesViewed(runtime, ref, prNodeId, filePaths, viewed);
  // GitLab: no-op
}

/**
 * Fetch the full stack tree for a stacked PR.
 * Walks up from the current PR to the default branch, resolving
 * PR numbers and titles for each intermediate branch.
 * Returns null if the PR is not stacked or the API call fails.
 */
export async function fetchPRStack(
  runtime: PRRuntime,
  ref: PRRef,
  metadata: PRMetadata,
): Promise<PRStackTree | null> {
  if (ref.platform === "github") return fetchGhPRStack(runtime, ref, metadata);
  return null; // GitLab: not yet implemented
}

export async function fetchPRList(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRListItem[]> {
  if (ref.platform === "github") return fetchGhPRList(runtime, ref);
  return []; // GitLab: not yet implemented
}
