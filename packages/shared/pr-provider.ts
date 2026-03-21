/**
 * Runtime-agnostic PR provider shared by Bun runtimes and Pi.
 *
 * Dispatches to platform-specific implementations (GitHub, GitLab)
 * based on the `platform` field in PRRef/PRMetadata.
 *
 * Same pattern as review-core.ts: a runtime interface abstracts subprocess
 * execution so the logic is reusable across Bun and Node/jiti.
 */

import { checkGhAuth, getGhUser, fetchGhPR, fetchGhPRContext, fetchGhPRFileContent, submitGhPRReview } from "./pr-github";
import { checkGlAuth, getGlUser, fetchGlMR, fetchGlMRContext, fetchGlFileContent, submitGlMRReview } from "./pr-gitlab";

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

export type Platform = "github" | "gitlab";

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

/** Discriminated union — auto-detected from URL */
export type PRRef = GithubPRRef | GitlabMRRef;

/** GitHub PR metadata */
export interface GithubPRMetadata {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
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

/** Discriminated union — downstream gets type narrowing for free */
export type PRMetadata = GithubPRMetadata | GitlabMRMetadata;

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

/** "GitHub" or "GitLab" */
export function getPlatformLabel(m: HasPlatform): string {
  return m.platform === "github" ? "GitHub" : "GitLab";
}

/** "PR" or "MR" */
export function getMRLabel(m: HasPlatform): string {
  return m.platform === "github" ? "PR" : "MR";
}

/** "#123" or "!42" */
export function getMRNumberLabel(m: HasPlatform): string {
  if (m.platform === "github") return `#${m.number}`;
  return `!${m.iid}`;
}

/** "owner/repo" or "group/project" */
export function getDisplayRepo(m: HasPlatform): string {
  if (m.platform === "github") return `${m.owner}/${m.repo}`;
  return m.projectPath;
}

/** Reconstruct a PRRef from metadata */
export function prRefFromMetadata(m: PRMetadata): PRRef {
  if (m.platform === "github") {
    return { platform: "github", owner: m.owner, repo: m.repo, number: m.number };
  }
  return { platform: "gitlab", host: m.host, projectPath: m.projectPath, iid: m.iid };
}

/** CLI tool name for the platform */
export function getCliName(ref: PRRef): string {
  return ref.platform === "github" ? "gh" : "glab";
}

/** Install URL for the platform CLI */
export function getCliInstallUrl(ref: PRRef): string {
  return ref.platform === "github"
    ? "https://cli.github.com"
    : "https://gitlab.com/gitlab-org/cli";
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

  // GitLab: https://{host}/{projectPath}/-/merge_requests/{iid}[/...]
  // Handles any hostname, nested groups, self-hosted instances
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
  return checkGlAuth(runtime, ref.host);
}

export async function getUser(runtime: PRRuntime, ref: PRRef): Promise<string | null> {
  if (ref.platform === "github") return getGhUser(runtime);
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
