/**
 * GitHub-specific PR provider implementation.
 *
 * All functions use the `gh` CLI via the PRRuntime abstraction.
 */

import type { PRRuntime, PRMetadata, PRContext, PRReviewFileComment, CommandResult } from "./pr-provider";
import { encodeApiFilePath } from "./pr-provider";

// GitHub-specific PRRef shape (used internally)
interface GhPRRef {
  platform: "github";
  owner: string;
  repo: string;
  number: number;
}

// --- Auth ---

export async function checkGhAuth(runtime: PRRuntime): Promise<void> {
  const result = await runtime.runCommand("gh", ["auth", "status"]);
  if (result.exitCode !== 0) {
    const stderr = result.stderr.trim();
    throw new Error(
      `GitHub CLI not authenticated. Run \`gh auth login\` first.\n${stderr}`,
    );
  }
}

export async function getGhUser(runtime: PRRuntime): Promise<string | null> {
  try {
    const result = await runtime.runCommand("gh", ["api", "user", "--jq", ".login"]);
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
  const repo = `${ref.owner}/${ref.repo}`;

  // Fetch diff and metadata in parallel
  const [diffResult, viewResult] = await Promise.all([
    runtime.runCommand("gh", [
      "pr", "diff", String(ref.number),
      "--repo", repo,
    ]),
    runtime.runCommand("gh", [
      "pr", "view", String(ref.number),
      "--repo", repo,
      "--json", "id,title,author,baseRefName,headRefName,baseRefOid,headRefOid,url",
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

  const metadata: PRMetadata = {
    platform: "github",
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    prNodeId: raw.id,
    title: raw.title,
    author: raw.author.login,
    baseBranch: raw.baseRefName,
    headBranch: raw.headRefName,
    baseSha: raw.baseRefOid,
    headSha: raw.headRefOid,
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
    })),
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
  const repo = `${ref.owner}/${ref.repo}`;

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
  return parseGhPRContext(raw);
}

// --- File Content ---

export async function fetchGhPRFileContent(
  runtime: PRRuntime,
  ref: GhPRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  const result = await runtime.runCommand("gh", [
    "api",
    `repos/${ref.owner}/${ref.repo}/contents/${encodeApiFilePath(filePath)}?ref=${sha}`,
    "--jq", ".content",
  ]);

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
    const args = [
      "api", "graphql",
      "-f", `query=${query}`,
      "-F", `owner=${ref.owner}`,
      "-F", `repo=${ref.repo}`,
      "-F", `number=${ref.number}`,
    ];
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
  _ref: GhPRRef,
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
        ? runtime.runCommand("gh", [
            "api", "graphql",
            "-f", `query=${mutation}`,
            "-F", `id=${prNodeId}`,
            "-F", `path=${path}`,
          ])
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
      ["api", endpoint, "--method", "POST", "--input", "-"],
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
