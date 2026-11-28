/**
 * Forgejo / Gitea PR provider implementation.
 *
 * Forgejo has no gh/glab-style CLI here, so this talks to its REST API
 * (`<origin>/api/v1`) directly with the runtime's `fetch`, as the Bitbucket
 * provider does. Anything Gitea-compatible answers the same routes.
 *
 * Auth: an access token sent as `Authorization: token <t>`. The server hands
 * it over through `PRRuntime.forgejoToken` for exactly the origin it was
 * configured for (config.ts: `forgejoTokens`, PLANNOTATOR_FORGEJO_TOKEN with
 * PLANNOTATOR_FORGEJO_URL). Public repositories read without one; posting a
 * review needs one. The token is never logged, echoed, or put in an error
 * message, and is never sent to another origin: redirects are followed by hand
 * and only within the API origin.
 *
 * Scopes (routers/api/v1/api.go): the PR routes need `read:repository`, a
 * review post needs `write:repository`, issue comments need `read:issue`, and
 * `read:user` only lets the UI know who you are.
 *
 * Runtime-agnostic: `fetch` only. Vendored to Pi.
 */

import { join } from "path";
import { getPlannotatorDataDir } from "./data-dir";
import { getForgejoOrigin } from "./pr-types";
import type {
  ForgejoPRRef,
  PRContext,
  PRFileBytesResult,
  PRListItem,
  PRMetadata,
  PRReviewAction,
  PRReviewFileComment,
  PRReviewSubmissionResult,
  PRReviewThread,
  PRRuntime,
  PRTreeResult,
} from "./pr-types";

/** Scopes a Forgejo token needs for PR review. */
export const FORGEJO_TOKEN_SCOPES = ["read:repository", "write:repository", "read:issue"] as const;

export class ForgejoApiError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
    this.name = "ForgejoApiError";
  }
}

function missingTokenMessage(origin: string): string {
  // The config file this process reads: PLANNOTATOR_DATA_DIR moves it from ~/.plannotator.
  const configPath = join(getPlannotatorDataDir(), "config.json");
  return (
    `${origin} needs an access token for this. Create one on the instance (Settings, Applications) with the scopes ` +
    `${FORGEJO_TOKEN_SCOPES.join(", ")}, then add it under forgejoTokens in ${configPath} ` +
    `(\`{ "forgejoTokens": { "${origin}": "<token>" } }\`), or set PLANNOTATOR_FORGEJO_TOKEN and PLANNOTATOR_FORGEJO_URL=${origin}.`
  );
}

// --- HTTP ---

/**
 * Limits on every Forgejo request, after the house pattern (url-to-markdown.ts:
 * 30 s, 10 MB): one deadline per request, redirects and body included, and a
 * byte cap on each body. The diff and raw files get a larger cap than API JSON.
 * Exported so tests can lower them (and restore them); nothing else changes them.
 */
export const FORGEJO_LIMITS = {
  timeoutMs: 30_000,
  jsonMaxBytes: 10 * 1024 * 1024,
  diffMaxBytes: 50 * 1024 * 1024,
};

/** How much of a refusal's body is read for Forgejo's own message; the rest is dropped, not an error. */
const ERROR_BODY_MAX_BYTES = 64 * 1024;

const TIMEOUT_MESSAGE = "The Forgejo server took too long to answer.";

function sizeWords(bytes: number): string {
  const mb = 1024 * 1024;
  return bytes >= mb ? `${Math.round(bytes / mb)} MB` : `${bytes} bytes`;
}

/** A body over its cap. `size` is what was declared or read before the read stopped. */
class ForgejoTooLargeError extends ForgejoApiError {
  constructor(readonly size: number, max: number) {
    super(`The Forgejo server sent more than ${sizeWords(max)}.`, 413);
  }
}

interface FjContext {
  fetch: typeof fetch;
  /** `scheme://host[:port]` the review was opened on. */
  origin: string;
  apiBase: string;
  apiOrigin: string;
  /** The token configured for exactly this origin, or null (anonymous). */
  token: string | null;
}

function context(runtime: PRRuntime, ref: ForgejoPRRef): FjContext {
  const origin = getForgejoOrigin(ref);
  const apiBase = `${origin}/api/v1`;
  return {
    fetch: runtime.fetch ?? globalThis.fetch,
    origin,
    apiBase,
    apiOrigin: new URL(apiBase).origin,
    token: runtime.forgejoToken?.(origin) ?? null,
  };
}

/** Encode a repo-relative file path, segment by segment. */
function encodePath(path: string): string {
  return path.split("/").map(encodeURIComponent).join("/");
}

function repoPath(ref: ForgejoPRRef): string {
  return `/repos/${encodeURIComponent(ref.owner)}/${encodeURIComponent(ref.repo)}`;
}

function webUrl(ref: ForgejoPRRef): string {
  return `${getForgejoOrigin(ref)}/${ref.owner}/${ref.repo}/pulls/${ref.number}`;
}

/** A finished response: its status, headers and the body, read within its cap and the request's deadline. */
interface FjResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bytes(): Uint8Array;
  text(): string;
  json<T>(): T;
}

/** Forgejo's own error text from a JSON `{ message, url }` body, capped, without a trailing period (callers add their own). */
function errorDetail(res: FjResponse): string {
  const clean = (message: string) => message.trim().slice(0, 300).replace(/[.\s]+$/, "");
  const text = res.text();
  try {
    const parsed = JSON.parse(text) as { message?: unknown };
    if (typeof parsed.message === "string" && parsed.message) return clean(parsed.message);
  } catch { /* not JSON */ }
  return clean(text);
}

function failure(res: FjResponse, what: string, ctx: FjContext): ForgejoApiError {
  const detail = errorDetail(res);
  if (res.status === 401) {
    return new ForgejoApiError(
      ctx.token
        ? `Forgejo rejected the token for ${ctx.origin} (HTTP 401) while trying to ${what}${detail ? `: ${detail}` : ""}. It may be expired or revoked.`
        : missingTokenMessage(ctx.origin),
      401,
    );
  }
  if (res.status === 403) {
    // An instance that requires sign-in answers every anonymous API call with 403 ("Only signed in user is
    // allowed to call APIs"): with no token the fix is to add one, not to widen its scopes.
    if (!ctx.token) {
      return new ForgejoApiError(`Forgejo refused to ${what} (HTTP 403)${detail ? `: ${detail}` : ""}. ${missingTokenMessage(ctx.origin)}`, 403);
    }
    return new ForgejoApiError(
      `Forgejo refused to ${what} (HTTP 403)${detail ? `: ${detail}` : ""}. ` +
        `The token needs the scopes ${FORGEJO_TOKEN_SCOPES.join(", ")} and access to this repository.`,
      403,
    );
  }
  if (res.status === 404) {
    // Forgejo answers 404, not 401 or 403, for a repository it will not show you: a private one, or any
    // repository to a restricted account that has not been added to it, public ones included.
    return new ForgejoApiError(
      `Could not ${what}: not found (HTTP 404)${detail ? `: ${detail}` : ""}.` +
        (ctx.token
          ? " It may not exist, or the token's account may not be able to see it: a private repository, or a restricted account that has not been added to the repository (a restricted account cannot see public repositories either)."
          : ` If the repository is private, ${missingTokenMessage(ctx.origin)}`),
      404,
    );
  }
  if (res.status === 429) {
    const retryAfter = Number(res.headers.get("retry-after"));
    const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? `in ${Math.ceil(retryAfter)}s` : "in a minute";
    return new ForgejoApiError(`Forgejo rate-limited the request to ${what} (HTTP 429). Try again ${wait}.`, 429);
  }
  return new ForgejoApiError(`Failed to ${what}: Forgejo HTTP ${res.status}${detail ? `: ${detail}` : ""}`, res.status);
}

/**
 * Read a body, stopping (and cancelling it) once it passes `maxBytes`. Over
 * the cap it is an error, or with `truncate` just the first `maxBytes`.
 */
async function readBody(
  res: Response,
  maxBytes: number,
  truncate: boolean,
  race: <T>(p: Promise<T>) => Promise<T>,
): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) {
    const bytes = new Uint8Array(await race(res.arrayBuffer()));
    if (bytes.byteLength <= maxBytes) return bytes;
    if (truncate) return bytes.slice(0, maxBytes);
    throw new ForgejoTooLargeError(bytes.byteLength, maxBytes);
  }
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await race(reader.read());
      if (done) break;
      total += value.byteLength;
      chunks.push(value);
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        if (!truncate) throw new ForgejoTooLargeError(total, maxBytes);
        break;
      }
    }
  } catch (err) {
    await reader.cancel().catch(() => {});
    throw err;
  }
  const kept = Math.min(total, maxBytes);
  const bytes = new Uint8Array(kept);
  let offset = 0;
  for (const chunk of chunks) {
    if (offset >= kept) break;
    const part = chunk.subarray(0, kept - offset);
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
}

/**
 * One request to the API. `pathOrUrl` is API-relative ("/repos/…") or an
 * absolute URL on the API origin. Redirects are followed by hand and only
 * within the API origin, so the token never leaves it; a 303 continues as a
 * GET without the body. The whole request, redirects and body included, has
 * one deadline (`FORGEJO_LIMITS.timeoutMs`), and a successful body is capped
 * at `maxBytes` (API JSON's cap unless the caller names a larger one).
 */
async function request(
  ctx: FjContext,
  pathOrUrl: string,
  init: { method?: string; body?: unknown; accept?: string; maxBytes?: number } = {},
): Promise<FjResponse> {
  let url = pathOrUrl.startsWith("/") ? `${ctx.apiBase}${pathOrUrl}` : pathOrUrl;
  if (new URL(url).origin !== ctx.apiOrigin) {
    throw new ForgejoApiError(`Refusing to send a Forgejo request to ${new URL(url).origin}`, 400);
  }
  const maxBytes = init.maxBytes ?? FORGEJO_LIMITS.jsonMaxBytes;
  const headers: Record<string, string> = { Accept: init.accept ?? "application/json" };
  if (ctx.token) headers.Authorization = `token ${ctx.token}`;
  let method = init.method ?? "GET";
  let body = init.body !== undefined ? JSON.stringify(init.body) : undefined;
  if (body !== undefined) headers["Content-Type"] = "application/json";

  const controller = new AbortController();
  const timedOut = new Promise<never>((_, reject) => {
    controller.signal.addEventListener("abort", () => reject(new ForgejoApiError(TIMEOUT_MESSAGE, 504)), { once: true });
  });
  timedOut.catch(() => {});
  const timer = setTimeout(() => controller.abort(), FORGEJO_LIMITS.timeoutMs);
  const race = <T>(p: Promise<T>): Promise<T> => Promise.race([p, timedOut]);
  try {
    for (let hop = 0; hop < 5; hop++) {
      const res = await race(ctx.fetch(url, { method, headers, body, redirect: "manual", signal: controller.signal }));
      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (location) {
        await res.body?.cancel().catch(() => {});
        const next = new URL(location, url);
        if (next.origin !== ctx.apiOrigin) {
          // The same host on the other scheme (an http link to an https-only server): say which link to use.
          const scheme = next.protocol.replace(/:$/, "");
          if (next.host === new URL(ctx.apiOrigin).host && (scheme === "https" || scheme === "http")) {
            throw new ForgejoApiError(
              `Forgejo redirected off the API origin (${next.origin}): this server answers on ${scheme}. Use the PR's ${scheme}:// link (${next.origin}/…) instead.`,
              res.status,
            );
          }
          throw new ForgejoApiError(`Forgejo redirected off the API origin (${next.origin})`, res.status);
        }
        if (res.status === 303 && method !== "GET" && method !== "HEAD") {
          method = "GET";
          body = undefined;
          delete headers["Content-Type"];
        }
        url = next.toString();
        continue;
      }
      if (res.ok) {
        const declared = Number(res.headers.get("content-length"));
        if (Number.isFinite(declared) && declared > maxBytes) {
          await res.body?.cancel().catch(() => {});
          throw new ForgejoTooLargeError(declared, maxBytes);
        }
      }
      const bytes = await readBody(res, res.ok ? maxBytes : ERROR_BODY_MAX_BYTES, !res.ok, race);
      let decoded: string | undefined;
      const text = () => (decoded ??= new TextDecoder().decode(bytes));
      return {
        status: res.status,
        ok: res.ok,
        headers: res.headers,
        bytes: () => bytes,
        text,
        json: <T>() => JSON.parse(text()) as T,
      };
    }
    throw new ForgejoApiError("Too many Forgejo redirects", 508);
  } catch (err) {
    if (controller.signal.aborted && !(err instanceof ForgejoApiError)) throw new ForgejoApiError(TIMEOUT_MESSAGE, 504);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function json<T>(ctx: FjContext, path: string, what: string): Promise<T> {
  const res = await request(ctx, path);
  if (!res.ok) throw failure(res, what, ctx);
  return res.json<T>();
}

/** True when a `Link` header offers a next page, wherever its URL points (only its presence is read). */
function hasNextLink(res: FjResponse): boolean {
  const link = res.headers.get("link");
  return !!link && link.split(",").some((part) => /;\s*rel="next"/.test(part));
}

/** Items asked for per page; an instance may clamp it to its own maximum. */
const PAGE_LIMIT = 50;

/**
 * Every item of a list endpoint, paged by number (`limit` and `page`) on the
 * API origin the review was opened on, never on a URL the instance names: an
 * instance whose ROOT_URL differs from that origin (a proxy, a LAN name)
 * writes its `Link` URLs on its own address, and following them would stop or
 * leave the origin. The pages end at an empty page, at `X-Total-Count` items,
 * or when there is no total and the `Link` header offers no next page (a lone
 * page has neither). Capped at `maxPages`.
 */
async function paginate<T>(ctx: FjContext, path: string, what: string, maxPages = 20): Promise<T[]> {
  const out: T[] = [];
  const sep = path.includes("?") ? "&" : "?";
  for (let page = 1; page <= maxPages; page++) {
    const res = await request(ctx, `${path}${sep}limit=${PAGE_LIMIT}&page=${page}`);
    if (!res.ok) throw failure(res, what, ctx);
    const body = res.json<unknown>();
    const items = Array.isArray(body) ? (body as T[]) : [];
    if (items.length === 0) break;
    out.push(...items);
    const total = Number(res.headers.get("x-total-count"));
    if (res.headers.get("x-total-count") !== null && Number.isFinite(total)) {
      if (out.length >= total) break;
    } else if (!hasNextLink(res)) {
      break;
    }
  }
  return out;
}

// --- API shapes (only the fields read here) ---

interface FjUser {
  login?: string;
  username?: string;
  avatar_url?: string;
}

interface FjRepoRef {
  full_name?: string;
  default_branch?: string;
}

interface FjPullRequest {
  number: number;
  title?: string;
  body?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  mergeable?: boolean;
  changed_files?: number;
  merge_base?: string;
  html_url?: string;
  user?: FjUser | null;
  labels?: Array<{ name?: string; color?: string }>;
  requested_reviewers?: FjUser[] | null;
  requested_reviewers_teams?: Array<{ name?: string }> | null;
  base?: { ref?: string; sha?: string; repo?: FjRepoRef | null };
  head?: { ref?: string; sha?: string; repo?: FjRepoRef | null };
}

interface FjIssueComment {
  id: number;
  body?: string;
  html_url?: string;
  created_at?: string;
  user?: FjUser | null;
}

interface FjReview {
  id: number;
  state?: string;
  body?: string;
  html_url?: string;
  submitted_at?: string;
  comments_count?: number;
  dismissed?: boolean;
  stale?: boolean;
  user?: FjUser | null;
}

interface FjReviewComment {
  id: number;
  body?: string;
  path?: string;
  position?: number;
  original_position?: number;
  extra_lines_count?: number;
  diff_hunk?: string;
  html_url?: string;
  created_at?: string;
  pull_request_review_id?: number;
  resolver?: FjUser | null;
  user?: FjUser | null;
}

interface FjStatus {
  id?: number;
  context?: string;
  status?: string;
  target_url?: string;
  created_at?: string;
  updated_at?: string;
}

/**
 * The newest status of each context. `/commits/{sha}/statuses` is the whole
 * history (a context that failed, then passed, is in it twice, and every
 * earlier `pending` too); a check is only its latest entry, by id, then time.
 * Exported for tests.
 */
export function latestForgejoStatuses(history: FjStatus[]): FjStatus[] {
  const newer = (a: FjStatus, b: FjStatus) =>
    (a.id ?? 0) !== (b.id ?? 0) ? (a.id ?? 0) > (b.id ?? 0) : (a.updated_at ?? a.created_at ?? "") > (b.updated_at ?? b.created_at ?? "");
  const latest = new Map<string, FjStatus>();
  for (const status of history) {
    const key = status.context ?? "";
    const seen = latest.get(key);
    if (!seen || newer(status, seen)) latest.set(key, status);
  }
  return [...latest.values()];
}

function userName(u: FjUser | undefined | null): string {
  return u?.login || u?.username || "";
}

/**
 * A URL Forgejo hands back (a check's `target_url`, a comment's `html_url`, an
 * avatar) as the UI may link it: a relative one (Forgejo Actions writes
 * `/owner/repo/actions/runs/…`) resolved on the instance's origin, an absolute
 * one kept as given, anything but http(s) dropped (""). Without an origin a
 * relative URL is dropped too.
 */
function linkOn(origin: string | null, value: string | undefined | null): string {
  if (typeof value !== "string" || !value.trim()) return "";
  try {
    const url = origin ? new URL(value, `${origin}/`) : new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

function avatarOf(u: FjUser | undefined | null, origin: string | null): string | undefined {
  return linkOn(origin, u?.avatar_url) || undefined;
}

// --- Auth ---

/**
 * Anonymous reads work on a public repository, so a missing token does not stop
 * a review from opening; only posting needs one. With a token, the repository
 * read proves it is valid. (`GET /user` is not used: it needs the `read:user`
 * scope, which a repository-only token lacks.)
 */
export async function checkFjAuth(runtime: PRRuntime, ref: ForgejoPRRef): Promise<void> {
  const ctx = context(runtime, ref);
  if (!ctx.token) return;
  const res = await request(ctx, repoPath(ref));
  if (!res.ok) throw failure(res, "read the repository", ctx);
}

export async function getFjUser(runtime: PRRuntime, ref: ForgejoPRRef): Promise<string | null> {
  try {
    const ctx = context(runtime, ref);
    if (!ctx.token) return null;
    const user = await json<FjUser>(ctx, "/user", "read the current user");
    return userName(user) || null;
  } catch {
    return null;
  }
}

// --- Fetch PR ---

/** Number of files in a git-style patch. */
function countPatchFiles(patch: string): number {
  return (patch.match(/^diff --git /gm) ?? []).length;
}

export async function fetchFjPR(
  runtime: PRRuntime,
  ref: ForgejoPRRef,
): Promise<{ metadata: PRMetadata; rawPatch: string; patchIncomplete?: boolean }> {
  const ctx = context(runtime, ref);
  const prPath = `${repoPath(ref)}/pulls/${ref.number}`;
  const [pr, diffRes] = await Promise.all([
    json<FjPullRequest>(ctx, prPath, "fetch PR metadata"),
    request(ctx, `${prPath}.diff`, { accept: "text/plain", maxBytes: FORGEJO_LIMITS.diffMaxBytes }),
  ]);
  const headSha = pr.head?.sha;
  const baseSha = pr.base?.sha;
  if (!headSha || !baseSha) {
    throw new Error("PR has no head or base commit — its source branch may have been deleted.");
  }
  if (!diffRes.ok) throw failure(diffRes, "fetch the PR diff", ctx);
  const rawPatch = diffRes.text();

  let patchIncomplete = false;
  if (typeof pr.changed_files === "number") {
    const got = countPatchFiles(rawPatch);
    if (got < pr.changed_files) {
      console.error(
        `Warning: Forgejo reports ${pr.changed_files} changed files but the PR diff contains ${got}. The review is missing the remainder; the full diff can be recomputed locally once the checkout is ready.`,
      );
      patchIncomplete = true;
    }
  }

  const baseRepo = pr.base?.repo?.full_name;
  const headRepo = pr.head?.repo?.full_name;
  const metadata: PRMetadata = {
    platform: "forgejo",
    host: ref.host,
    ...(ref.scheme ? { scheme: ref.scheme } : {}),
    owner: ref.owner,
    repo: ref.repo,
    number: ref.number,
    title: pr.title ?? "",
    author: userName(pr.user),
    baseBranch: pr.base?.ref ?? "",
    headBranch: pr.head?.ref ?? "",
    ...(pr.base?.repo?.default_branch ? { defaultBranch: pr.base.repo.default_branch } : {}),
    baseSha,
    headSha,
    ...(pr.merge_base ? { mergeBaseSha: pr.merge_base } : {}),
    // Informational: a fork's head is fetched from refs/pull/N/head on the base repository either way.
    ...(headRepo && baseRepo && headRepo.toLowerCase() !== baseRepo.toLowerCase() ? { sourceRepo: headRepo } : {}),
    // Built from the URL the review was opened on, not from `html_url`: that is the instance's configured
    // ROOT_URL, which a proxy can make differ, and the artifact fetch must stay on the origin the token is for.
    url: webUrl(ref),
  };
  return { metadata, rawPatch, ...(patchIncomplete && { patchIncomplete }) };
}

// --- PR Context ---

function prState(pr: FjPullRequest): string {
  if (pr.merged === true) return "MERGED";
  return (pr.state ?? "").toLowerCase() === "closed" ? "CLOSED" : "OPEN";
}

/** Forgejo review states → the GitHub-shaped ones the UI reads. PENDING and REQUEST_REVIEW are not reviews yet. */
function reviewState(review: FjReview): string | null {
  if (review.dismissed === true) return "DISMISSED";
  switch ((review.state ?? "").toUpperCase()) {
    case "APPROVED": return "APPROVED";
    case "REQUEST_CHANGES": return "CHANGES_REQUESTED";
    case "COMMENT": return "COMMENTED";
    default: return null;
  }
}

const CHECK_CONCLUSION: Record<string, string> = {
  success: "SUCCESS",
  failure: "FAILURE",
  error: "FAILURE",
  warning: "NEUTRAL",
  skipped: "SKIPPED",
};

/**
 * Inline review comments grouped into threads. Forgejo's comment API carries no
 * thread id, so comments on the same path, side and line are one conversation.
 * `position` is the new-file line and `original_position` the old-file line
 * (the review-create options name them `new_position` / `old_position`); a
 * range comment is anchored on its first line with `extra_lines_count` more.
 * Exported for tests.
 */
export function mapForgejoThreads(
  raw: FjReviewComment[],
  staleReviews: ReadonlySet<number> = new Set(),
  /** The instance origin relative links resolve on; without it a relative link is dropped. */
  origin: string | null = null,
): PRReviewThread[] {
  const threads = new Map<string, PRReviewThread & { createdAt: string }>();
  const sorted = [...raw].sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? "") || a.id - b.id);
  for (const c of sorted) {
    const path = c.path ?? "";
    const right = (c.position ?? 0) > 0;
    const anchor = right ? (c.position ?? 0) : (c.original_position ?? 0);
    if (!path || anchor <= 0) continue;
    const side: "LEFT" | "RIGHT" = right ? "RIGHT" : "LEFT";
    const key = `${path}\u0000${side}\u0000${anchor}`;
    const comment = {
      id: String(c.id),
      author: userName(c.user),
      ...(avatarOf(c.user, origin) ? { avatarUrl: avatarOf(c.user, origin) } : {}),
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
      url: linkOn(origin, c.html_url),
      ...(c.diff_hunk ? { diffHunk: c.diff_hunk } : {}),
    };
    const existing = threads.get(key);
    if (existing) {
      existing.comments.push(comment);
      if (c.resolver) existing.isResolved = true;
      if (c.pull_request_review_id !== undefined && !staleReviews.has(c.pull_request_review_id)) existing.isOutdated = false;
      continue;
    }
    const extra = c.extra_lines_count ?? 0;
    threads.set(key, {
      id: String(c.id),
      isResolved: !!c.resolver,
      isOutdated: c.pull_request_review_id !== undefined && staleReviews.has(c.pull_request_review_id),
      path,
      line: extra > 0 ? anchor + extra : anchor,
      startLine: extra > 0 ? anchor : null,
      diffSide: side,
      comments: [comment],
      createdAt: comment.createdAt,
    });
  }
  return [...threads.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map(({ createdAt: _createdAt, ...thread }) => thread);
}

/** One request per review that has inline comments, a few at a time. */
async function fetchReviewComments(ctx: FjContext, prPath: string, reviews: FjReview[]): Promise<FjReviewComment[]> {
  const withComments = reviews.filter((r) => (r.comments_count ?? 0) > 0).slice(0, 100);
  const out: FjReviewComment[] = [];
  for (let i = 0; i < withComments.length; i += 5) {
    const batch = await Promise.all(
      withComments.slice(i, i + 5).map((r) =>
        paginate<FjReviewComment>(ctx, `${prPath}/reviews/${r.id}/comments`, "fetch review comments", 5).catch(() => []),
      ),
    );
    for (const comments of batch) out.push(...comments);
  }
  return out;
}

/** Pages of status history read: the newest per context is kept, so the whole history is read, up to this. */
const FJ_STATUS_MAX_PAGES = 10;

export async function fetchFjPRContext(runtime: PRRuntime, ref: ForgejoPRRef): Promise<PRContext> {
  const ctx = context(runtime, ref);
  const prPath = `${repoPath(ref)}/pulls/${ref.number}`;
  const pr = await json<FjPullRequest>(ctx, prPath, "fetch PR context");
  const [issueComments, reviews, statuses] = await Promise.all([
    paginate<FjIssueComment>(ctx, `${repoPath(ref)}/issues/${ref.number}/comments`, "fetch PR comments").catch(() => []),
    paginate<FjReview>(ctx, `${prPath}/reviews`, "fetch PR reviews").catch(() => []),
    pr.head?.sha
      ? paginate<FjStatus>(ctx, `${repoPath(ref)}/commits/${encodeURIComponent(pr.head.sha)}/statuses`, "fetch PR statuses", FJ_STATUS_MAX_PAGES).catch(() => [])
      : Promise.resolve([] as FjStatus[]),
  ]);
  const reviewComments = await fetchReviewComments(ctx, prPath, reviews).catch(() => []);
  const staleReviews = new Set(reviews.filter((r) => r.stale === true).map((r) => r.id));

  const mappedReviews: PRContext["reviews"] = [];
  const latestDecision = new Map<string, string>();
  for (const r of [...reviews].sort((a, b) => (a.submitted_at ?? "").localeCompare(b.submitted_at ?? ""))) {
    const state = reviewState(r);
    if (!state) continue;
    const avatarUrl = avatarOf(r.user, ctx.origin);
    mappedReviews.push({
      id: String(r.id),
      author: userName(r.user),
      ...(avatarUrl ? { avatarUrl } : {}),
      state,
      body: r.body ?? "",
      submittedAt: r.submitted_at ?? "",
      ...(linkOn(ctx.origin, r.html_url) ? { url: linkOn(ctx.origin, r.html_url) } : {}),
    });
    // A comment-only review does not change a person's standing; a dismissed one clears it.
    if (state === "APPROVED" || state === "CHANGES_REQUESTED") latestDecision.set(userName(r.user), state);
    else if (state === "DISMISSED") latestDecision.delete(userName(r.user));
  }
  const decisions = [...latestDecision.values()];
  const reviewDecision = decisions.includes("CHANGES_REQUESTED") ? "CHANGES_REQUESTED" : decisions.includes("APPROVED") ? "APPROVED" : "";

  const requestedReviewers: NonNullable<PRContext["requestedReviewers"]> = [
    ...(pr.requested_reviewers ?? []).map((u) => ({ login: userName(u), ...(avatarOf(u, ctx.origin) ? { avatarUrl: avatarOf(u, ctx.origin) } : {}) })),
    ...(pr.requested_reviewers_teams ?? []).filter((t) => t.name).map((t) => ({ login: t.name as string, isTeam: true })),
  ].filter((r) => r.login);

  return {
    body: pr.body ?? "",
    state: prState(pr),
    isDraft: pr.draft === true,
    labels: (pr.labels ?? []).map((l) => ({ name: l.name ?? "", color: (l.color ?? "").replace(/^#/, "") })).filter((l) => l.name),
    reviewDecision,
    mergeable: pr.mergeable === true ? "MERGEABLE" : pr.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    mergeStateStatus: "UNKNOWN",
    comments: issueComments.map((c) => ({
      id: String(c.id),
      author: userName(c.user),
      ...(avatarOf(c.user, ctx.origin) ? { avatarUrl: avatarOf(c.user, ctx.origin) } : {}),
      body: c.body ?? "",
      createdAt: c.created_at ?? "",
      url: linkOn(ctx.origin, c.html_url),
    })),
    reviews: mappedReviews,
    reviewThreads: mapForgejoThreads(reviewComments, staleReviews, ctx.origin),
    checks: latestForgejoStatuses(statuses).map((s) => {
      const state = (s.status ?? "").toLowerCase();
      const complete = state !== "pending";
      return {
        name: s.context ?? "",
        status: complete ? "COMPLETED" : "IN_PROGRESS",
        conclusion: complete ? (CHECK_CONCLUSION[state] ?? state.toUpperCase()) : null,
        workflowName: "",
        detailsUrl: linkOn(ctx.origin, s.target_url),
      };
    }),
    linkedIssues: [],
    requestedReviewers,
  };
}

// --- Files ---

function rawFilePath(ref: ForgejoPRRef, sha: string, filePath: string): string {
  return `${repoPath(ref)}/raw/${encodePath(filePath)}?ref=${encodeURIComponent(sha)}`;
}

/** Pages of `git/trees/<sha>?recursive=true` the tree listing follows before calling it truncated. */
const FJ_TREE_MAX_PAGES = 100;

/** Every file of one commit through the git trees API, paged. Past the page budget the list is partial. */
export async function fetchFjTree(runtime: PRRuntime, ref: ForgejoPRRef, sha: string): Promise<PRTreeResult | null> {
  try {
    const ctx = context(runtime, ref);
    const paths: string[] = [];
    let truncated = false;
    for (let page = 1; ; page++) {
      if (page > FJ_TREE_MAX_PAGES) {
        truncated = true;
        break;
      }
      const body = await json<{ tree?: Array<{ type?: string; path?: string }>; truncated?: boolean }>(
        ctx,
        `${repoPath(ref)}/git/trees/${encodeURIComponent(sha)}?recursive=true&per_page=1000&page=${page}`,
        "list files",
      );
      for (const entry of body.tree ?? []) {
        if (entry.type === "blob" && typeof entry.path === "string") paths.push(entry.path);
      }
      if (body.truncated !== true) break;
    }
    return { paths, truncated };
  } catch {
    return null;
  }
}

export async function fetchFjFileContent(
  runtime: PRRuntime,
  ref: ForgejoPRRef,
  sha: string,
  filePath: string,
): Promise<string | null> {
  try {
    const ctx = context(runtime, ref);
    const res = await request(ctx, rawFilePath(ref, sha, filePath), { accept: "*/*", maxBytes: FORGEJO_LIMITS.diffMaxBytes });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  }
}

/** One file at one commit as raw bytes (image preview). A declared size over the cap is never downloaded. */
export async function fetchFjFileBytes(
  runtime: PRRuntime,
  ref: ForgejoPRRef,
  sha: string,
  filePath: string,
  maxBytes: number,
): Promise<PRFileBytesResult> {
  const ctx = context(runtime, ref);
  let res: FjResponse;
  try {
    res = await request(ctx, rawFilePath(ref, sha, filePath), { accept: "*/*", maxBytes });
  } catch (err) {
    if (err instanceof ForgejoTooLargeError) return { kind: "too-large", size: err.size };
    throw err;
  }
  if (res.status === 404) return { kind: "missing" };
  if (!res.ok) throw failure(res, "read file contents", ctx);
  return { kind: "ok", bytes: res.bytes() };
}

// --- Submit Review ---

/** Forgejo's review event for each decision. Anything else makes Forgejo save a pending review that is never submitted. */
const REVIEW_EVENT: Record<PRReviewAction, string> = {
  approve: "APPROVED",
  comment: "COMMENT",
  request_changes: "REQUEST_CHANGES",
};

/** Used when a review has inline comments but no summary: request-changes needs a body. */
const BODY_PLACEHOLDER = "See inline comments.";

/**
 * The `comments[]` entry Forgejo expects for one line comment: `new_position`
 * for a line of the new file, `old_position` for the old one (the other is 0).
 * A range is anchored on its first line with `extra_lines_count` more; a range
 * that starts on the other side cannot be expressed, so it is posted on its
 * last line alone. Exported for tests.
 */
export function forgejoInlineAnchor(comment: PRReviewFileComment): Record<string, unknown> {
  const startSide = comment.start_side ?? comment.side;
  const ranged = comment.start_line != null && comment.start_line !== comment.line && startSide === comment.side;
  const first = ranged ? Math.min(comment.start_line as number, comment.line) : comment.line;
  const extra = ranged ? Math.abs(comment.line - (comment.start_line as number)) : 0;
  return {
    path: comment.path,
    body: comment.body,
    new_position: comment.side === "LEFT" ? 0 : first,
    old_position: comment.side === "LEFT" ? first : 0,
    extra_lines_count: extra,
  };
}

/**
 * Post a review to a Forgejo PR as one `POST /pulls/{n}/reviews`: the decision
 * (`event`), the summary and every line comment together. Forgejo checks the
 * event and body before it writes anything (a review of your own PR, or a
 * request-changes with no body, answers 422), so a refused review posts
 * nothing and the error carries Forgejo's own reason. File-level comments are
 * folded into the body by the caller (`fileLevelComments: false`).
 */
export async function submitFjPRReview(
  runtime: PRRuntime,
  ref: ForgejoPRRef,
  headSha: string,
  action: PRReviewAction,
  body: string,
  fileComments: PRReviewFileComment[],
): Promise<PRReviewSubmissionResult> {
  const ctx = context(runtime, ref);
  if (!ctx.token) throw new ForgejoApiError(missingTokenMessage(ctx.origin), 401);
  let summary = body.trim();
  if (!summary && action === "request_changes" && fileComments.length === 0) {
    throw new ForgejoApiError("Forgejo needs a comment to request changes: write a summary or add an inline comment.", 422);
  }
  if (!summary && (action === "request_changes" || (action === "comment" && fileComments.length > 0))) {
    summary = BODY_PLACEHOLDER;
  }
  const res = await request(ctx, `${repoPath(ref)}/pulls/${ref.number}/reviews`, {
    method: "POST",
    body: {
      event: REVIEW_EVENT[action],
      body: summary,
      commit_id: headSha,
      comments: fileComments.map(forgejoInlineAnchor),
    },
  });
  if (!res.ok) {
    const what = action === "approve" ? "approve the PR" : action === "request_changes" ? "request changes on the PR" : "post the review";
    throw failure(res, what, ctx);
  }
  return { status: "complete" };
}

// --- PR List ---

export async function fetchFjPRList(runtime: PRRuntime, ref: ForgejoPRRef): Promise<PRListItem[]> {
  try {
    const ctx = context(runtime, ref);
    const res = await request(ctx, `${repoPath(ref)}/pulls?state=all&sort=recentupdate&limit=30`);
    if (!res.ok) return [];
    const list = res.json<FjPullRequest[]>();
    return (Array.isArray(list) ? list : []).map((pr) => ({
      id: String(pr.number),
      number: pr.number,
      title: pr.title ?? "",
      author: userName(pr.user),
      url: webUrl({ ...ref, number: pr.number }),
      baseBranch: pr.base?.ref ?? "",
      state: pr.merged === true ? "merged" : (pr.state ?? "").toLowerCase() === "closed" ? "closed" : "open",
    }));
  } catch {
    return [];
  }
}
