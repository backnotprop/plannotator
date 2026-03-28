/**
 * Runtime-agnostic PR provider shared by Bun runtimes and Pi.
 *
 * Dispatches to platform-specific implementations (GitHub, GitLab)
 * based on the `platform` field in PRRef/PRMetadata.
 *
 * Same pattern as review-core.ts: a runtime interface abstracts subprocess
 * execution so the logic is reusable across Bun and Node/jiti.
 */

import { checkGhAuth, getGhUser, fetchGhPR, fetchGhPRContext, fetchGhPRFileContent, submitGhPRReview, fetchGhPRViewedFiles, markGhFilesViewed } from "./pr-github";
import { checkGlAuth, getGlUser, fetchGlMR, fetchGlMRContext, fetchGlFileContent, submitGlMRReview } from "./pr-gitlab";
import { checkAdoAuth, getAdoUser, fetchAdoPR, fetchAdoPRContext, fetchAdoFileContent, submitAdoPRReview } from "./pr-azuredevops";

// --- Runtime Types ---

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface PRRuntime {
  runCommand: (
    cmd: string,
    args: string[],
  ) => Promise<CommandResult>;
  runCommandWithInput?: (
    cmd: string,
    args: string[],
    input: string,
  ) => Promise<CommandResult>;
}

// --- Platform Types ---

export type Platform = "github" | "gitlab" | "azuredevops";

/** GitHub PR reference */
export interface GithubPRRef {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
}

/** GitLab MR reference */
export interface GitlabMRRef {
  platform: "gitlab";
  host: string;
  projectPath: string;
  iid: number;
}

/** Azure DevOps PR reference */
export interface AzureDevOpsPRRef {
  platform: "azuredevops";
  orgUrl: string;       // e.g., "https://dev.azure.com/myorg"
  organization: string; // e.g., "myorg"
  project: string;      // e.g., "MyProject"
  repo: string;         // e.g., "MyRepo"
  id: number;           // PR number
}

/** Discriminated union — auto-detected from URL */
export type PRRef = GithubPRRef | GitlabMRRef | AzureDevOpsPRRef;

/** GitHub PR metadata */
export interface GithubPRMetadata {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
  /** GraphQL node ID for the PR — used for markFileAsViewed mutations */
  prNodeId?: string;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  url: string;
}

/** GitLab MR metadata */
export interface GitlabMRMetadata {
  platform: "gitlab";
  host: string;
  projectPath: string;
  iid: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  url: string;
}

/** Azure DevOps PR metadata */
export interface AzureDevOpsPRMetadata {
  platform: "azuredevops";
  orgUrl: string;
  organization: string;
  project: string;
  repo: string;
  id: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  baseSha: string;
  headSha: string;
  url: string;
}

/** Discriminated union — downstream gets type narrowing for free */
export type PRMetadata = GithubPRMetadata | GitlabMRMetadata | AzureDevOpsPRMetadata;

// --- PR Context Types (platform-agnostic) ---

export interface PRComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReview {
  id: string;
  author: string;
  state: string;
  body: string;
  submittedAt: string;
}

export interface PRCheck {
  name: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  detailsUrl: string;
}

export interface PRLinkedIssue {
  number: number;
  url: string;
  repo: string;
}

export interface PRContext {
  body: string;
  state: string;
  isDraft: boolean;
  labels: Array<{ name: string; color: string }>;
  reviewDecision: string;
  mergeable: string;
  mergeStateStatus: string;
  comments: PRComment[];
  reviews: PRReview[];
  checks: PRCheck[];
  linkedIssues: PRLinkedIssue[];
}

export interface PRReviewFileComment {
  path: string;
  line: number;
  side: "LEFT" | "RIGHT";
  body: string;
  start_line?: number;
  start_side?: "LEFT" | "RIGHT";
}

// --- Label Helpers ---
// Accept either PRRef or PRMetadata (both have `platform` discriminant)

type HasPlatform = PRRef | PRMetadata;

/** "GitHub", "GitLab", or "Azure DevOps" */
export function getPlatformLabel(m: HasPlatform): string {
  if (m.platform === "github") return "GitHub";
  if (m.platform === "gitlab") return "GitLab";
  return "Azure DevOps";
}

/** "PR" or "MR" */
export function getMRLabel(m: HasPlatform): string {
  return m.platform === "github" ? "PR" : m.platform === "gitlab" ? "MR" : "PR";
}

/** "#123", "!42", or "!123" */
export function getMRNumberLabel(m: HasPlatform): string {
  if (m.platform === "github") return `#${m.number}`;
  if (m.platform === "gitlab") return `!${m.iid}`;
  return `!${m.id}`;
}

/** "owner/repo", "group/project", or "org/project/repo" */
export function getDisplayRepo(m: HasPlatform): string {
  if (m.platform === "github") return `${m.owner}/${m.repo}`;
  if (m.platform === "gitlab") return m.projectPath;
  return `${m.organization}/${m.project}/${m.repo}`;
}

/** Reconstruct a PRRef from metadata */
export function prRefFromMetadata(m: PRMetadata): PRRef {
  if (m.platform === "github") {
    return { platform: "github", owner: m.owner, repo: m.repo, number: m.number };
  }
  if (m.platform === "gitlab") {
    return { platform: "gitlab", host: m.host, projectPath: m.projectPath, iid: m.iid };
  }
  return { platform: "azuredevops", orgUrl: m.orgUrl, organization: m.organization, project: m.project, repo: m.repo, id: m.id };
}

/** CLI tool name for the platform */
export function getCliName(ref: PRRef): string {
  if (ref.platform === "github") return "gh";
  if (ref.platform === "gitlab") return "glab";
  return "az";
}

/** Install URL for the platform CLI */
export function getCliInstallUrl(ref: PRRef): string {
  if (ref.platform === "github") return "https://cli.github.com";
  if (ref.platform === "gitlab") return "https://gitlab.com/gitlab-org/cli";
  return "https://learn.microsoft.com/en-us/cli/azure/install-azure-cli";
}

/** Encode a file path for use in platform API URLs */
export function encodeApiFilePath(filePath: string): string {
  return encodeURIComponent(filePath);
}

// --- URL Parsing ---

/**
 * Parse a PR/MR URL into its components. Auto-detects platform.
 *
 * Handles:
 * - GitHub: https://github.com/owner/repo/pull/123[/files|/commits]
 * - GitLab: https://gitlab.com/group/subgroup/project/-/merge_requests/42[/diffs]
 * - Self-hosted GitLab: https://gitlab.mycompany.com/group/project/-/merge_requests/42
 * - Azure DevOps: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
 * - Azure DevOps (legacy): https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}
 */
export function parsePRUrl(url: string): PRRef | null {
  if (!url) return null;

  // GitHub: https://github.com/{owner}/{repo}/pull/{number}[/...]
  const ghMatch = url.match(
    /^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (ghMatch) {
    return {
      platform: "github",
      owner: ghMatch[1],
      repo: ghMatch[2],
      number: parseInt(ghMatch[3], 10),
    };
  }

  // Azure DevOps: https://dev.azure.com/{org}/{project}/_git/{repo}/pullrequest/{id}
  const adoMatch = url.match(
    /^https?:\/\/dev\.azure\.com\/([^/]+)\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i,
  );
  if (adoMatch) {
    return {
      platform: "azuredevops",
      orgUrl: `https://dev.azure.com/${adoMatch[1]}`,
      organization: adoMatch[1],
      project: decodeURIComponent(adoMatch[2]),
      repo: decodeURIComponent(adoMatch[3]),
      id: parseInt(adoMatch[4], 10),
    };
  }

  // Azure DevOps (legacy visualstudio.com): https://{org}.visualstudio.com/{project}/_git/{repo}/pullrequest/{id}
  const vsMatch = url.match(
    /^https?:\/\/([^.]+)\.visualstudio\.com\/([^/]+)\/_git\/([^/]+)\/pullrequest\/(\d+)/i,
  );
  if (vsMatch) {
    return {
      platform: "azuredevops",
      orgUrl: `https://${vsMatch[1]}.visualstudio.com`,
      organization: vsMatch[1],
      project: decodeURIComponent(vsMatch[2]),
      repo: decodeURIComponent(vsMatch[3]),
      id: parseInt(vsMatch[4], 10),
    };
  }

  // GitLab: https://{host}/{projectPath}/-/merge_requests/{iid}[/...]
  // Handles any hostname, nested groups, self-hosted instances.
  // Must come after ADO checks to avoid false-matching dev.azure.com paths.
  const glMatch = url.match(
    /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/,
  );
  if (glMatch) {
    return {
      platform: "gitlab",
      host: glMatch[1],
      projectPath: glMatch[2],
      iid: parseInt(glMatch[3], 10),
    };
  }

  return null;
}

// --- Dispatch Functions ---

export async function checkAuth(runtime: PRRuntime, ref: PRRef): Promise<void> {
  if (ref.platform === "github") return checkGhAuth(runtime);
  if (ref.platform === "gitlab") return checkGlAuth(runtime, ref.host);
  return checkAdoAuth(runtime, ref.orgUrl);
}

export async function getUser(runtime: PRRuntime, ref: PRRef): Promise<string | null> {
  if (ref.platform === "github") return getGhUser(runtime);
  if (ref.platform === "gitlab") return getGlUser(runtime, ref.host);
  return getAdoUser(runtime, ref.orgUrl);
}

export async function fetchPR(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  if (ref.platform === "github") return fetchGhPR(runtime, ref);
  if (ref.platform === "gitlab") return fetchGlMR(runtime, ref);
  return fetchAdoPR(runtime, ref);
}

export async function fetchPRContext(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<PRContext> {
  if (ref.platform === "github") return fetchGhPRContext(runtime, ref);
  if (ref.platform === "gitlab") return fetchGlMRContext(runtime, ref);
  return fetchAdoPRContext(runtime, ref);
}

export async function fetchPRFileContent(
  runtime: PRRuntime,
  ref: PRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  if (ref.platform === "github") return fetchGhPRFileContent(runtime, ref, sha, filePath);
  if (ref.platform === "gitlab") return fetchGlFileContent(runtime, ref, sha, filePath);
  return fetchAdoFileContent(runtime, ref, sha, filePath);
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
  if (ref.platform === "gitlab") return submitGlMRReview(runtime, ref, headSha, action, body, fileComments);
  return submitAdoPRReview(runtime, ref, headSha, action, body, fileComments);
}

/**
 * Fetch per-file "viewed" state for a PR.
 * GitHub: returns { filePath: isViewed } map.
 * GitLab/Azure DevOps: always returns {} (no server-side viewed state API).
 */
export async function fetchPRViewedFiles(
  runtime: PRRuntime,
  ref: PRRef,
): Promise<Record<string, boolean>> {
  if (ref.platform === "github") return fetchGhPRViewedFiles(runtime, ref);
  return {}; // GitLab and Azure DevOps have no server-side viewed state
}

/**
 * Mark or unmark files as viewed in a PR.
 * GitHub: fires markFileAsViewed / unmarkFileAsViewed GraphQL mutations.
 * GitLab/Azure DevOps: no-op (no server-side viewed state API).
 */
export async function markPRFilesViewed(
  runtime: PRRuntime,
  ref: PRRef,
  prNodeId: string,
  filePaths: string[],
  viewed: boolean,
): Promise<void> {
  if (ref.platform === "github") return markGhFilesViewed(runtime, ref, prNodeId, filePaths, viewed);
  // GitLab and Azure DevOps: no-op
}
