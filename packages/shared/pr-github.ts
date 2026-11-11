import type { PRRuntime, PRMetadata, PRContext, PRRequestedReviewer, PRReviewThread, PRThreadComment, PRReviewFileComment, PRReviewFileLevelComment, PRReviewAction, PRReviewSubmissionResult, CommandResult, PRStackTree, PRStackNode, PRListItem } from "./pr-types";
import { decodeBase64Bytes, encodeApiFilePath, isNotFoundCommandFailure, type PRFileBytesResult, type PRTreeResult } from "./pr-types";
import { parsePaginatedArray } from "./cli-pagination";
import { listGhAccounts } from "./pr-github-account";
import { isAccessRefusal, markedCommentText, PRMarkedForbiddenError, PRMarkedRaceError, spliceMarkedSection, startsWithMarker, type PRMarkedCommentInput, type PRMarkedResult, type PRMarkedSectionInput } from "./pr-marked";

interface GhPRRef {
  platform: "github";
  host: string;
  owner: string;
  repo: string;
  number: number;
}

function repoFlag(ref: GhPRRef): string {
  if (ref.host !== "github.com") {
    return `${ref.host}/${ref.owner}/${ref.repo}`;
  }
  return `${ref.owner}/${ref.repo}`;
}

function hostnameArgs(host: string, args: string[]): string[] {
  if (host !== "github.com") {
    return [...args, "--hostname", host];
  }
  return args;
}

/** gh is signed in on `host`; which account the review runs as is `ensureGhPRAccess`'s call. Plain `gh auth status` exits 1 when ANY account on the host is broken, so ask about the active account (`--active`), and on failure go on if some account on the host is usable. */
export async function checkGhAuth(runtime: PRRuntime, host: string): Promise<void> {
  const active = await runtime.runCommand("gh", ["auth", "status", "--active", "--hostname", host]);
  if (active.exitCode === 0) return;
  const accounts = await listGhAccounts(runtime, host);
  if (accounts.some((a) => a.state === "success")) return;
  const result = /unknown flag/i.test(active.stderr)
    ? await runtime.runCommand("gh", hostnameArgs(host, ["auth", "status"]))
    : active;
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

export interface GitHubFileEntry {
  filename: string;
  previous_filename?: string;
  status: "added" | "removed" | "modified" | "renamed" | "copied" | "changed" | "unchanged";
  patch?: string;
}

// Git C-quotes only paths with quotes, backslashes or control chars; bare spaces stay raw. Over-quoting makes downstream parsers misparse or drop files.
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

/** Reconstructs a unified patch from the files API when `gh pr diff` fails (HTTP 406 on very large diffs). Entries without a `patch` become header-only sections. */
export function reconstructGhPatch(files: GitHubFileEntry[]): string {
  const parts: string[] = [];

  for (const f of files) {
    const oldPath = f.previous_filename ?? f.filename;
    const newPath = f.filename;
    const isNew = f.status === "added";
    const isDeleted = f.status === "removed";

    let header = `diff --git ${headerPathToken("a", oldPath)} ${headerPathToken("b", newPath)}`;
    if (f.status === "renamed" || f.status === "copied") {
      // Diff parsers key rename classification off the similarity line. The files API gives no score: a patch-less entry is a 100% match; patched entries get a synthetic <100% (consumers only branch on 100% or not).
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
export function entryMissingContent(f: GitHubFileEntry): boolean {
  return !f.patch && f.status !== "renamed" && f.status !== "copied" && f.status !== "unchanged";
}

export async function fetchGhPR(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
  const repo = repoFlag(ref);

  const [diffResult, viewResult, repoResult] = await Promise.all([
    runtime.runCommand("gh", [
      "pr", "diff", String(ref.number),
      "--repo", repo,
      // `auto` is the default, but CLICOLOR_FORCE / GH_FORCE_TTY in the user's environment would still color it.
      "--color=never",
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

  // Primary: `gh pr diff`. GitHub refuses very large PRs (406), so fall back to stitching the diff from the paginated files API.
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

  // Merge-base SHA: baseSha is the base branch tip, which may have moved since the branch point; file contents must be fetched at the merge-base to match the diff hunks.
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
    // A commit status (not a check run) has `context`, `state` and `targetUrl` in their place.
    checks: arr(raw.statusCheckRollup).map((c: any) => ({
      name: str(c?.name) || str(c?.context),
      status: str(c?.status) || (typeof c?.state === "string" ? (c.state === "PENDING" || c.state === "EXPECTED" ? "IN_PROGRESS" : "COMPLETED") : ""),
      conclusion: typeof c?.conclusion === "string" ? c.conclusion : typeof c?.state === "string" && c.state !== "PENDING" && c.state !== "EXPECTED" ? c.state : null,
      workflowName: str(c?.workflowName),
      detailsUrl: str(c?.detailsUrl) || str(c?.targetUrl),
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

  // GraphQL is the only place GitHub exposes whether an author is a Bot. A failure degrades to no threads or bot tags rather than failing the whole context.
  try {
    const { threads, botLogins, avatarByLogin, complete } = await fetchGhThreadsAndBots(runtime, ref);
    context.reviewThreads = threads;
    if (!complete) context.threadsIncomplete = true;
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
    context.threadsIncomplete = true;
  }

  return context;
}

const PR_THREAD_COMMENT_FIELDS = `id
              body
              author { __typename login avatarUrl(size: 48) }
              createdAt
              url
              diffHunk
              isMinimized
              minimizedReason`;

const PR_CONTEXT_GRAPHQL_QUERY = `
query($owner: String!, $repo: String!, $number: Int!, $withComments: Boolean = true, $withReviews: Boolean = true, $withThreads: Boolean = true, $commentsAfter: String, $reviewsAfter: String, $threadsAfter: String) {
  repository(owner: $owner, name: $repo) {
    pullRequest(number: $number) {
      comments(first: 100, after: $commentsAfter) @include(if: $withComments) { pageInfo { hasNextPage endCursor } nodes { author { __typename login avatarUrl(size: 48) } } }
      reviews(first: 100, after: $reviewsAfter) @include(if: $withReviews) { pageInfo { hasNextPage endCursor } nodes { author { __typename login avatarUrl(size: 48) } } }
      reviewThreads(first: 100, after: $threadsAfter) @include(if: $withThreads) {
        pageInfo { hasNextPage endCursor }
        nodes {
          id
          isResolved
          isOutdated
          line
          startLine
          path
          diffSide
          startDiffSide
          comments(first: 50) {
            pageInfo { hasNextPage endCursor }
            nodes {
              ${PR_THREAD_COMMENT_FIELDS}
            }
          }
        }
      }
    }
  }
}`;

const PR_THREAD_COMMENTS_GRAPHQL_QUERY = `
query($id: ID!, $after: String) {
  node(id: $id) {
    ... on PullRequestReviewThread {
      comments(first: 100, after: $after) {
        pageInfo { hasNextPage endCursor }
        nodes {
          ${PR_THREAD_COMMENT_FIELDS}
        }
      }
    }
  }
}`;

interface GhConnection {
  pageInfo?: { hasNextPage?: boolean; endCursor?: string | null } | null;
  nodes?: any[] | null;
}

const nextCursor = (connection: GhConnection | null | undefined): string | null =>
  connection?.pageInfo?.hasNextPage && connection.pageInfo.endCursor ? connection.pageInfo.endCursor : null;

/** The PR's inline review threads and the author logins that are bots, every page. A read that fails partway says so (`complete: false`) and keeps what it read. */
async function fetchGhThreadsAndBots(
  runtime: PRRuntime,
  ref: GhPRRef,
): Promise<{ threads: PRReviewThread[]; botLogins: Set<string>; avatarByLogin: Map<string, string>; complete: boolean }> {
  const read = async (fields: string[]): Promise<any | null> => {
    const result = await runtime.runCommand("gh", hostnameArgs(ref.host, ["api", "graphql", ...fields]));
    if (result.exitCode !== 0) return null;
    try {
      const parsed = JSON.parse(result.stdout);
      return parsed?.errors?.length ? null : parsed?.data ?? null;
    } catch {
      return null;
    }
  };

  const botLogins = new Set<string>();
  const avatarByLogin = new Map<string, string>();
  const threads: PRReviewThread[] = [];
  const collect = (author: any) => {
    if (!author?.login) return;
    const login = String(author.login);
    if (author.__typename === 'Bot') botLogins.add(login);
    if (author.avatarUrl && !avatarByLogin.has(login)) avatarByLogin.set(login, String(author.avatarUrl));
  };
  const commentOf = (c: any): PRThreadComment => {
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
      ...(c.isMinimized === true ? { isMinimized: true, ...(typeof c.minimizedReason === 'string' && c.minimizedReason ? { minimizedReason: c.minimizedReason } : {}) } : {}),
    };
  };

  let page: string[] = [];
  for (;;) {
    const data = await read([
      "-f", `query=${PR_CONTEXT_GRAPHQL_QUERY}`,
      "-f", `owner=${ref.owner}`,
      "-f", `repo=${ref.repo}`,
      "-F", `number=${ref.number}`,
      ...page,
    ]);
    const pr = data?.repository?.pullRequest;
    if (!pr) return { threads, botLogins, avatarByLogin, complete: false };
    for (const n of (pr.comments?.nodes ?? [])) collect(n?.author);
    for (const n of (pr.reviews?.nodes ?? [])) collect(n?.author);
    for (const t of (pr.reviewThreads?.nodes ?? [])) {
      const comments: PRThreadComment[] = (t.comments?.nodes ?? []).map(commentOf);
      let after = nextCursor(t.comments);
      while (after) {
        const more = await read(["-f", `query=${PR_THREAD_COMMENTS_GRAPHQL_QUERY}`, "-f", `id=${String(t.id ?? '')}`, "-f", `after=${after}`]);
        const connection: GhConnection | undefined = more?.node?.comments;
        if (!connection) {
          threads.push(threadOf(t, comments));
          return { threads, botLogins, avatarByLogin, complete: false };
        }
        comments.push(...(connection.nodes ?? []).map(commentOf));
        after = nextCursor(connection);
      }
      threads.push(threadOf(t, comments));
    }
    const nextComments = nextCursor(pr.comments);
    const nextReviews = nextCursor(pr.reviews);
    const nextThreads = nextCursor(pr.reviewThreads);
    if (!nextComments && !nextReviews && !nextThreads) return { threads, botLogins, avatarByLogin, complete: true };
    page = [
      "-F", `withComments=${!!nextComments}`,
      "-F", `withReviews=${!!nextReviews}`,
      "-F", `withThreads=${!!nextThreads}`,
      ...(nextComments ? ["-f", `commentsAfter=${nextComments}`] : []),
      ...(nextReviews ? ["-f", `reviewsAfter=${nextReviews}`] : []),
      ...(nextThreads ? ["-f", `threadsAfter=${nextThreads}`] : []),
    ];
  }
}

function threadOf(t: any, comments: PRThreadComment[]): PRReviewThread {
  return {
    id: String(t.id ?? ''),
    isResolved: t.isResolved === true,
    isOutdated: t.isOutdated === true,
    path: String(t.path ?? ''),
    line: typeof t.line === 'number' ? t.line : null,
    startLine: typeof t.startLine === 'number' ? t.startLine : null,
    diffSide: t.diffSide === 'LEFT' || t.diffSide === 'RIGHT' ? t.diffSide : null,
    ...(t.startDiffSide === 'LEFT' || t.startDiffSide === 'RIGHT' ? { startDiffSide: t.startDiffSide } : {}),
    comments,
  };
}

/** Who is asked to review and has not yet: a read of its own, so a token that cannot read it costs only these names. REST, since `gh pr view --json reviewRequests` needs `read:org` for a team. */
export async function fetchGhRequestedReviewers(runtime: PRRuntime, ref: GhPRRef): Promise<PRRequestedReviewer[]> {
  const result = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api", `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/requested_reviewers`,
  ]));
  if (result.exitCode !== 0) return [];
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    return [];
  }
  const rows = (value: unknown): Record<string, unknown>[] => (Array.isArray(value) ? value.filter((row) => typeof row === "object" && row !== null) : []);
  const { users, teams } = (answer ?? {}) as { users?: unknown; teams?: unknown };
  const people = rows(users).flatMap((user): PRRequestedReviewer[] => {
    if (typeof user.login !== "string" || !user.login) return [];
    return [{
      login: user.login,
      ...(typeof user.avatar_url === "string" && user.avatar_url ? { avatarUrl: user.avatar_url } : {}),
      ...(user.type === "Bot" ? { isBot: true } : {}),
    }];
  });
  const groups = rows(teams).flatMap((team): PRRequestedReviewer[] =>
    typeof team.slug === "string" && team.slug ? [{ login: `${ref.owner}/${team.slug}`, isTeam: true }] : [],
  );
  return [...people, ...groups];
}

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

  const cleaned = base64Content.replace(/\n/g, "");
  try {
    return Buffer.from(cleaned, "base64").toString("utf-8");
  } catch {
    return null;
  }
}

/**
 * Every file of one commit through the git trees API, in one call. GitHub
 * stops past ~100k entries and says `truncated`; the list is then partial.
 */
export async function fetchGhPRTree(
  runtime: PRRuntime,
  ref: GhPRRef,
  sha: string,
): Promise<PRTreeResult | null> {
  const result = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api",
    `repos/${ref.owner}/${ref.repo}/git/trees/${encodeURIComponent(sha)}?recursive=1`,
    "--jq", '{truncated: .truncated, paths: [.tree[] | select(.type == "blob") | .path]}',
  ]));
  if (result.exitCode !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout) as { truncated?: unknown; paths?: unknown };
    if (!Array.isArray(parsed.paths)) return null;
    return {
      paths: parsed.paths.filter((path): path is string => typeof path === "string"),
      truncated: parsed.truncated === true,
    };
  } catch {
    return null;
  }
}

/**
 * One file at one commit as raw bytes (image preview). The contents API
 * inlines base64 up to 1 MB; larger files come back as `encoding: "none"`,
 * and the blobs API (base64, up to 100 MB) serves them — but only after the
 * reported size passed the cap, so an oversized file costs no second call.
 */
export async function fetchGhPRFileBytes(
  runtime: PRRuntime,
  ref: GhPRRef,
  sha: string,
  filePath: string,
  maxBytes: number,
): Promise<PRFileBytesResult> {
  const contents = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api",
    `repos/${ref.owner}/${ref.repo}/contents/${encodeApiFilePath(filePath)}?ref=${sha}`,
    "--jq", "{type,sha,size,encoding,content}",
  ]));
  if (contents.exitCode !== 0) {
    if (isNotFoundCommandFailure(contents.stderr)) return { kind: "missing" };
    throw new Error(`GitHub contents API failed: ${contents.stderr.trim() || `exit ${contents.exitCode}`}`);
  }
  const meta = JSON.parse(contents.stdout) as {
    type?: string; sha?: string; size?: number; encoding?: string; content?: string;
  };
  if (meta.type !== "file" || typeof meta.size !== "number") return { kind: "missing" };
  if (meta.size > maxBytes) return { kind: "too-large", size: meta.size };
  const etag = meta.sha ? `"${meta.sha}"` : undefined;
  if (meta.encoding === "base64" && typeof meta.content === "string") {
    return { kind: "ok", bytes: decodeBase64Bytes(meta.content), ...(etag ? { etag } : {}) };
  }
  if (!meta.sha || !/^[0-9a-f]{40,64}$/i.test(meta.sha)) return { kind: "missing" };

  const blob = await runtime.runCommand("gh", hostnameArgs(ref.host, [
    "api",
    `repos/${ref.owner}/${ref.repo}/git/blobs/${meta.sha}`,
    "--jq", "{size,encoding,content}",
  ]));
  if (blob.exitCode !== 0) {
    if (isNotFoundCommandFailure(blob.stderr)) return { kind: "missing" };
    throw new Error(`GitHub blobs API failed: ${blob.stderr.trim() || `exit ${blob.exitCode}`}`);
  }
  const body = JSON.parse(blob.stdout) as { size?: number; encoding?: string; content?: string };
  if (typeof body.size === "number" && body.size > maxBytes) return { kind: "too-large", size: body.size };
  if (body.encoding !== "base64" || typeof body.content !== "string") return { kind: "missing" };
  return { kind: "ok", bytes: decodeBase64Bytes(body.content), ...(etag ? { etag } : {}) };
}

/** Returns `{ filePath: isViewed }`, true for VIEWED or DISMISSED (reviewed, though possibly needing re-review). */
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

/** Marks or unmarks files via GraphQL mutations with Promise.allSettled; throws only if ALL fail. */
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

/** Append file-level comments to a review body as `**path:** text` paragraphs. Used for GitLab and for any GitHub file-level thread that could not be created. */
export function foldFileLevelComments(
  body: string,
  comments: PRReviewFileLevelComment[],
): string {
  return [body, ...comments.map((c) => `**${c.path}:** ${c.body}`)]
    .filter((part) => part.trim().length > 0)
    .join("\n\n");
}

const ADD_FILE_THREAD_MUTATION = `mutation($reviewId: ID!, $path: String!, $body: String!) {
  addPullRequestReviewThread(input: { pullRequestReviewId: $reviewId, path: $path, body: $body, subjectType: FILE }) {
    thread { id }
  }
}`;

const PENDING_REVIEW_REMAINS =
  "A pending review remains on the pull request; submit or discard it on GitHub before retrying.";

/** GitHub requires a body on a COMMENT or REQUEST_CHANGES review; the client uses the same placeholder. */
const COMMENT_BODY_PLACEHOLDER = "See inline comments.";

const MAX_ERROR_DETAIL = 300;

/**
 * GitHub's own reason for a refusal, read from the JSON body `gh api` prints
 * on stdout: REST `errors[]` (strings or `{ message }` objects) and GraphQL
 * `errors[].message`, else a REST top-level `message`. `gh` itself only puts
 * the generic status line ("Unprocessable Entity (HTTP 422)") on stderr.
 * Returns undefined when stdout is not a GitHub error body.
 */
export function githubErrorDetail(stdout: string): string | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const body = parsed as { message?: unknown; errors?: unknown };
  const reasons: string[] = [];
  if (Array.isArray(body.errors)) {
    for (const item of body.errors) {
      const text = typeof item === "string"
        ? item
        : typeof item === "object" && item !== null && typeof (item as { message?: unknown }).message === "string"
          ? (item as { message: string }).message
          : undefined;
      const trimmed = text?.trim();
      if (trimmed && !reasons.includes(trimmed)) reasons.push(trimmed);
    }
  }
  if (reasons.length === 0 && typeof body.message === "string" && body.message.trim()) {
    reasons.push(body.message.trim());
  }
  if (reasons.length === 0) return undefined;
  const detail = reasons.join("; ");
  return detail.length > MAX_ERROR_DETAIL ? `${detail.slice(0, MAX_ERROR_DETAIL - 1)}…` : detail;
}

function commandError(result: CommandResult): string {
  const stderr = result.stderr.trim();
  const stdout = result.stdout.trim();
  const detail = githubErrorDetail(stdout);
  if (detail) {
    if (!stderr || stderr.includes(detail)) return stderr || detail;
    return `${stderr}: ${detail}`;
  }
  if (stderr) return stderr;
  if (stdout && !stdout.startsWith("{") && !stdout.startsWith("[")) {
    return stdout.length > MAX_ERROR_DETAIL ? `${stdout.slice(0, MAX_ERROR_DETAIL - 1)}…` : stdout;
  }
  return `exit code ${result.exitCode}`;
}

/** Submit a GitHub review. Without file-level comments: one atomic create-review call. With them (not documented on `comments[]`): create it PENDING with the line comments, add each file comment as `addPullRequestReviewThread(subjectType: FILE)`, then submit. A rejected file comment is folded into the body. A pending review is visible only to its author. */
export async function submitGhPRReview(
  runtime: PRRuntime,
  ref: GhPRRef,
  headSha: string,
  action: PRReviewAction,
  body: string,
  fileComments: PRReviewFileComment[],
  fileLevelComments: PRReviewFileLevelComment[] = [],
): Promise<PRReviewSubmissionResult> {
  if (!runtime.runCommandWithInput) {
    throw new Error("Runtime does not support stdin input; cannot submit PR review");
  }
  const run = runtime.runCommandWithInput.bind(runtime);
  const event = action === "approve" ? "APPROVE" : action === "request_changes" ? "REQUEST_CHANGES" : "COMMENT";
  const reviewsEndpoint = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}/reviews`;
  const api = (endpoint: string, method: string, input: unknown) =>
    run("gh", hostnameArgs(ref.host, ["api", endpoint, "--method", method, "--input", "-"]), JSON.stringify(input));

  const submitAtomic = async (reviewBody: string): Promise<PRReviewSubmissionResult> => {
    const result = await api(reviewsEndpoint, "POST", {
      commit_id: headSha,
      body: reviewBody,
      event,
      comments: fileComments,
    });
    if (result.exitCode !== 0) {
      throw new Error(`Failed to submit PR review: ${commandError(result)}`);
    }
    return { status: "complete" };
  };

  if (fileLevelComments.length === 0) return submitAtomic(body);

  // Pending review carrying the line comments. If this fails nothing exists, so fall back to the single call with file comments in the body.
  const created = await api(reviewsEndpoint, "POST", { commit_id: headSha, comments: fileComments });
  let reviewId: number | undefined;
  let reviewNodeId: string | undefined;
  if (created.exitCode === 0) {
    try {
      const parsed = JSON.parse(created.stdout);
      if (typeof parsed?.id === "number" && typeof parsed?.node_id === "string") {
        reviewId = parsed.id;
        reviewNodeId = parsed.node_id;
      }
    } catch {
      // handled below
    }
  }
  if (reviewId === undefined || reviewNodeId === undefined) {
    if (created.exitCode === 0) {
      // A pending review may exist but we cannot address it; do not post a
      // second review on top of it.
      throw new Error(`Failed to submit PR review: GitHub's reply to creating the review could not be read. ${PENDING_REVIEW_REMAINS}`);
    }
    // Throws the single call's error when it fails too, so only a successful fallback is logged.
    const result = await submitAtomic(foldFileLevelComments(body, fileLevelComments));
    console.error(`[plannotator] pending review could not be created (${commandError(created)}); file comments were posted in the review body`);
    return result;
  }

  const folded: PRReviewFileLevelComment[] = [];
  for (const comment of fileLevelComments) {
    const result = await run(
      "gh",
      hostnameArgs(ref.host, ["api", "graphql", "--input", "-"]),
      JSON.stringify({
        query: ADD_FILE_THREAD_MUTATION,
        variables: { reviewId: reviewNodeId, path: comment.path, body: comment.body },
      }),
    );
    let threadId: unknown;
    if (result.exitCode === 0) {
      try {
        const parsed = JSON.parse(result.stdout);
        if (!Array.isArray(parsed?.errors) || parsed.errors.length === 0) {
          threadId = parsed?.data?.addPullRequestReviewThread?.thread?.id;
        }
      } catch {
        // treated as a failure below
      }
    }
    if (typeof threadId !== "string") {
      console.error(`[plannotator] file comment on ${comment.path} could not be posted as a file thread (${commandError(result)}); posting it in the review body`);
      folded.push(comment);
    }
  }

  // Submit; on failure discard the pending review so a retry starts clean.
  let submitBody = foldFileLevelComments(body, folded);
  if (event !== "APPROVE" && submitBody.trim().length === 0) submitBody = COMMENT_BODY_PLACEHOLDER;
  const submitted = await api(`${reviewsEndpoint}/${reviewId}/events`, "POST", {
    event,
    body: submitBody,
  });
  if (submitted.exitCode !== 0) {
    const message = commandError(submitted);
    // The submit may have landed with only its response lost; never delete or
    // report a failure for a review GitHub already shows as submitted.
    const current = await runtime.runCommand("gh", hostnameArgs(ref.host, ["api", `${reviewsEndpoint}/${reviewId}`]));
    if (current.exitCode === 0) {
      try {
        const state = JSON.parse(current.stdout)?.state;
        if (typeof state === "string" && state !== "PENDING") return { status: "complete" };
      } catch {
        // unknown state: treat as still pending
      }
    }
    const deleted = await runtime.runCommand(
      "gh",
      hostnameArgs(ref.host, ["api", `${reviewsEndpoint}/${reviewId}`, "--method", "DELETE"]),
    );
    if (deleted.exitCode !== 0) {
      throw new Error(`Failed to submit PR review: ${message}. ${PENDING_REVIEW_REMAINS}`);
    }
    throw new Error(`Failed to submit PR review: ${message}`);
  }
  return { status: "complete" };
}

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

/** Walks up (base branch to default branch) and down (head branch to leaf PRs) from the current PR. */
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

  const nodes: PRStackNode[] = [
    { branch: defaultBranch, isCurrent: false, isDefaultBranch: true },
    ...ancestors.reverse(),
    currentNode,
    ...descendants,
  ];

  return { nodes };
}

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

/** GitHub's limit on a comment body or PR description: 65,536 characters (the API refuses more; not in the REST reference). */
export const GH_BODY_MAX = 65_536;

interface GhIssueComment {
  id: number;
  body?: string | null;
  html_url?: string;
  user?: { login?: string } | null;
}

const urlOf = (stdout: string): string | null => {
  try {
    const url = JSON.parse(stdout)?.html_url;
    return typeof url === "string" ? url : null;
  } catch {
    return null;
  }
};

/**
 * The person's own comment on the PR that starts with `input.marker`, edited in place; else a new one. Found on the
 * forge every time (no id is kept): the newest of the signed-in account's comments that start with the marker. One
 * that is gone by the time it is edited (deleted meanwhile, HTTP 404) is posted again as new.
 */
export async function upsertGhMarkedComment(runtime: PRRuntime, ref: GhPRRef, input: PRMarkedCommentInput): Promise<PRMarkedResult> {
  if (!runtime.runCommandWithInput) throw new Error("Runtime does not support stdin input; cannot post a comment");
  const run = runtime.runCommandWithInput.bind(runtime);
  const text = markedCommentText(input, GH_BODY_MAX);
  const base = `repos/${ref.owner}/${ref.repo}/issues`;
  const listed = await runtime.runCommand("gh", hostnameArgs(ref.host, ["api", `${base}/${ref.number}/comments?per_page=100`, "--paginate"]));
  if (listed.exitCode !== 0) throw new Error(`Couldn't read the pull request's comments: ${commandError(listed)}`);
  const marked = parsePaginatedArray<GhIssueComment>(listed.stdout).filter((comment) => startsWithMarker(comment.body, input.marker));
  const me = marked.length > 0 ? await getGhUser(runtime, ref.host) : null;
  const own = marked.filter((comment) => me !== null && comment.user?.login?.toLowerCase() === me.toLowerCase());
  const existing = own.at(-1);
  if (existing) {
    const edited = await run("gh", hostnameArgs(ref.host, ["api", `${base}/comments/${existing.id}`, "--method", "PATCH", "--input", "-"]), JSON.stringify({ body: text }));
    if (edited.exitCode === 0) return { action: "updated", url: urlOf(edited.stdout) ?? existing.html_url ?? "" };
    if (!isNotFoundCommandFailure(edited.stderr)) throw new Error(`Couldn't update the comment: ${commandError(edited)}`);
  }
  const posted = await run("gh", hostnameArgs(ref.host, ["api", `${base}/${ref.number}/comments`, "--method", "POST", "--input", "-"]), JSON.stringify({ body: text }));
  if (posted.exitCode !== 0) throw new Error(`Couldn't post the comment: ${commandError(posted)}`);
  return { action: "created", url: urlOf(posted.stdout) ?? "" };
}

/**
 * The PR description's section between `input.start` and `input.end`, put in place (or at the end), the rest kept byte for byte. GitHub takes no precondition on this write, so it is read, spliced, read again just before the write, and refused (PRMarkedRaceError) if another edit landed in between; an edit after that second read is not caught.
 * A write refused for access is PRMarkedForbiddenError, for the caller to fall back.
 */
export async function upsertGhDescriptionSection(runtime: PRRuntime, ref: GhPRRef, input: PRMarkedSectionInput): Promise<PRMarkedResult> {
  if (!runtime.runCommandWithInput) throw new Error("Runtime does not support stdin input; cannot edit a description");
  const path = `repos/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
  const read = async (): Promise<{ body: string; url: string }> => {
    const result = await runtime.runCommand("gh", hostnameArgs(ref.host, ["api", path]));
    if (result.exitCode !== 0) throw new Error(`Couldn't read the pull request: ${commandError(result)}`);
    const parsed = JSON.parse(result.stdout) as { body?: string | null; html_url?: string };
    return { body: parsed.body ?? "", url: parsed.html_url ?? "" };
  };
  const first = await read();
  const planned = spliceMarkedSection(first.body, input, GH_BODY_MAX);
  if ((await read()).body !== first.body) throw new PRMarkedRaceError();
  const written = await runtime.runCommandWithInput("gh", hostnameArgs(ref.host, ["api", path, "--method", "PATCH", "--input", "-"]), JSON.stringify({ body: planned.text }));
  if (written.exitCode !== 0) {
    if (isAccessRefusal(written.stderr, written.stdout)) throw new PRMarkedForbiddenError(commandError(written));
    throw new Error(`Couldn't edit the description: ${commandError(written)}`);
  }
  return { action: planned.replaced ? "updated" : "created", url: first.url };
}
