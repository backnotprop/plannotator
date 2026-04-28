/**
 * GitHub-specific PR provider implementation.
 *
 * All functions use the `gh` CLI via the PRRuntime abstraction.
 */

import type { PRRuntime, PRMetadata, PRContext, PRReviewThread, PRThreadComment, PRReviewFileComment, CommandResult, PRStackTree, PRStackNode, PRListItem } from "./pr-provider";
import { encodeApiFilePath } from "./pr-provider";

// GitHub-specific PRRef shape (used internally)
interface GhPRRef {
  platform: "github";
  host: string;
  owner: string;
  repo: string;
  number: number;
}

/** Build the --repo flag value: HOST/OWNER/REPO for GHE, OWNER/REPO for github.com */
function repoFlag(ref: GhPRRef): string {
  if (ref.host !== "github.com") {
    return `${ref.host}/${ref.owner}/${ref.repo}`;
  }
  return `${ref.owner}/${ref.repo}`;
}

/** Append --hostname to args for gh api / gh auth on GHE */
function hostnameArgs(host: string, args: string[]): string[] {
  if (host !== "github.com") {
    return [...args, "--hostname", host];
  }
  return args;
}

// --- Auth ---

export async function checkGhAuth(runtime: PRRuntime, host: string): Promise<void> {
  const result = await runtime.runCommand("gh", hostnameArgs(host, ["auth", "status"]));
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    const hostHint = host !== "github.com" ? ` --hostname ${host}` : "";
    throw new Error(
      `GitHub CLI not authenticated. Run \`gh auth login${hostHint}\` first.\n${stderr}`,
    );
  }
}

export async function getGhUser(runtime: PRRuntime, host: string): Promise<string | null> {
  try {
    const result = await runtime.runCommand("gh", hostnameArgs(host, ["api", "user", "--jq", ".login"]));
    if (result.exitCode === 0 && result.stdout.trim()) {
      return result.stdout.trim();
    }
    return null;
  } catch {
    return null;
  }
}

// --- Fetch PR ---

export async function fetchGhPR(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string }> {
  const repo = repoFlag(ref);

  // Fetch diff, metadata, and repository defaults in parallel.
  const [diffResult, viewResult, repoResult] = await Promise.all([
    runtime.runCommand("gh", [
      "pr", "diff", String(ref.number),
      "--repo", repo,
    ]),
    runtime.runCommand("gh", [
      "pr", "view", String(ref.number),
      "--repo", repo,
      "--json", "id,title,author,baseRefName,headRefName,baseRefOid,headRefOid,url",
    ]),
    runtime.runCommand("gh", [
      "repo", "view", repo,
      "--json", "defaultBranchRef",
      "--jq", ".defaultBranchRef.name",
    ]),
  ]);

  if (diffResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR diff: ${diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`}`,
    );
  }

  if (viewResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR metadata: ${viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`}`,
    );
  }

  const raw = JSON.parse(viewResult.stdout) as {
    id: string;
    title: string;
    author: { login: string };
    baseRefName: string;
    headRefName: string;
    baseRefOid: string;
    headRefOid: string;
    url: string;
  };

  // Fetch the merge-base SHA — the common ancestor commit GitHub uses to compute the PR diff.
  // baseSha (baseRefOid) is the tip of the base branch, which may have moved since the branch point.
  // File contents must be fetched at the merge-base to match the diff hunks.
  let mergeBaseSha: string | undefined;
  try {
    const compareResult = await runtime.runCommand("gh", hostnameArgs(ref.host, [
      "api",
      `repos/${ref.owner}/${ref.repo}/compare/${raw.baseRefOid}...${raw.headRefOid}`,
      "--jq", ".merge_base_commit.sha",
    ]));
    if (compareResult.exitCode === 0 && compareResult.stdout.trim()) {
      mergeBaseSha = compareResult.stdout.trim();
    }
  } catch { /* fallback to baseSha if compare API fails */ }

  const metadata: PRMetadata = {
    platform: "github",
    host: ref.host,
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    prNodeId: raw.id,
    title: raw.title,
    author: raw.author.login,
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    defaultBranch: repoResult.exitCode === 0 && repoResult.stdout.trim() && repoResult.stdout.trim() !== "null"
      ? repoResult.stdout.trim()
      : undefined,
    baseSha: raw.baseRefOid,
    headSha: raw.headRefOid,
    mergeBaseSha,
    url: raw.url,
  };

  return { metadata, rawPatch: diffResult.stdout };
}

// --- PR Context ---

const GH_CONTEXT_FIELDS = [
  "body", "state", "isDraft", "labels",
  "comments", "reviews", "reviewDecision",
  "mergeable", "mergeStateStatus",
  "statusCheckRollup", "closingIssuesReferences",
].join(",");

function parseGhPRContext(raw: Record<string, unknown>): PRContext {
  const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const login = (v: unknown): string =>
    typeof v === "object" && v !== null && "login" in v
      ? String((v as { login: unknown }).login || "")
      : "";

  return {
    body: str(raw.body),
    state: str(raw.state),
    isDraft: raw.isDraft === true,
    labels: arr(raw.labels).map((l: any) => ({
      name: str(l?.name),
      color: str(l?.color),
    })),
    reviewDecision: str(raw.reviewDecision),
    mergeable: str(raw.mergeable),
    mergeStateStatus: str(raw.mergeStateStatus),
    comments: arr(raw.comments).map((c: any) => ({
      id: str(c?.id),
      author: login(c?.author),
      body: str(c?.body),
      createdAt: str(c?.createdAt),
      url: str(c?.url),
    })),
    reviews: arr(raw.reviews).map((r: any) => ({
      id: str(r?.id),
      author: login(r?.author),
      state: str(r?.state),
      body: str(r?.body),
      submittedAt: str(r?.submittedAt),
      ...(r?.url ? { url: str(r.url) } : {}),
    })),
    reviewThreads: [],  // populated via GraphQL after initial fetch
    checks: arr(raw.statusCheckRollup).map((c: any) => ({
      name: str(c?.name),
      status: str(c?.status),
      conclusion: typeof c?.conclusion === "string" ? c.conclusion : null,
      workflowName: str(c?.workflowName),
      detailsUrl: str(c?.detailsUrl),
    })),
    linkedIssues: arr(raw.closingIssuesReferences).map((i: any) => ({
      number: typeof i?.number === "number" ? i.number : 0,
      url: str(i?.url),
      repo: i?.repository
        ? `${login(i.repository.owner)}/${str(i.repository.name)}`
        : "",
    })),
  };
}

export async function fetchGhPRContext(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<PRContext> {
  const repo = repoFlag(ref);

  const result = await runtime.runCommand("gh", [
    "pr", "view", String(ref.number),
    "--repo", repo,
    "--json", GH_CONTEXT_FIELDS,
  ]);

  if (result.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR context: ${result.stderr.trim() || `exit code ${result.exitCode}`}`,
    );
  }

  const raw = JSON.parse(result.stdout) as Record<string, unknown>;
  const context = parseGhPRContext(raw);

  // Fetch inline review threads via GraphQL (parallel-safe, non-blocking failure)
  try {
    context.reviewThreads = await fetchGhReviewThreads(runtime, ref);
  } catch {
    // GraphQL may not be available or may fail — degrade gracefully
    context.reviewThreads = [];
  }

  return context;
}

// --- Review Threads (GraphQL) ---

const REVIEW_THREADS_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) {
        nodes {
          id
          isResolved
          isOutdated
          line
          startLine
          path
          diffSide
          comments(first: 50) {
            nodes {
              id
              body
              author { login }
              createdAt
              url
              diffHunk
            }
          }
        }
      }
    }
  }
}`;

async function fetchGhReviewThreads(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<PRReviewThread[]> {
  const result = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api", "graphql",
    "-f", `query=${REVIEW_THREADS_QUERY}`,
    "-f", `owner=${ref.owner}`,
    "-f", `repo=${ref.repo}`,
    "-F", `number=${ref.number}`,
  ]));

  if (result.exitCode !== 0) return [];

  const data = JSON.parse(result.stdout);
  const threads = data?.data?.repository?.pullRequest?.reviewThreads?.nodes;
  if (!Array.isArray(threads)) return [];

  return threads.map((t: any): PRReviewThread => ({
    id: String(t.id ?? ''),
    isResolved: t.isResolved === true,
    isOutdated: t.isOutdated === true,
    path: String(t.path ?? ''),
    line: typeof t.line === 'number' ? t.line : null,
    startLine: typeof t.startLine === 'number' ? t.startLine : null,
    diffSide: t.diffSide === 'LEFT' || t.diffSide === 'RIGHT' ? t.diffSide : null,
    comments: Array.isArray(t.comments?.nodes)
      ? t.comments.nodes.map((c: any): PRThreadComment => ({
          id: String(c.id ?? ''),
          author: c.author?.login ? String(c.author.login) : '',
          body: String(c.body ?? ''),
          createdAt: String(c.createdAt ?? ''),
          url: String(c.url ?? ''),
          ...(c.diffHunk ? { diffHunk: String(c.diffHunk) } : {}),
        }))
      : [],
  }));
}

// --- File Content ---

export async function fetchGhPRFileContent(
  runtime: PRRuntime,
  ref: GhPRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const result = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api",
    `repos/${ref.owner}/${ref.repo}/contents/${encodeApiFilePath(filePath)}?ref=${sha}`,
    "--jq", ".content",
  ]));

  if (result.exitCode !== 0) return null;

  const base64Content = result.stdout.trim();
  if (!base64Content) return null;

  // GitHub returns base64-encoded content with newlines
  const cleaned = base64Content.replace(/\n/g, "");
  try {
    return Buffer.from(cleaned, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

// --- Viewed Files ---

/**
 * Fetch the per-file "viewed" state for a GitHub PR via GraphQL.
 * Returns a map of { filePath: isViewed } where isViewed is true for
 * VIEWED or DISMISSED states (i.e., the file was reviewed but may need
 * re-review after new commits).
 */
export async function fetchGhPRViewedFiles(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<Record<string, boolean>> {
  const query = `
    query($owner: String!, $repo: String!, $number: Int!, $cursor: String) {
      repository(owner: $owner, name: $repo) {
        pullRequest(number: $number) {
          files(first: 100, after: $cursor) {
            nodes {
              path
              viewerViewedState
            }
            pageInfo {
              hasNextPage
              endCursor
            }
          }
        }
      }
    }
  `;

  const result: Record<string, boolean> = {};
  let cursor: string | null = null;

  // Paginate through all files (GitHub returns max 100 per page)
  do {
    const args = hostnameArgs(ref.host, [
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${ref.owner}`,
      "-F", `repo=${ref.repo}`,
      "-F", `number=${ref.number}`,
    ]);
    if (cursor) {
      args.push("-F", `cursor=${cursor}`);
    }

    const res = await runtime.runCommand("gh", args);
    if (res.exitCode !== 0) {
      throw new Error(
        `Failed to fetch PR viewed files: ${res.stderr.trim() || `exit code ${res.exitCode}`}`,
      );
    }

    const data = JSON.parse(res.stdout) as {
      data?: {
        repository?: {
          pullRequest?: {
            files?: {
              nodes: Array<{ path: string; viewerViewedState: string }>;
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
            };
          };
        };
      };
      errors?: Array<{ message: string }>;
    };

    if (data.errors?.length) {
      throw new Error(`GraphQL error: ${data.errors[0].message}`);
    }

    const files = data.data?.repository?.pullRequest?.files;
    if (!files) break;

    for (const node of files.nodes) {
      // VIEWED = explicitly marked as viewed
      // DISMISSED = was viewed but new commits arrived (still "was reviewed")
      result[node.path] = node.viewerViewedState === "VIEWED" || node.viewerViewedState === "DISMISSED";
    }

    cursor = files.pageInfo.hasNextPage ? files.pageInfo.endCursor : null;
  } while (cursor !== null);

  return result;
}

/**
 * Mark or unmark a set of files as viewed in a GitHub PR via GraphQL mutations.
 * Uses Promise.allSettled so a single file failure doesn't block the rest.
 * Throws only if ALL mutations fail.
 */
export async function markGhFilesViewed(
  runtime: PRRuntime,
  ref: GhPRRef,
  prNodeId: string,
  filePaths: string[],
  viewed: boolean,
): Promise<void> {
  if (filePaths.length === 0) return;

  const mutationName = viewed ? "markFileAsViewed" : "unmarkFileAsViewed";
  const mutation = `
    mutation($id: ID!, $path: String!) {
      ${mutationName}(input: { pullRequestId: $id, path: $path }) {
        clientMutationId
      }
    }
  `;

  const results = await Promise.allSettled(
    filePaths.map((path) =>
      runtime.runCommandWithInput
        ? runtime.runCommand("gh", hostnameArgs(ref.host, [
            "api", "graphql",
            "-f", `query=${mutation}`,
            "-F", `id=${prNodeId}`,
            "-F", `path=${path}`,
          ]))
        : Promise.reject(new Error("Runtime does not support commands")),
    ),
  );

  const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
  if (failures.length === filePaths.length) {
    throw new Error(
      `Failed to ${mutationName} all files: ${failures[0].reason}`,
    );
  }
}

// --- Submit PR Review ---

export async function submitGhPRReview(
  runtime: PRRuntime,
  ref: GhPRRef,
  headSha: string,
  action: "approve" | "comment",
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<void> {
  const payload = JSON.stringify({
    commit_id: headSha,
    body,
    event: action === "approve" ? "APPROVE" : "COMMENT",
    comments: fileComments,
  });

  const endpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`;

  let result: CommandResult;

  if (runtime.runCommandWithInput) {
    result = await runtime.runCommandWithInput(
      "gh",
      hostnameArgs(ref.host, ["api", endpoint, "--method", "POST", "--input", "-"]),
      payload,
    );
  } else {
    throw new Error("Runtime does not support stdin input; cannot submit PR review");
  }

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || `exit code ${result.exitCode}`;
    throw new Error(`Failed to submit PR review: ${message}`);
  }
}

// --- Stack Tree (GraphQL) ---

type StackPRNode = { number: number; title: string; url: string; baseRefName: string; headRefName: string };

function stackPRQuery(kind: "head" | "base"): string {
  const varName = kind === "head" ? "headRefName" : "baseRefName";
  const first = kind === "head" ? 5 : 10;
  return `
query($owner: String!, $repo: String!, $${varName}: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: ${first}, ${varName}: $${varName}, states: [OPEN, MERGED]) {
      nodes { number title url baseRefName headRefName }
    }
  }
}`;
}

async function queryPRsByRef(
  runtime: PRRuntime,
  ref: GhPRRef,
  kind: "head" | "base",
  refName: string,
): Promise<StackPRNode[]> {
  const varName = kind === "head" ? "headRefName" : "baseRefName";
  const result = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api", "graphql",
    "-f", `query=${stackPRQuery(kind)}`,
    "-f", `owner=${ref.owner}`,
    "-f", `repo=${ref.repo}`,
    "-f", `${varName}=${refName}`,
  ]));
  if (result.exitCode !== 0) return [];
  const data = JSON.parse(result.stdout);
  const prs = data?.data?.repository?.pullRequests?.nodes;
  return Array.isArray(prs) ? prs : [];
}

/**
 * Walk up and down the PR stack from the current PR, resolving
 * PR numbers/titles for every node in the chain.
 *
 * Up: walk from currentPR.baseBranch → defaultBranch (ancestors)
 * Down: walk from currentPR.headBranch → leaf PRs (descendants)
 */
export async function fetchGhPRStack(
  runtime: PRRuntime,
  ref: GhPRRef,
  metadata: PRMetadata,
): Promise<PRStackTree | null> {
  if (metadata.platform !== "github") return null;
  const defaultBranch = metadata.defaultBranch;
  if (!defaultBranch) return null;

  const currentNode: PRStackNode = {
    branch: metadata.headBranch,
    number: metadata.number,
    title: metadata.title,
    url: metadata.url,
    isCurrent: true,
    isDefaultBranch: false,
  };

  // Walk up: find the PR whose headRefName === baseBranch, repeat
  const ancestors: PRStackNode[] = [];
  let nextHead = metadata.baseBranch;
  const maxDepth = 10;

  for (let i = 0; i < maxDepth; i++) {
    if (nextHead === defaultBranch) break;

    const prs = await queryPRsByRef(runtime, ref, "head", nextHead);
    if (prs.length === 0) {
      ancestors.push({ branch: nextHead, isCurrent: false, isDefaultBranch: false });
      break;
    }

    const pr = prs[0];
    ancestors.push({
      branch: pr.headRefName,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isCurrent: false,
      isDefaultBranch: false,
    });
    nextHead = pr.baseRefName;
  }

  // Walk down: find PRs whose baseRefName === current headBranch, repeat
  const descendants: PRStackNode[] = [];
  let nextBase = metadata.headBranch;

  for (let i = 0; i < maxDepth; i++) {
    const prs = await queryPRsByRef(runtime, ref, "base", nextBase);
    if (prs.length === 0) break;

    const pr = prs[0];
    descendants.push({
      branch: pr.headRefName,
      number: pr.number,
      title: pr.title,
      url: pr.url,
      isCurrent: false,
      isDefaultBranch: false,
    });
    nextBase = pr.headRefName;
  }

  // Build tree: defaultBranch → ancestors (reversed) → current → descendants
  const nodes: PRStackNode[] = [
    { branch: defaultBranch, isCurrent: false, isDefaultBranch: true },
    ...ancestors.reverse(),
    currentNode,
    ...descendants,
  ];

  return { nodes };
}

// --- PR List ---

export async function fetchGhPRList(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<PRListItem[]> {
  const result = await runtime.runCommand("gh", [
    "pr", "list",
    "--repo", repoFlag(ref),
    "--json", "number,title,author,url,baseRefName,state",
    "--limit", "30",
    "--state", "all",
  ]);

  if (result.exitCode !== 0) return [];

  const raw = JSON.parse(result.stdout) as Array<{
    number: number;
    title: string;
    author: { login: string };
    url: string;
    baseRefName: string;
    state: string;
  }>;

  return raw.map((pr) => ({
    id: String(pr.number),
    number: pr.number,
    title: pr.title,
    author: pr.author.login,
    url: pr.url,
    baseBranch: pr.baseRefName,
    state: (pr.state === "OPEN" ? "open" : pr.state === "MERGED" ? "merged" : "closed") as PRListItem["state"],
  }));
}
