/**
 * Bitbucket Cloud PR provider implementation.
 *
 * Bitbucket has no gh/glab-style CLI, so this talks to the REST API 2.0
 * (https://api.bitbucket.org/2.0) directly with the runtime's `fetch`.
 *
 * Auth: an Atlassian API token (app passwords are deprecated), sent as basic
 * auth with the Atlassian account email when one is configured, else as a
 * Bearer token. See resolveBitbucketCredentials in config.ts. The token is
 * never logged, echoed, or put in an error message.
 *
 * Server-only (reads config.json, writes failed comments to the data dir).
 */

import { join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import type {
  BitbucketPRRef,
  PRContext,
  PRFileBytesResult,
  PRListItem,
  PRMetadata,
  PRReviewAction,
  PRReviewCommentFailure,
  PRReviewFileComment,
  PRReviewSubmissionResult,
  PRRuntime,
} from "./pr-types";
import { getPlannotatorDataDir } from "./data-dir";
import {
  loadConfig,
  resolveBitbucketApiUrl,
  resolveBitbucketCredentials,
  type BitbucketCredentials,
} from "./config";

/** Scopes a Bitbucket API token needs for PR review. */
export const BITBUCKET_TOKEN_SCOPES = [
  "read:user:bitbucket",
  "read:repository:bitbucket",
  "read:pullrequest:bitbucket",
  "write:pullrequest:bitbucket",
] as const;

const TOKEN_HELP =
  `Create an Atlassian API token with scopes (https://id.atlassian.com/manage-profile/security/api-tokens → "Create API token with scopes" → Bitbucket) ` +
  `granting ${BITBUCKET_TOKEN_SCOPES.join(", ")}, then set PLANNOTATOR_BITBUCKET_EMAIL (your Atlassian account email) and PLANNOTATOR_BITBUCKET_TOKEN.`;

export const BITBUCKET_MISSING_TOKEN_MESSAGE =
  `Bitbucket Cloud PR review needs an Atlassian API token. ${TOKEN_HELP}`;

/** A Bitbucket REST failure. `message` is safe to show: it never carries the token. */
export class BitbucketApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "BitbucketApiError";
  }
}

// --- HTTP ---

interface BbContext {
  fetch: typeof fetch;
  apiBase: string;
  apiOrigin: string;
  credentials: BitbucketCredentials | null;
}

function context(runtime: PRRuntime): BbContext {
  const apiBase = resolveBitbucketApiUrl();
  return {
    fetch: runtime.fetch ?? globalThis.fetch,
    apiBase,
    apiOrigin: new URL(apiBase).origin,
    credentials: resolveBitbucketCredentials(loadConfig()),
  };
}

function authHeader(credentials: BitbucketCredentials): string {
  if (credentials.email) {
    const raw = `${credentials.email}:${credentials.token}`;
    const bytes = new TextEncoder().encode(raw);
    let binary = "";
    for (const b of bytes) binary += String.fromCharCode(b);
    return `Basic ${btoa(binary)}`;
  }
  return `Bearer ${credentials.token}`;
}

/** Encode a `workspace/repo` (or a repo-relative file path) segment by segment. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function repoPath(fullName: string): string {
  return `/repositories/${encodePath(fullName)}`;
}

function refRepoPath(ref: BitbucketPRRef): string {
  return repoPath(`${ref.workspace}/${ref.repo}`);
}

/** Bitbucket's own error text from a JSON error body, capped. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    try {
      const parsed = JSON.parse(text) as { error?: { message?: unknown; detail?: unknown } };
      const message = typeof parsed.error?.message === "string" ? parsed.error.message : "";
      // A scope refusal carries `detail: { required: [...], granted: [...] }`.
      const rawDetail = parsed.error?.detail;
      const required = rawDetail && typeof rawDetail === "object" && Array.isArray((rawDetail as { required?: unknown }).required)
        ? ((rawDetail as { required: unknown[] }).required).filter((s): s is string => typeof s === "string")
        : [];
      const detail = typeof rawDetail === "string"
        ? rawDetail
        : required.length > 0 ? `missing scope ${required.join(", ")}` : "";
      const combined = [message, detail].filter(Boolean).join(": ");
      if (combined) return combined.slice(0, 300);
    } catch { /* not JSON */ }
    return text.trim().slice(0, 300);
  } catch {
    return "";
  }
}

async function failure(res: Response, what: string): Promise<BitbucketApiError> {
  const detail = await errorDetail(res);
  if (res.status === 401) {
    return new BitbucketApiError(
      `Bitbucket rejected the API token (HTTP 401) while trying to ${what}. ` +
        `Check that PLANNOTATOR_BITBUCKET_TOKEN is current and PLANNOTATOR_BITBUCKET_EMAIL is the Atlassian account email that owns it ` +
        `(unset the email to send the token as a Bearer token). ${TOKEN_HELP}`,
      401,
    );
  }
  if (res.status === 403) {
    return new BitbucketApiError(
      `Bitbucket refused to ${what} (HTTP 403)${detail ? `: ${detail}` : ""}. ` +
        `The API token needs the scopes ${BITBUCKET_TOKEN_SCOPES.join(", ")} and access to this repository.`,
      403,
    );
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `in ${Math.ceil(retryAfter)}s` : "in a minute";
    return new BitbucketApiError(
      `Bitbucket rate-limited the request to ${what} (HTTP 429). Try again ${wait}.`,
      429,
    );
  }
  return new BitbucketApiError(
    `Failed to ${what}: Bitbucket HTTP ${res.status}${detail ? `: ${detail}` : ""}`,
    res.status,
  );
}

/**
 * One request to the API. `pathOrUrl` is API-relative ("/repositories/…") or
 * an absolute URL on the API origin (a pagination `next` link). Redirects are
 * followed by hand and only within the API origin, so credentials never leave
 * it (the PR `/diff` endpoint answers with a same-origin redirect).
 */
async function bbRequest(
  ctx: BbContext,
  pathOrUrl: string,
  init: { method?: string; body?: unknown; accept?: string } = {},
): Promise<Response> {
  if (!ctx.credentials) throw new BitbucketApiError(BITBUCKET_MISSING_TOKEN_MESSAGE, 401);
  let url = pathOrUrl.startsWith("/") ? `${ctx.apiBase}${pathOrUrl}` : pathOrUrl;
  if (new URL(url).origin !== ctx.apiOrigin) {
    throw new BitbucketApiError(`Refusing to send Bitbucket credentials to ${new URL(url).origin}`, 400);
  }
  const headers: Record<string, string> = {
    Authorization: authHeader(ctx.credentials),
    Accept: init.accept ?? "application/json",
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  for (let hop = 0; hop < 5; hop++) {
    const res = await ctx.fetch(url, {
      method: init.method ?? "GET",
      headers,
      body: init.body !== undefined ? JSON.stringify(init.body) : undefined,
      redirect: "manual",
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      const next = new URL(res.headers.get("location")!, url);
      if (next.origin !== ctx.apiOrigin) {
        throw new BitbucketApiError(`Bitbucket redirected off the API origin (${next.origin})`, res.status);
      }
      url = next.toString();
      continue;
    }
    return res;
  }
  throw new BitbucketApiError("Too many Bitbucket redirects", 508);
}

async function bbJson<T>(ctx: BbContext, path: string, what: string): Promise<T> {
  const res = await bbRequest(ctx, path);
  if (!res.ok) throw await failure(res, what);
  return (await res.json()) as T;
}

interface BbPage<T> {
  values?: T[];
  next?: string;
}

/** Follow `next` links (same API origin only), capped at `maxPages`. */
async function bbPaginate<T>(ctx: BbContext, path: string, what: string, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  let next: string | undefined = path;
  for (let page = 0; next && page < maxPages; page++) {
    const body: BbPage<T> = await bbJson<BbPage<T>>(ctx, next, what);
    if (Array.isArray(body.values)) out.push(...body.values);
    next = typeof body.next === "string" && body.next ? body.next : undefined;
    if (next && new URL(next, ctx.apiBase).origin !== ctx.apiOrigin) next = undefined;
  }
  return out;
}

// --- API shapes (only the fields read here) ---

interface BbAccount {
  type?: string;
  display_name?: string;
  nickname?: string;
  account_id?: string;
  uuid?: string;
  links?: { avatar?: { href?: string } };
}

interface BbEndpoint {
  branch?: { name?: string };
  commit?: { hash?: string } | null;
  repository?: { full_name?: string } | null;
}

interface BbPullRequest {
  id: number;
  title?: string;
  description?: string;
  summary?: { raw?: string };
  state?: string;
  draft?: boolean;
  author?: BbAccount;
  source?: BbEndpoint;
  destination?: BbEndpoint;
  participants?: Array<{
    user?: BbAccount;
    role?: string;
    approved?: boolean;
    state?: string | null;
    participated_on?: string | null;
  }>;
  links?: { html?: { href?: string } };
}

interface BbComment {
  id: number;
  content?: { raw?: string };
  user?: BbAccount;
  created_on?: string;
  deleted?: boolean;
  parent?: { id?: number } | null;
  inline?: {
    path?: string;
    from?: number | null;
    to?: number | null;
    start_from?: number | null;
    start_to?: number | null;
    outdated?: boolean;
  } | null;
  resolution?: unknown;
  pending?: boolean;
  links?: { html?: { href?: string } };
}

interface BbDiffstat {
  status?: string;
  old?: { path?: string } | null;
  new?: { path?: string } | null;
}

function accountName(a: BbAccount | undefined | null): string {
  return a?.nickname || a?.display_name || "";
}

function isBbBot(a: BbAccount | undefined | null): boolean {
  return a?.type === "app_user";
}

function avatarOf(a: BbAccount | undefined | null): string | undefined {
  const href = a?.links?.avatar?.href;
  return typeof href === "string" && href ? href : undefined;
}

function webUrl(ref: BitbucketPRRef): string {
  return `https://${ref.host}/${ref.workspace}/${ref.repo}/pull-requests/${ref.number}`;
}

// --- Auth ---

export async function checkBbAuth(runtime: PRRuntime): Promise<void> {
  const ctx = context(runtime);
  if (!ctx.credentials) throw new BitbucketApiError(BITBUCKET_MISSING_TOKEN_MESSAGE, 401);
  const res = await bbRequest(ctx, "/user");
  if (!res.ok) throw await failure(res, "read the current Bitbucket user");
}

export async function getBbUser(runtime: PRRuntime): Promise<string | null> {
  try {
    const ctx = context(runtime);
    if (!ctx.credentials) return null;
    const user = await bbJson<BbAccount>(ctx, "/user", "read the current user");
    return accountName(user) || null;
  } catch {
    return null;
  }
}

// --- Fetch PR ---

/** Resolve a (possibly abbreviated) commit hash to the full SHA; falls back to the input. */
async function resolveCommit(ctx: BbContext, fullName: string, hash: string): Promise<string> {
  if (/^[0-9a-f]{40,64}$/i.test(hash)) return hash;
  try {
    const commit = await bbJson<{ hash?: string }>(ctx, `${repoPath(fullName)}/commit/${encodeURIComponent(hash)}`, "resolve a commit");
    return typeof commit.hash === "string" && commit.hash ? commit.hash : hash;
  } catch {
    return hash;
  }
}

/** Number of files in a git-style patch. */
function countPatchFiles(patch: string): number {
  return (patch.match(/^diff --git /gm) ?? []).length;
}

export async function fetchBbPR(
  runtime: PRRuntime,
  ref: BitbucketPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
  const ctx = context(runtime);
  const prPath = `${refRepoPath(ref)}/pullrequests/${ref.number}`;
  const destFullName = `${ref.workspace}/${ref.repo}`;

  const pr = await bbJson<BbPullRequest>(ctx, prPath, "fetch PR metadata");
  const sourceFullName = pr.source?.repository?.full_name;
  if (!sourceFullName) {
    throw new Error("PR source repository is no longer available (the fork may have been deleted).");
  }
  const headShort = pr.source?.commit?.hash;
  const baseShort = pr.destination?.commit?.hash;
  if (!headShort || !baseShort) {
    throw new Error("PR has no source or destination commit — the source branch may have been deleted.");
  }

  const [headSha, baseSha, diffRes, diffstat, repo] = await Promise.all([
    resolveCommit(ctx, sourceFullName, headShort),
    resolveCommit(ctx, destFullName, baseShort),
    bbRequest(ctx, `${prPath}/diff`, { accept: "text/plain" }),
    bbPaginate<BbDiffstat>(ctx, `${prPath}/diffstat?pagelen=500`, "fetch the PR diffstat").catch(() => null),
    bbJson<{ mainbranch?: { name?: string } }>(ctx, refRepoPath(ref), "fetch the repository").catch(() => null),
  ]);

  if (!diffRes.ok) throw await failure(diffRes, "fetch the PR diff");
  const rawPatch = await diffRes.text();

  let patchIncomplete = false;
  if (diffstat) {
    const expected = diffstat.length;
    const got = countPatchFiles(rawPatch);
    if (got < expected) {
      console.error(
        `Warning: Bitbucket's diffstat lists ${expected} changed files but the PR diff contains ${got}. The review is missing the remainder; the full diff can be recomputed locally once the checkout is ready.`,
      );
      patchIncomplete = true;
    }
  }
  // Bitbucket's PR diff is a three-dot (topic) diff: file contents for the old
  // side must come from the merge base, not the destination tip.
  let mergeBaseSha: string | undefined;
  try {
    const mb = await bbJson<{ hash?: string }>(
      ctx,
      `${refRepoPath(ref)}/merge-base/${encodeURIComponent(`${headSha}..${baseSha}`)}`,
      "compute the merge base",
    );
    if (typeof mb.hash === "string" && mb.hash) mergeBaseSha = await resolveCommit(ctx, destFullName, mb.hash);
  } catch { /* fall back to baseSha */ }

  const sameRepo = sourceFullName.toLowerCase() === destFullName.toLowerCase();
  const metadata: PRMetadata = {
    platform: "bitbucket",
    host: ref.host,
    workspace: ref.workspace,
    repo: ref.repo,
    number: ref.number,
    title: pr.title ?? "",
    author: accountName(pr.author),
    baseBranch: pr.destination?.branch?.name ?? "",
    headBranch: pr.source?.branch?.name ?? "",
    ...(repo?.mainbranch?.name ? { defaultBranch: repo.mainbranch.name } : {}),
    baseSha,
    headSha,
    ...(mergeBaseSha ? { mergeBaseSha } : {}),
    ...(sameRepo ? {} : { sourceRepo: sourceFullName }),
    url: pr.links?.html?.href || webUrl(ref),
  };

  return { metadata, rawPatch, ...(patchIncomplete && { patchIncomplete }) };
}

// --- PR Context ---

const PR_STATE: Record<string, string> = {
  OPEN: "OPEN",
  MERGED: "MERGED",
  DECLINED: "CLOSED",
  SUPERSEDED: "CLOSED",
};

const CHECK_CONCLUSION: Record<string, string> = {
  SUCCESSFUL: "SUCCESS",
  FAILED: "FAILURE",
  STOPPED: "NEUTRAL",
};

/**
 * The diff context a comment sits on, in GitHub's `diff_hunk` shape: the
 * enclosing hunk's header plus its lines up to and including the commented
 * line. Bitbucket comments carry no hunk, so it is cut from the PR diff.
 * Returns undefined when the line is not in the diff. Exported for tests.
 */
export function bitbucketDiffHunk(
  patch: string,
  path: string,
  side: "LEFT" | "RIGHT",
  line: number,
): string | undefined {
  const files = patch.split(/^(?=diff --git )/m);
  for (const file of files) {
    const header = file.slice(0, file.indexOf("\n@@") === -1 ? file.length : file.indexOf("\n@@"));
    const names = [...header.matchAll(/^(?:---|\+\+\+) (?:a\/|b\/)?(.+)$/gm)].map((m) => m[1]);
    if (!names.includes(path)) continue;
    const lines = file.split("\n");
    let hunkStart = -1;
    let oldLine = 0;
    let newLine = 0;
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i];
      const h = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
      if (h) {
        hunkStart = i;
        oldLine = Number(h[1]);
        newLine = Number(h[2]);
        continue;
      }
      if (hunkStart < 0 || text.startsWith("\\")) continue;
      const kind = text[0];
      if (kind !== " " && kind !== "+" && kind !== "-") continue;
      const onOld = kind !== "+";
      const onNew = kind !== "-";
      if ((side === "LEFT" && onOld && oldLine === line) || (side === "RIGHT" && onNew && newLine === line)) {
        return lines.slice(hunkStart, i + 1).join("\n");
      }
      if (onOld) oldLine++;
      if (onNew) newLine++;
    }
  }
  return undefined;
}

/**
 * Map a PR's comments into Plannotator's read-only model: inline comments
 * become review threads (a root plus its replies), everything else a
 * conversation comment. Deleted comments and unpublished (pending) drafts
 * are dropped. With the PR diff, each thread's first comment carries the
 * `diffHunk` it sits on. Exported for unit tests.
 */
export function mapBitbucketComments(raw: BbComment[], patch?: string): Pick<PRContext, "comments" | "reviewThreads"> {
  const visible = raw.filter((c) => c && typeof c.id === "number" && c.deleted !== true && c.pending !== true);
  const byId = new Map(visible.map((c) => [c.id, c]));
  const rootOf = (c: BbComment): BbComment => {
    let cur = c;
    const seen = new Set<number>();
    while (cur.parent?.id != null && byId.has(cur.parent.id) && !seen.has(cur.id)) {
      seen.add(cur.id);
      cur = byId.get(cur.parent.id)!;
    }
    return cur;
  };
  const toThreadComment = (c: BbComment) => {
    const avatarUrl = avatarOf(c.user);
    return {
      id: String(c.id),
      author: accountName(c.user),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(isBbBot(c.user) ? { isBot: true } : {}),
      body: c.content?.raw ?? "",
      createdAt: c.created_on ?? "",
      url: c.links?.html?.href ?? "",
    };
  };

  const comments: PRContext["comments"] = [];
  const threads = new Map<number, PRContext["reviewThreads"][number]>();
  const byCreated = [...visible].sort((a, b) => (a.created_on ?? "").localeCompare(b.created_on ?? "") || a.id - b.id);
  for (const c of byCreated) {
    const root = rootOf(c);
    if (!root.inline?.path) {
      comments.push(toThreadComment(c));
      continue;
    }
    let thread = threads.get(root.id);
    if (!thread) {
      const inline = root.inline;
      const to = typeof inline.to === "number" ? inline.to : null;
      const from = typeof inline.from === "number" ? inline.from : null;
      const startTo = typeof inline.start_to === "number" ? inline.start_to : null;
      const startFrom = typeof inline.start_from === "number" ? inline.start_from : null;
      thread = {
        id: String(root.id),
        isResolved: root.resolution != null,
        isOutdated: inline.outdated === true,
        path: inline.path ?? "",
        line: to ?? from,
        startLine: to !== null ? startTo : startFrom,
        diffSide: to !== null ? "RIGHT" : from !== null ? "LEFT" : null,
        comments: [],
      };
      threads.set(root.id, thread);
      const diffHunk = patch && thread.line !== null && thread.diffSide
        ? bitbucketDiffHunk(patch, thread.path, thread.diffSide, thread.line)
        : undefined;
      thread.comments.push({ ...toThreadComment(c), ...(diffHunk ? { diffHunk } : {}) });
      continue;
    }
    thread.comments.push(toThreadComment(c));
  }
  return { comments, reviewThreads: [...threads.values()] };
}

export async function fetchBbPRContext(runtime: PRRuntime, ref: BitbucketPRRef): Promise<PRContext> {
  const ctx = context(runtime);
  const prPath = `${refRepoPath(ref)}/pullrequests/${ref.number}`;
  const [pr, rawComments, statuses, patch] = await Promise.all([
    bbJson<BbPullRequest>(ctx, prPath, "fetch PR context"),
    bbPaginate<BbComment>(ctx, `${prPath}/comments?pagelen=100`, "fetch PR comments").catch(() => []),
    bbPaginate<{ state?: string; name?: string; key?: string; url?: string }>(
      ctx, `${prPath}/statuses?pagelen=100`, "fetch PR statuses", 2,
    ).catch(() => []),
    // Best effort: only used to show each inline thread's code context.
    bbRequest(ctx, `${prPath}/diff`, { accept: "text/plain" })
      .then((res) => (res.ok ? res.text() : undefined))
      .catch(() => undefined),
  ]);

  const { comments, reviewThreads } = mapBitbucketComments(rawComments, patch);

  const reviews: PRContext["reviews"] = [];
  let anyApproved = false;
  let anyChangesRequested = false;
  for (const p of pr.participants ?? []) {
    const decided = p.state === "approved" || p.approved === true
      ? "APPROVED"
      : p.state === "changes_requested" ? "CHANGES_REQUESTED" : null;
    if (!decided) continue;
    if (decided === "APPROVED") anyApproved = true;
    else anyChangesRequested = true;
    const avatarUrl = avatarOf(p.user);
    reviews.push({
      id: p.user?.account_id ?? p.user?.uuid ?? accountName(p.user),
      author: accountName(p.user),
      ...(avatarUrl ? { avatarUrl } : {}),
      ...(isBbBot(p.user) ? { isBot: true } : {}),
      state: decided,
      body: "",
      submittedAt: p.participated_on ?? "",
    });
  }

  const checks: PRContext["checks"] = statuses.map((s) => {
    const state = (s.state ?? "").toUpperCase();
    const complete = state !== "INPROGRESS";
    return {
      name: s.name || s.key || "",
      status: complete ? "COMPLETED" : "IN_PROGRESS",
      conclusion: complete ? (CHECK_CONCLUSION[state] ?? state) : null,
      workflowName: "",
      detailsUrl: s.url ?? "",
    };
  });

  return {
    body: pr.description ?? pr.summary?.raw ?? "",
    state: PR_STATE[(pr.state ?? "").toUpperCase()] ?? (pr.state ?? "").toUpperCase(),
    isDraft: pr.draft === true,
    labels: [],
    reviewDecision: anyChangesRequested ? "CHANGES_REQUESTED" : anyApproved ? "APPROVED" : "",
    // Bitbucket exposes no cheap mergeability flag on the PR object.
    mergeable: "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    comments,
    reviews,
    reviewThreads,
    checks,
    linkedIssues: [],
  };
}

// --- File Content ---

function srcPath(ref: BitbucketPRRef, sha: string, filePath: string): string {
  return `${refRepoPath(ref)}/src/${encodeURIComponent(sha)}/${encodePath(filePath)}`;
}

export async function fetchBbFileContent(
  runtime: PRRuntime,
  ref: BitbucketPRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  try {
    const ctx = context(runtime);
    const res = await bbRequest(ctx, srcPath(ref, sha, filePath), { accept: "*/*" });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

/**
 * One file at one commit as raw bytes (image preview). The size comes from
 * `?format=meta` first, so an oversized file is never downloaded.
 */
export async function fetchBbFileBytes(
  runtime: PRRuntime,
  ref: BitbucketPRRef,
  sha: string,
  filePath: string,
  maxBytes: number,
): Promise<PRFileBytesResult> {
  const ctx = context(runtime);
  const metaRes = await bbRequest(ctx, `${srcPath(ref, sha, filePath)}?format=meta`);
  if (metaRes.status === 404) return { kind: "missing" };
  if (!metaRes.ok) throw await failure(metaRes, "read file metadata");
  const meta = (await metaRes.json()) as { type?: string; size?: number };
  if (meta.type !== "commit_file" || typeof meta.size !== "number") return { kind: "missing" };
  if (meta.size > maxBytes) return { kind: "too-large", size: meta.size };
  const res = await bbRequest(ctx, srcPath(ref, sha, filePath), { accept: "*/*" });
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) throw await failure(res, "read file contents");
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > maxBytes) return { kind: "too-large", size: bytes.byteLength };
  return { kind: "ok", bytes };
}

// --- Submit Review ---

/** The `inline` anchor Bitbucket expects for one line comment. Exported for tests. */
export function bitbucketInlineAnchor(comment: PRReviewFileComment): Record<string, unknown> {
  const inline: Record<string, unknown> = { path: comment.path };
  if (comment.side === "LEFT") inline.from = comment.line;
  else inline.to = comment.line;
  if (comment.start_line != null && comment.start_line !== comment.line) {
    const startSide = comment.start_side ?? comment.side;
    if (startSide === "LEFT") inline.start_from = comment.start_line;
    else inline.start_to = comment.start_line;
  }
  return inline;
}

/**
 * Post a review to a Bitbucket Cloud PR: each line comment as an inline
 * comment, then the body as one general comment, then the decision —
 * `approve` → `POST /approve`, `request_changes` → `POST /request-changes`,
 * `comment` → nothing more.
 *
 * Order matters (#1583): Bitbucket's PR Activity feed lists newest first, so
 * the mutation posted LAST renders on top. Posting the general comment after
 * the inline ones puts the review's summary above its inline comments (and
 * just under the decision badge), the way a GitHub review reads.
 *
 * Bitbucket has no atomic review, so this follows the GitLab contract: throws
 * only while nothing was mutated (a replay is safe), and otherwise returns a
 * partial result carrying the exact safe retry — including the general
 * comment when that one failed after inline comments landed.
 */
export async function submitBbPRReview(
  runtime: PRRuntime,
  ref: BitbucketPRRef,
  headSha: string,
  action: PRReviewAction,
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<PRReviewSubmissionResult> {
  const ctx = context(runtime);
  const prPath = `${refRepoPath(ref)}/pullrequests/${ref.number}`;
  const generalBody = body.trim();
  let reviewBodyPosted = false;
  let reviewBodyError: string | undefined;
  const failedFileComments: PRReviewCommentFailure[] = [];
  let recoveryFile: string | undefined;

  // 1. Inline comments. Sequential: Bitbucket rate-limits bursts, and order
  //    keeps the thread list readable on the PR.
  for (const comment of fileComments) {
    try {
      const res = await bbRequest(ctx, `${prPath}/comments`, {
        method: "POST",
        body: { content: { raw: comment.body }, inline: bitbucketInlineAnchor(comment) },
      });
      if (!res.ok) {
        const err = await failure(res, "post an inline comment");
        failedFileComments.push({ comment, error: `${comment.path}:${comment.line}: ${err.message}` });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      failedFileComments.push({ comment, error: `${comment.path}:${comment.line}: ${message}` });
    }
  }
  const postedFileCommentCount = fileComments.length - failedFileComments.length;

  if (failedFileComments.length > 0) {
    const errors = failedFileComments.map((f) => f.error);
    let savedTo: string | null = null;
    try {
      const dir = join(getPlannotatorDataDir(), "failed-comments");
      mkdirSync(dir, { recursive: true });
      const slug = `${ref.host}-${ref.workspace}_${ref.repo}-pr${ref.number}-${Date.now()}`;
      savedTo = join(dir, `${slug}.json`);
      writeFileSync(
        savedTo,
        JSON.stringify({ ref, headSha, errors, failedComments: failedFileComments.map((f) => f.comment) }, null, 2),
      );
    } catch (writeErr) {
      console.error(`[plannotator] Failed to persist unposted comments: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
    }
    recoveryFile = savedTo ?? undefined;
    const suffix = savedTo ? ` (unposted bodies saved to ${savedTo})` : "";
    if (postedFileCommentCount === 0) {
      // Nothing reached the PR (the general comment and the decision come
      // after): replaying the original request is safe.
      throw new Error(`Failed to post inline comments${suffix}:\n${errors.join("\n")}`);
    }
    console.error(
      `[plannotator] ${failedFileComments.length}/${fileComments.length} inline comments failed${suffix}:\n${errors.join("\n")}`,
    );
  }

  // 2. General comment.
  if (generalBody) {
    try {
      const res = await bbRequest(ctx, `${prPath}/comments`, {
        method: "POST",
        body: { content: { raw: generalBody } },
      });
      if (res.ok) {
        reviewBodyPosted = true;
      } else {
        reviewBodyError = (await failure(res, "post the PR comment")).message;
      }
    } catch (error) {
      reviewBodyError = `Failed to post the PR comment: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (reviewBodyError) {
      // Nothing reached the PR yet: surface it as an error (replay is safe).
      if (postedFileCommentCount === 0) throw new Error(reviewBodyError);
      console.error(`[plannotator] ${reviewBodyError}`);
    }
  }

  // 3. Decision.
  let approval: "not-requested" | "succeeded" | "failed" = "not-requested";
  let approvalError: string | undefined;
  if (action === "approve" || action === "request_changes") {
    const endpoint = action === "approve" ? "approve" : "request-changes";
    const what = action === "approve" ? "approve the PR" : "request changes on the PR";
    try {
      const res = await bbRequest(ctx, `${prPath}/${endpoint}`, { method: "POST" });
      if (res.ok) {
        approval = "succeeded";
      } else {
        const err = await failure(res, what);
        approval = "failed";
        approvalError = err.message;
      }
    } catch (error) {
      approval = "failed";
      approvalError = `Failed to ${what}: ${error instanceof Error ? error.message : String(error)}`;
    }
    if (approval === "failed" && !reviewBodyPosted && postedFileCommentCount === 0) {
      // A decision that failed after nothing else landed mutated nothing:
      // surface it as an error.
      throw new Error(approvalError);
    }
  }

  const bodyStillOwed = generalBody !== "" && !reviewBodyPosted;
  if (failedFileComments.length > 0 || approval === "failed" || bodyStillOwed) {
    return {
      status: "partial",
      postedFileCommentCount,
      failedFileComments,
      reviewBodyPosted,
      approval,
      ...(approvalError ? { approvalError } : {}),
      ...(reviewBodyError ? { reviewBodyError } : {}),
      ...(recoveryFile ? { recoveryFile } : {}),
      retry: {
        action: approval === "failed" ? action : "comment",
        fileComments: failedFileComments.map((f) => f.comment),
        ...(bodyStillOwed ? { body: generalBody } : {}),
      },
    };
  }
  return { status: "complete" };
}

// --- PR List ---

export async function fetchBbPRList(runtime: PRRuntime, ref: BitbucketPRRef): Promise<PRListItem[]> {
  try {
    const ctx = context(runtime);
    const body = await bbJson<BbPage<BbPullRequest & { destination?: BbEndpoint }>>(
      ctx,
      `${refRepoPath(ref)}/pullrequests?state=OPEN&state=MERGED&state=DECLINED&sort=-updated_on&pagelen=30`,
      "list PRs",
    );
    return (body.values ?? []).map((pr) => {
      const state = (pr.state ?? "").toUpperCase();
      return {
        id: String(pr.id),
        number: pr.id,
        title: pr.title ?? "",
        author: accountName(pr.author),
        url: pr.links?.html?.href || webUrl({ ...ref, number: pr.id }),
        baseBranch: pr.destination?.branch?.name ?? "",
        state: state === "OPEN" ? "open" : state === "MERGED" ? "merged" : "closed",
      };
    });
  } catch {
    return [];
  }
}
