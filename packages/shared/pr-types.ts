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
  /**
   * HTTP client for platforms reached over REST rather than a CLI
   * (Bitbucket Cloud). Defaults to the global `fetch`; tests inject one.
   */
  fetch?: typeof fetch;
}

// --- Platform Types ---

export type Platform = "github" | "gitlab" | "bitbucket";

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

/** Bitbucket Cloud PR reference (`bitbucket.org/{workspace}/{repo}/pull-requests/{id}`) */
export interface BitbucketPRRef {
  platform: "bitbucket";
  host: string;
  workspace: string;
  repo: string;
  number: number;
}

/** Discriminated union — auto-detected from URL */
export type PRRef = GithubPRRef | GitlabMRRef | BitbucketPRRef;

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

/** Bitbucket Cloud PR metadata */
export interface BitbucketPRMetadata {
  platform: "bitbucket";
  host: string;
  workspace: string;
  repo: string;
  number: number;
  title: string;
  author: string;
  baseBranch: string;
  headBranch: string;
  /** Repository main branch, used to infer whether this PR targets another PR branch. */
  defaultBranch?: string;
  /** Full destination-branch tip SHA (the API's short hash, resolved). */
  baseSha: string;
  /** Full source-branch tip SHA (the API's short hash, resolved). */
  headSha: string;
  /** Merge-base SHA — Bitbucket's PR diff is a three-dot diff from here. */
  mergeBaseSha?: string;
  /**
   * `workspace/repo` of the source repository when the PR comes from a fork.
   * Absent for same-repository PRs. Bitbucket has no `refs/pull/N/head`, so a
   * local checkout fetches the source branch from this repository.
   */
  sourceRepo?: string;
  url: string;
}

/** Discriminated union — downstream gets type narrowing for free */
export type PRMetadata = GithubPRMetadata | GitlabMRMetadata | BitbucketPRMetadata;

// --- PR Context Types (platform-agnostic) ---

export interface PRComment {
  id: string;
  author: string;
  /** Author avatar image URL, when available. */
  avatarUrl?: string;
  /** True when the author is a bot/automation account. */
  isBot?: boolean;
  body: string;
  createdAt: string;
  url: string;
}

export interface PRReview {
  id: string;
  author: string;
  /** Author avatar image URL, when available. */
  avatarUrl?: string;
  /** True when the author is a bot/automation account. */
  isBot?: boolean;
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
  /** Author avatar image URL, when available. */
  avatarUrl?: string;
  /** True when the author is a bot/automation account. */
  isBot?: boolean;
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

/**
 * The review event a platform submission carries (#1611). GitHub maps these
 * to `APPROVE` / `COMMENT` / `REQUEST_CHANGES`. GitLab has no request-changes
 * review, so it posts `request_changes` exactly like `comment` (a note plus
 * discussions); only `approve` adds a mutation there.
 */
export type PRReviewAction = "approve" | "comment" | "request_changes";

/** Read the untrusted `action` field of a review request; null when invalid. */
export function parsePRReviewAction(value: unknown): PRReviewAction | null {
  return value === "approve" || value === "comment" || value === "request_changes" ? value : null;
}

/**
 * A comment on a whole file rather than a line (#1599). GitHub posts it as a
 * file-level review thread; GitLab has no equivalent and folds it into the body.
 */
export interface PRReviewFileLevelComment {
  path: string;
  body: string;
}

/**
 * Read the untrusted `fileLevelComments` field of a review request. Keeps only
 * entries with a non-empty string path and body; anything else is dropped.
 */
export function parseFileLevelComments(value: unknown): PRReviewFileLevelComment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): PRReviewFileLevelComment[] => {
    if (typeof item !== "object" || item === null) return [];
    const { path, body } = item as Record<string, unknown>;
    return typeof path === "string" && path.length > 0 && typeof body === "string" && body.trim().length > 0
      ? [{ path, body }]
      : [];
  });
}

/** One inline comment that GitLab did not accept, paired with its safe error text. */
export interface PRReviewCommentFailure {
  comment: PRReviewFileComment;
  error: string;
}

/**
 * Exact mutation that is safe after a partial platform submission.
 *
 * The review body is absent unless the platform reports it was NOT posted
 * (`body`, Bitbucket only: the general comment goes after the inline ones, so
 * inline comments can land while the general comment fails).
 */
export interface PRReviewRetry {
  /**
   * `approve` / `request_changes` when the decision mutation itself failed
   * (GitLab approve, Bitbucket approve or request-changes); `comment` when only
   * inline comments (and possibly the unposted general comment) remain.
   */
  action: PRReviewAction;
  fileComments: PRReviewFileComment[];
  /** The general comment that still has to be posted (never one already posted). */
  body?: string;
}

/** A platform review for which every requested mutation completed. */
export interface PRReviewSubmissionComplete {
  status: "complete";
}

/**
 * A GitLab review that mutated the MR but did not complete every requested
 * mutation. Callers must use `retry` instead of replaying the original review.
 */
export interface PRReviewSubmissionPartial {
  status: "partial";
  postedFileCommentCount: number;
  failedFileComments: PRReviewCommentFailure[];
  reviewBodyPosted: boolean;
  /** Outcome of the decision mutation (approve, or Bitbucket's request-changes). */
  approval: "not-requested" | "succeeded" | "failed";
  approvalError?: string;
  /** Why the general comment failed (Bitbucket; `retry.body` then carries it). */
  reviewBodyError?: string;
  recoveryFile?: string;
  retry: PRReviewRetry;
}

/** Caller-visible result of posting a review to GitHub or GitLab. */
export type PRReviewSubmissionResult =
  | PRReviewSubmissionComplete
  | PRReviewSubmissionPartial;

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

// --- Platform Capabilities ---

/**
 * What one PR platform supports. The review UI reads this instead of
 * branching on platform names, so a platform that lacks a feature has it
 * hidden rather than failing (#1583). Server dispatch lives in pr-provider.ts.
 */
export interface PRPlatformCapabilities {
  /** Human label: "GitHub", "GitLab", "Bitbucket". */
  label: string;
  /** "PR" or "MR". */
  changeLabel: "PR" | "MR";
  /** Prefix of the change number in labels: "#" or "!". */
  numberPrefix: "#" | "!";
  /**
   * The platform records a real request-changes decision (#1611). GitHub:
   * REQUEST_CHANGES review; Bitbucket: `POST /request-changes`. GitLab has
   * none, so `request_changes` posts exactly like `comment` there.
   */
  requestChanges: boolean;
  /** The platform refuses approve / request-changes from the PR author. */
  selfReviewBlocked: boolean;
  /** File-scoped comments post as file-level threads (else folded into the body). */
  fileLevelComments: boolean;
  /** Per-file "viewed" state syncs to the platform. */
  viewedSync: boolean;
  /**
   * The PR Artifacts panel (attachments from the PR description and
   * comments) is offered. Off where hosted attachments cannot be fetched.
   */
  artifacts: boolean;
  /** A COMMENT / REQUEST_CHANGES review needs a non-empty body (GitHub). */
  reviewBodyRequired: boolean;
  /**
   * Agent jobs can read the PR through a CLI they are allowed to run (gh /
   * glab). When false, agent prompts carry the diff inline instead of relying
   * on the PR URL.
   */
  agentCliAccess: boolean;
  /** CLI the platform is reached through, or null for a REST-only platform. */
  cli: { name: string; installUrl: string } | null;
}

const PLATFORM_CAPABILITIES: Record<Platform, PRPlatformCapabilities> = {
  github: {
    label: "GitHub",
    changeLabel: "PR",
    numberPrefix: "#",
    requestChanges: true,
    selfReviewBlocked: true,
    fileLevelComments: true,
    viewedSync: true,
    artifacts: true,
    reviewBodyRequired: true,
    agentCliAccess: true,
    cli: { name: "gh", installUrl: "https://cli.github.com" },
  },
  gitlab: {
    label: "GitLab",
    changeLabel: "MR",
    numberPrefix: "!",
    requestChanges: false,
    selfReviewBlocked: true,
    fileLevelComments: false,
    viewedSync: false,
    artifacts: true,
    reviewBodyRequired: false,
    agentCliAccess: true,
    cli: { name: "glab", installUrl: "https://gitlab.com/gitlab-org/cli" },
  },
  bitbucket: {
    label: "Bitbucket",
    changeLabel: "PR",
    numberPrefix: "#",
    requestChanges: true,
    // Bitbucket Cloud lets an author approve their own PR (the approval just
    // does not count toward merge checks), so nothing is muted.
    selfReviewBlocked: false,
    // Bitbucket supports file comments, but posting them one by one outside the
    // partial-retry contract is not worth the risk yet: they fold into the body.
    fileLevelComments: false,
    viewedSync: false,
    // Bitbucket-hosted attachments need the API token, which the artifact
    // fetch path does not carry: no artifacts panel yet.
    artifacts: false,
    reviewBodyRequired: false,
    agentCliAccess: false,
    cli: null,
  },
};

// --- Label Helpers ---
// Accept either PRRef or PRMetadata (both have `platform` discriminant)

type HasPlatform = PRRef | PRMetadata | { platform: Platform };

/** Capabilities of the platform a ref or metadata belongs to. */
export function getPRPlatformCapabilities(m: HasPlatform): PRPlatformCapabilities {
  return PLATFORM_CAPABILITIES[m.platform] ?? PLATFORM_CAPABILITIES.github;
}

/** "GitHub", "GitLab" or "Bitbucket" */
export function getPlatformLabel(m: HasPlatform): string {
  return getPRPlatformCapabilities(m).label;
}

/** "PR" or "MR" */
export function getMRLabel(m: HasPlatform): string {
  return getPRPlatformCapabilities(m).changeLabel;
}

/** The PR/MR number (GitLab's `iid`). */
export function getPRNumber(m: PRRef | PRMetadata): number {
  return m.platform === "gitlab" ? m.iid : m.number;
}

/** "#123" or "!42" */
export function getMRNumberLabel(m: PRRef | PRMetadata): string {
  return `${getPRPlatformCapabilities(m).numberPrefix}${getPRNumber(m)}`;
}

/** "owner/repo", "group/project" or "workspace/repo" */
export function getDisplayRepo(m: PRRef | PRMetadata): string {
  if (m.platform === "github") return `${m.owner}/${m.repo}`;
  if (m.platform === "bitbucket") return `${m.workspace}/${m.repo}`;
  return m.projectPath;
}

/** Reconstruct a PRRef from metadata */
export function prRefFromMetadata(m: PRMetadata): PRRef {
  if (m.platform === "github") {
    return { platform: "github", host: m.host, owner: m.owner, repo: m.repo, number: m.number };
  }
  if (m.platform === "bitbucket") {
    return { platform: "bitbucket", host: m.host, workspace: m.workspace, repo: m.repo, number: m.number };
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
  if (a.platform === "bitbucket" && b.platform === "bitbucket") {
    // Bitbucket workspace and repository slugs are case-insensitive.
    return a.host === b.host
      && a.workspace.toLowerCase() === b.workspace.toLowerCase()
      && a.repo.toLowerCase() === b.repo.toLowerCase();
  }
  return false;
}

/** CLI tool name for the platform ("" for a REST-only platform such as Bitbucket). */
export function getCliName(ref: PRRef): string {
  return getPRPlatformCapabilities(ref).cli?.name ?? "";
}

/** Install URL for the platform CLI ("" for a REST-only platform). */
export function getCliInstallUrl(ref: PRRef): string {
  return getPRPlatformCapabilities(ref).cli?.installUrl ?? "";
}

/**
 * Where a local checkout fetches the PR head from. GitHub and GitLab publish
 * the head as a ref on the base repository; Bitbucket has no such ref, so the
 * source branch is fetched — from the fork when the PR comes from one.
 * `remote` null means the base repository's `origin`.
 */
export function getPRHeadFetchSpec(m: PRMetadata): { remote: string | null; ref: string } {
  if (m.platform === "github") return { remote: null, ref: `refs/pull/${m.number}/head` };
  if (m.platform === "gitlab") return { remote: null, ref: `refs/merge-requests/${m.iid}/head` };
  if (m.headBranch.startsWith("-") || m.headBranch.includes("..")) {
    throw new Error(`Invalid source branch: ${m.headBranch}`);
  }
  const ref = `refs/heads/${m.headBranch}`;
  if (m.sourceRepo && m.sourceRepo.toLowerCase() !== `${m.workspace}/${m.repo}`.toLowerCase()) {
    return { remote: `https://${m.host}/${m.sourceRepo}.git`, ref };
  }
  return { remote: null, ref };
}

/**
 * Command that clones the PR's base repository shallowly without a checkout
 * (the cross-repo `--local` path). `env` holds overrides to merge over the
 * process environment, or is absent when none are needed.
 */
export function getPRCloneCommand(
  m: PRMetadata,
  dest: string,
): { argv: string[]; env?: Record<string, string> } {
  if (m.platform === "bitbucket") {
    // Plain git: Bitbucket has no gh-like CLI. The user's own git credentials
    // (credential helper) authenticate private repositories; the API token is
    // never put on a command line. No terminal prompt: this runs in the
    // background.
    return {
      argv: ["git", "clone", "--depth=1", "--no-checkout", "--", `https://${m.host}/${m.workspace}/${m.repo}.git`, dest],
      env: { GIT_TERMINAL_PROMPT: "0" },
    };
  }
  const cli = m.platform === "github" ? "gh" : "glab";
  // gh/glab repo clone doesn't accept --hostname; set GH_HOST/GITLAB_HOST env instead
  const isDefaultHost = m.host === "github.com" || m.host === "gitlab.com";
  return {
    argv: [cli, "repo", "clone", getDisplayRepo(m), dest, "--", "--depth=1", "--no-checkout"],
    ...(isDefaultHost ? {} : { env: m.platform === "github" ? { GH_HOST: m.host } : { GITLAB_HOST: m.host } }),
  };
}

/**
 * One side of a PR file as raw bytes (code-review image preview). Transport
 * failures other than "not found" throw, so the endpoint can answer 502.
 */
export type PRFileBytesResult =
  | { kind: "ok"; bytes: Uint8Array; etag?: string }
  | { kind: "missing" }
  | { kind: "too-large"; size: number };

/** Decode a platform API base64 payload (GitHub wraps it at 60 columns). */
export function decodeBase64Bytes(value: string): Uint8Array {
  const clean = value.replace(/\s+/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

/**
 * True when a gh/glab failure is the API's "no such file at this ref" (HTTP
 * 404). A missing CLI ("gh: command not found") is a transport failure, not a
 * missing file, so only the status code counts.
 */
export function isNotFoundCommandFailure(stderr: string): boolean {
  return /\bHTTP 404\b|\b404 Not Found\b/i.test(stderr);
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
 * - Bitbucket Cloud: https://bitbucket.org/workspace/repo/pull-requests/7[/diff|/overview]
 *
 * GitLab is checked first because `/-/merge_requests/` is unambiguous,
 * while `/pull/` could theoretically appear on any host. Bitbucket is matched
 * only on bitbucket.org (Bitbucket Data Center uses a different URL shape
 * and API, and is not supported).
 */
export function parsePRUrl(url: string): PRRef | null {
  if (!url) return null;

  // Bitbucket Cloud: https://bitbucket.org/{workspace}/{repo}/pull-requests/{id}[/...]
  const bbMatch = url.match(
    /^https?:\/\/(?:www\.)?bitbucket\.org\/([^/?#]+)\/([^/?#]+)\/pull-requests\/(\d+)(?:[/?#]|$)/i,
  );
  if (bbMatch) {
    return {
      platform: "bitbucket",
      host: "bitbucket.org",
      workspace: bbMatch[1],
      repo: bbMatch[2],
      number: parseInt(bbMatch[3], 10),
    };
  }

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
