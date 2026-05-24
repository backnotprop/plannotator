/**
 * Browser-safe PR/MR types and pure helpers.
 *
 * Split out from pr-provider.ts so the review UI can import types,
 * label helpers, and URL parsing without dragging the GitHub/GitLab
 * server implementations (and their Node-only dependencies) through
 * the browser bundle. pr-provider.ts re-exports nothing from here;
 * server-side dispatch lives there.
 */

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
  host: string;
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
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** GraphQL node ID for the PR — used for markFileAsViewed mutations */
  prNodeId?: string;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  /** Repository default branch, used to infer whether this PR targets another PR branch. */
  defaultBranch?: string;
  baseSha: string;
  headSha: string;
  /** Merge-base SHA — the common ancestor commit used to compute the PR diff. Differs from baseSha when the base branch has moved. */
  mergeBaseSha?: string;
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
  /** Project default branch, used to infer whether this MR targets another MR branch. */
  defaultBranch?: string;
  baseSha: string;
  headSha: string;
  /** Merge-base SHA — the common ancestor commit used to compute the MR diff. */
  mergeBaseSha?: string;
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
  url?: string;
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

export interface PRThreadComment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
  url: string;
  diffHunk?: string;
}

export interface PRReviewThread {
  id: string;
  isResolved: boolean;
  isOutdated: boolean;
  path: string;
  line: number | null;
  startLine: number | null;
  diffSide: 'LEFT' | 'RIGHT' | null;
  comments: PRThreadComment[];
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
  reviewThreads: PRReviewThread[];
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

export type PRDiffScope = "layer" | "full-stack";

export interface PRDiffScopeOption {
  id: PRDiffScope;
  label: string;
  description: string;
  enabled: boolean;
}

export interface PRStackInfo {
  isStacked: boolean;
  baseBranch: string;
  defaultBranch?: string;
  label: string;
  source: "branch-inferred" | "tree-discovered" | "github-native" | "gitlab-native" | "graphite" | "ghstack";
}

export interface PRStackNode {
  branch: string;
  number?: number;
  title?: string;
  url?: string;
  isCurrent: boolean;
  isDefaultBranch: boolean;
  state?: 'open' | 'merged' | 'closed';
}

export interface PRStackTree {
  nodes: PRStackNode[];
}

export interface PRListItem {
  id: string;
  number: number;
  title: string;
  author: string;
  url: string;
  baseBranch: string;
  state: 'open' | 'closed' | 'merged';
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
    return { platform: "github", host: m.host, owner: m.owner, repo: m.repo, number: m.number };
  }
  return { platform: "gitlab", host: m.host, projectPath: m.projectPath, iid: m.iid };
}

export function isSameProject(a: PRRef, b: PRRef): boolean {
  if (a.platform !== b.platform) return false;
  if (a.platform === "github" && b.platform === "github") {
    return a.host === b.host && a.owner === b.owner && a.repo === b.repo;
  }
  if (a.platform === "gitlab" && b.platform === "gitlab") {
    return a.host === b.host && a.projectPath === b.projectPath;
  }
  return false;
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
 * - GitHub Enterprise: https://ghe.company.com/owner/repo/pull/123
 * - GitLab: https://gitlab.com/group/subgroup/project/-/merge_requests/42[/diffs]
 * - Self-hosted GitLab: https://gitlab.mycompany.com/group/project/-/merge_requests/42
 *
 * GitLab is checked first because `/-/merge_requests/` is unambiguous,
 * while `/pull/` could theoretically appear on any host.
 */
export function parsePRUrl(url: string): PRRef | null {
  if (!url) return null;

  // GitLab: https://{host}/{projectPath}/-/merge_requests/{iid}[/...]
  // Checked first — `/-/merge_requests/` is the most specific pattern.
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

  // GitHub (including GHE): https://{host}/{owner}/{repo}/pull/{number}[/...]
  const ghMatch = url.match(
    /^https?:\/\/([^/]+)\/([^/]+)\/([^/]+)\/pull\/(\d+)/,
  );
  if (ghMatch) {
    return {
      platform: "github",
      host: ghMatch[1],
      owner: ghMatch[2],
      repo: ghMatch[3],
      number: parseInt(ghMatch[4], 10),
    };
  }

  return null;
}
