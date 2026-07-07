/**
 * GitHub-specific PR provider implementation.
 *
 * All functions use the `gh` CLI via the PRRuntime abstraction.
 */

import type { PRRuntime, PRMetadata, PRContext, PRReviewThread, PRThreadComment, PRReviewFileComment, CommandResult, PRStackTree, PRStackNode, PRListItem } from "./pr-types";
import { encodeApiFilePath } from "./pr-types";
import { parsePaginatedArray } from "./cli-pagination";

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

/** Shape of each entry from the GitHub pulls files API (fields we use) */
export interface GitHubFileEntry {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  patch?: string;
}

// Git only C-quotes paths containing quotes, backslashes, or control chars —
// bare spaces stay raw. Downstream parsers (our diff-paths regex branch,
// Pierre's filename regexes, code-nav's extractChangedFiles) expect git's
// exact shape; over-quoting makes them misparse or silently drop files.
function needsGitQuoting(p: string): boolean {
  return /["\\\u0000-\u001F]/.test(p);
}
function headerPathToken(side: "a" | "b", p: string): string {
  const full = `${side}/${p}`;
  return needsGitQuoting(p) ? JSON.stringify(full) : full;
}
function metadataPathToken(p: string): string {
  return needsGitQuoting(p) ? JSON.stringify(p) : p;
}

/**
 * Reconstruct a unified patch from GitHub's pulls files API response.
 *
 * Used when `gh pr diff` fails — GitHub refuses to render very large PR diffs
 * as one document (HTTP 406, "diff exceeded the maximum number of lines"), but
 * the files API still serves the same diff file-by-file. Entries without a
 * `patch` field (binary files, or single files whose own diff exceeds the
 * limit) become header-only sections — the UI still lists them and loads full
 * contents through the contents API on demand.
 */
export function reconstructGhPatch(files: GitHubFileEntry[]): string {
  const parts: string[] = [];

  for (const f of files) {
    const oldPath = f.previous_filename ?? f.filename;
    const newPath = f.filename;
    const isNew = f.status === "added";
    const isDeleted = f.status === "removed";

    let header = `diff --git ${headerPathToken("a", oldPath)} ${headerPathToken("b", newPath)}`;
    if (f.status === "renamed" || f.status === "copied") {
      // Git always prints a similarity score before rename/copy lines, and
      // diff parsers (e.g. Pierre's) key rename classification off it —
      // without the line a rename renders as a plain change with no old path.
      // The files API doesn't expose the score: a patch-less entry is by
      // definition a 100% match; for patched entries emit a synthetic <100%
      // value (consumers only branch on 100% vs not).
      header += f.patch ? "\nsimilarity index 99%" : "\nsimilarity index 100%";
      header += f.status === "renamed"
        ? `\nrename from ${metadataPathToken(oldPath)}\nrename to ${metadataPathToken(newPath)}`
        : `\ncopy from ${metadataPathToken(oldPath)}\ncopy to ${metadataPathToken(newPath)}`;
    }
    if (isNew) {
      header += "\nnew file mode 100644";
    }
    if (isDeleted) {
      header += "\ndeleted file mode 100644";
    }

    if (f.patch) {
      const aToken = isNew ? "/dev/null" : headerPathToken("a", oldPath);
      const bToken = isDeleted ? "/dev/null" : headerPathToken("b", newPath);
      const body = f.patch.endsWith("\n") ? f.patch : `${f.patch}\n`;
      parts.push(`${header}\n--- ${aToken}\n+++ ${bToken}\n${body}`);
    } else {
      parts.push(`${header}\n`);
    }
  }

  return parts.join("");
}

/**
 * True when a files-API entry should carry a patch but doesn't. Patch-less
 * renames/copies are 100%-similarity moves (complete information); patch-less
 * added/removed/modified entries mean GitHub gave up computing that file's
 * diff (on very large PRs it omits the patch AND zeroes the counts).
 *
 * Known ambiguity: when GitHub withholds content it does so across all
 * statuses, so a rename-WITH-edits whose patch was withheld is
 * indistinguishable from a pure move and renders as one. In practice such PRs
 * always have withheld non-rename entries too, so the flag (and the local
 * recompute that fixes everything) still triggers.
 */
function entryMissingContent(f: GitHubFileEntry): boolean {
  return !f.patch && f.status !== "renamed" && f.status !== "copied" && f.status !== "unchanged";
}

export async function fetchGhPR(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
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
      "--json", "id,title,author,baseRefName,headRefName,baseRefOid,headRefOid,url,changedFiles",
    ]),
    runtime.runCommand("gh", [
      "repo", "view", repo,
      "--json", "defaultBranchRef",
      "--jq", ".defaultBranchRef.name",
    ]),
  ]);

  if (viewResult.exitCode !== 0) {
    throw new Error(
      `Failed to fetch PR metadata: ${viewResult.stderr.trim() || `exit code ${viewResult.exitCode}`}`,
    );
  }

  // Resolve the patch. Primary: `gh pr diff` — one server-rendered document,
  // perfect fidelity. GitHub refuses to render it for very large PRs (406 /
  // "diff exceeded the maximum number of lines"); in that case fetch the same
  // diff file-by-file from the paginated files API and stitch it back together.
  let rawPatch: string;
  let patchIncomplete = false;
  if (diffResult.exitCode === 0) {
    rawPatch = diffResult.stdout;
  } else {
    const filesResult = await runtime.runCommand("gh", hostnameArgs(ref.host, [
      "api",
      `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/files?per_page=100`,
      "--paginate",
    ]));
    if (filesResult.exitCode !== 0) {
      const diffErr = diffResult.stderr.trim() || `exit code ${diffResult.exitCode}`;
      const filesErr = filesResult.stderr.trim() || `exit code ${filesResult.exitCode}`;
      throw new Error(`Failed to fetch PR diff (pr diff: ${diffErr}; files API: ${filesErr}).`);
    }
    const fileEntries = parsePaginatedArray<GitHubFileEntry>(filesResult.stdout);
    rawPatch = reconstructGhPatch(fileEntries);
    if (!rawPatch.trim()) {
      throw new Error(
        "PR diff is empty — it may be too large to fetch via the GitHub API. Review it on the GitHub web UI.",
      );
    }
    // The files API silently caps at 3000 files — never present a truncated
    // review as complete.
    const expectedFiles = (JSON.parse(viewResult.stdout) as { changedFiles?: number }).changedFiles;
    if (typeof expectedFiles === "number" && fileEntries.length < expectedFiles) {
      console.error(
        `Warning: PR reports ${expectedFiles} changed files but the GitHub files API returned ${fileEntries.length} (the API caps at 3000). The review is missing the remainder.`,
      );
      patchIncomplete = true;
    }
    const missingContent = fileEntries.filter(entryMissingContent).length;
    if (missingContent > 0) {
      console.error(
        `Warning: GitHub omitted diff content for ${missingContent} file(s) (PR too large). They appear in the review without hunks; the full diff can be recomputed locally once the checkout is ready.`,
      );
      patchIncomplete = true;
    }
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

  return { metadata, rawPatch, ...(patchIncomplete && { patchIncomplete }) };
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

  // Fetch inline review threads + bot author logins via GraphQL (the only place
  // GitHub exposes whether an author is a Bot vs a User — `gh pr view --json`
  // gives the login only). Non-blocking failure: degrade to no threads / no bot
  // tags rather than failing the whole context.
  try {
    const { threads, botLogins, avatarByLogin } = await fetchGhThreadsAndBots(runtime, ref);
    context.reviewThreads = threads;
    for (const c of context.comments) {
      if (botLogins.has(c.author)) c.isBot = true;
      const a = avatarByLogin.get(c.author);
      if (a) c.avatarUrl = a;
    }
    for (const r of context.reviews) {
      if (botLogins.has(r.author)) r.isBot = true;
      const a = avatarByLogin.get(r.author);
      if (a) r.avatarUrl = a;
    }
  } catch {
    context.reviewThreads = [];
  }

  return context;
}

// --- Review Threads + bot detection (GraphQL) ---

const PR_CONTEXT_GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100) { nodes { author { __typename login avatarUrl(size: 48) } } }
      reviews(first: 100) { nodes { author { __typename login avatarUrl(size: 48) } } }
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
              author { __typename login avatarUrl(size: 48) }
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

/**
 * One GraphQL round-trip returning the PR's inline review threads AND the set of
 * author logins that are bots (`__typename === "Bot"`) across comments, reviews,
 * and thread comments. GraphQL is the only place GitHub exposes author type —
 * `gh pr view --json` gives the login only. The caller uses the bot set to tag
 * the top-level comments/reviews; thread comments are tagged inline here.
 */
async function fetchGhThreadsAndBots(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<{ threads: PRReviewThread[]; botLogins: Set<string>; avatarByLogin: Map<string, string> }> {
  const result = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api", "graphql",
    "-f", `query=${PR_CONTEXT_GRAPHQL_QUERY}`,
    "-f", `owner=${ref.owner}`,
    "-f", `repo=${ref.repo}`,
    "-F", `number=${ref.number}`,
  ]));

  const empty = { threads: [] as PRReviewThread[], botLogins: new Set<string>(), avatarByLogin: new Map<string, string>() };
  if (result.exitCode !== 0) return empty;

  const data = JSON.parse(result.stdout);
  const pr = data?.data?.repository?.pullRequest;
  if (!pr) return empty;

  const botLogins = new Set<string>();
  const avatarByLogin = new Map<string, string>();
  const collect = (author: any) => {
    if (!author?.login) return;
    const login = String(author.login);
    if (author.__typename === 'Bot') botLogins.add(login);
    if (author.avatarUrl && !avatarByLogin.has(login)) avatarByLogin.set(login, String(author.avatarUrl));
  };
  for (const n of (pr.comments?.nodes ?? [])) collect(n?.author);
  for (const n of (pr.reviews?.nodes ?? [])) collect(n?.author);

  const threadNodes = pr.reviewThreads?.nodes;
  const threads: PRReviewThread[] = Array.isArray(threadNodes)
    ? threadNodes.map((t: any): PRReviewThread => ({
        id: String(t.id ?? ''),
        isResolved: t.isResolved === true,
        isOutdated: t.isOutdated === true,
        path: String(t.path ?? ''),
        line: typeof t.line === 'number' ? t.line : null,
        startLine: typeof t.startLine === 'number' ? t.startLine : null,
        diffSide: t.diffSide === 'LEFT' || t.diffSide === 'RIGHT' ? t.diffSide : null,
        comments: Array.isArray(t.comments?.nodes)
          ? t.comments.nodes.map((c: any): PRThreadComment => {
              collect(c?.author);
              return {
                id: String(c.id ?? ''),
                author: c.author?.login ? String(c.author.login) : '',
                ...(c.author?.__typename === 'Bot' ? { isBot: true } : {}),
                ...(c.author?.avatarUrl ? { avatarUrl: String(c.author.avatarUrl) } : {}),
                body: String(c.body ?? ''),
                createdAt: String(c.createdAt ?? ''),
                url: String(c.url ?? ''),
                ...(c.diffHunk ? { diffHunk: String(c.diffHunk) } : {}),
              };
            })
          : [],
      }))
    : [];

  return { threads, botLogins, avatarByLogin };
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

type StackPRNode = { number: number; title: string; url: string; baseRefName: string; headRefName: string; state: string };

function stackPRQuery(kind: "head" | "base"): string {
  const varName = kind === "head" ? "headRefName" : "baseRefName";
  const first = kind === "head" ? 5 : 10;
  return `
query($owner: String!, $repo: String!, $${varName}: String!) {
  repository(owner: $owner, name: $repo) {
    pullRequests(first: ${first}, ${varName}: $${varName}, states: [OPEN, MERGED]) {
      nodes { number title url baseRefName headRefName state }
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
      state: (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open') as PRStackNode['state'],
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
      state: (pr.state === 'MERGED' ? 'merged' : pr.state === 'CLOSED' ? 'closed' : 'open') as PRStackNode['state'],
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
