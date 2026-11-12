/**
 * Hover cards for issue, pull request and merge request links.
 *
 * A link the UI already draws (a bare `#123` linked through `forgeRefLinks`,
 * or a pasted `https://github.com/o/r/pull/123` or
 * `https://gitlab.com/g/p/-/merge_requests/7`) is read back into a
 * `ForgeRef`; a host fetches the card's data for it. Browser-safe and
 * dependency-free: the UI parses hrefs with it and the server checks the same
 * shape before it runs anything.
 */

import { classifyForgeHost, type ForgePlatform } from "./forge-refs";

export type { ForgePlatform } from "./forge-refs";

/**
 * One issue or pull/merge request, as a link names it. On GitHub `kind` is a
 * hint (GitHub redirects /issues/N to /pull/N, so the answer decides); on
 * GitLab issues and merge requests are numbered apart, so it is exact.
 */
export interface ForgeRef {
  platform: ForgePlatform;
  host: string;
  /** GitHub: the owner. GitLab: the namespace (`group/sub`). */
  owner: string;
  repo: string;
  number: number;
  kind: "issue" | "pull";
}

const NAME = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^[1-9]\d{0,9}$/;

/**
 * Read an href back into a ref, or null:
 * - GitHub: `https://<host>/<owner>/<repo>/(issues|pull|pulls)/<n>`
 * - GitLab: `https://<host>/<namespace>/<project>/-/(issues|work_items|merge_requests)/<n>`
 * A trailing `/files`, `?query` or `#fragment` is ignored. Only https, no
 * credentials, no port.
 */
export function parseForgeRefUrl(href: string): ForgeRef | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) return null;
  const host = webForgeHost(url.hostname);
  if (!host) return null;
  const platform = classifyForgeHost(host);
  if (!platform) return null;
  const parts = url.pathname.split("/").filter(Boolean);
  let owner: string;
  let repo: string | undefined;
  let kindPart: string | undefined;
  let num: string | undefined;
  if (platform === "github") {
    [owner, repo, kindPart, num] = parts as [string, string?, string?, string?];
  } else {
    const dash = parts.indexOf("-");
    if (dash < 2) return null;
    owner = parts.slice(0, dash - 1).join("/");
    repo = parts[dash - 1];
    kindPart = parts[dash + 1];
    num = parts[dash + 2];
  }
  if (!owner || !repo || !kindPart || !num || !NUMBER.test(num)) return null;
  if (!owner.split("/").every((p) => NAME.test(p)) || !NAME.test(repo)) return null;
  const kind = refKindOf(platform, kindPart);
  if (!kind) return null;
  return { platform, host, owner, repo, number: Number(num), kind };
}

/**
 * A web link's host, exactly as written. Not `normalizeForgeHost`: its folding of SSH aliases
 * (`github.com-work`, `ssh.github.com`) is for git remotes, and in a web link it would read
 * `https://github.com-evil.example/o/r/pull/1` as github.com. A host that only starts like a
 * public forge (`github.com-…`, `github.com.…`) is no forge at all.
 */
export function webForgeHost(hostname: string): string | null {
  const h = hostname.toLowerCase();
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes(".")) return null;
  if (/^(github|gitlab)\.com[.-]/.test(h)) return null;
  return h;
}

function refKindOf(platform: ForgePlatform, part: string): ForgeRef["kind"] | null {
  if (platform === "github") return part === "issues" ? "issue" : part === "pull" || part === "pulls" ? "pull" : null;
  return part === "issues" || part === "work_items" ? "issue" : part === "merge_requests" ? "pull" : null;
}

/** One cache entry per ref. On GitHub an issue link to a PR is the same item, so the kind is not part of it there. */
export function forgeRefKey(ref: Pick<ForgeRef, "platform" | "host" | "owner" | "repo" | "number" | "kind">): string {
  const kind = ref.platform === "gitlab" ? `:${ref.kind}` : "";
  return `${ref.host}/${ref.owner}/${ref.repo}#${ref.number}${kind}`.toLowerCase();
}

/** How the forge itself writes the number: `!7` for a GitLab merge request, `#7` otherwise. */
export function forgeRefLabel(ref: Pick<ForgeRef, "platform" | "kind" | "number">): string {
  return `${ref.platform === "gitlab" && ref.kind === "pull" ? "!" : "#"}${ref.number}`;
}

export interface ForgeRefPerson {
  login: string;
  /** A `data:` image (the server inlines it) or null: the card draws the initial. */
  avatarUrl: string | null;
}

export interface ForgeRefLabel {
  name: string;
  /** Six hex digits, no `#`. */
  color: string;
}

export interface ForgeRefLinked {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  url: string;
}

export interface ForgeRefChecks {
  /** The overall verdict; null when the forge reported none. */
  state: "success" | "failure" | "pending" | null;
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

/** What the card shows. Text fields are untrusted (written by anyone who can comment on the repo). */
export interface ForgeRefCardData {
  platform: ForgePlatform;
  kind: "issue" | "pull";
  /** `owner/repo`, or a GitLab project's full path. */
  repo: string;
  number: number;
  url: string;
  title: string;
  /** Issue: open | completed | not_planned | closed. Pull/merge request: open | draft | merged | closed. */
  state: "open" | "draft" | "merged" | "closed" | "completed" | "not_planned";
  author: ForgeRefPerson | null;
  createdAt: string;
  updatedAt: string;
  /** When it closed or merged, or null. */
  closedAt: string | null;
  labels: ForgeRefLabel[];
  assignees: ForgeRefPerson[];
  comments: number;
  /** Markdown, cut at `FORGE_REF_BODY_MAX` characters (`bodyCut` says so). */
  body: string;
  bodyCut: boolean;
  /** The latest comment by a person (never a system note), cut at `FORGE_REF_COMMENT_MAX`. */
  lastComment: { author: ForgeRefPerson | null; at: string; body: string } | null;
  /** Issues it closes (a PR) or PRs that close it (an issue). GitHub only; empty when the forge does not say. */
  linked: ForgeRefLinked[];
  pull?: {
    base: string;
    head: string;
    additions: number;
    deletions: number;
    files: number;
    review: "approved" | "changes_requested" | "review_required" | null;
    /** GitHub: the head commit's checks. GitLab: the head pipeline's jobs. */
    checks: ForgeRefChecks | null;
  };
}

export type ForgeRefCardError =
  /** No forge CLI (gh, glab) on this computer. */
  | "cli_missing"
  /** The CLI is not signed in to that host. */
  | "signed_out"
  /** No signed-in account can see it (private, or the number is wrong). */
  | "not_found"
  /** Rate limited: try later. */
  | "rate_limited"
  /** A host this computer does not fetch from: the card is not shown. */
  | "unsupported"
  /** Anything else (offline, a timeout). */
  | "unavailable";

export type ForgeRefCardResult =
  | { ok: true; data: ForgeRefCardData; fetchedAt: number }
  | { ok: false; error: ForgeRefCardError; fetchedAt: number };

export const FORGE_REF_BODY_MAX = 4000;
export const FORGE_REF_COMMENT_MAX = 600;

const SHORT_GITHUB_PULL = /^([A-Za-z0-9_.-]{1,100})\/([A-Za-z0-9_.-]{1,100})#([1-9]\d{0,9})$/;
const SHORT_GITLAB_PULL = /^([A-Za-z0-9_.-]{1,100}(?:\/[A-Za-z0-9_.-]{1,100})*)\/([A-Za-z0-9_.-]{1,100})!([1-9]\d{0,9})$/;

/**
 * A pull or merge request as an agent or the person names one for a thread
 * (the Inbox's PR coupling), or null: `owner/repo#123` (github.com),
 * `group/sub/project!45` (gitlab.com), or the PR's or MR's URL on any GitHub
 * or GitLab host. An issue link, a bare `#123` and anything else are not one.
 */
export function parseForgePullRef(text: string): ForgeRef | null {
  const value = text.trim();
  if (/^https:\/\//i.test(value)) {
    const ref = parseForgeRefUrl(value);
    return ref && ref.kind === "pull" ? ref : null;
  }
  const github = SHORT_GITHUB_PULL.exec(value);
  if (github && github[1] !== "." && github[1] !== ".." && github[2] !== "." && github[2] !== "..") {
    return { platform: "github", host: "github.com", owner: github[1]!, repo: github[2]!, number: Number(github[3]), kind: "pull" };
  }
  const gitlab = SHORT_GITLAB_PULL.exec(value);
  if (gitlab && ![...gitlab[1]!.split("/"), gitlab[2]!].some((part) => part === "." || part === "..")) {
    return { platform: "gitlab", host: "gitlab.com", owner: gitlab[1]!, repo: gitlab[2]!, number: Number(gitlab[3]), kind: "pull" };
  }
  return null;
}

/** A pull or merge request's web address. */
export function forgePullUrl(ref: Pick<ForgeRef, "platform" | "host" | "owner" | "repo" | "number">): string {
  return `https://${ref.host}/${ref.owner}/${ref.repo}/${ref.platform === "gitlab" ? "-/merge_requests" : "pull"}/${ref.number}`;
}

/**
 * How an agent writes a pull or merge request back: `owner/repo#123` on
 * github.com, `group/project!45` on gitlab.com, the URL on any other host
 * (the short forms name only those two).
 */
export function forgePullRefText(ref: Pick<ForgeRef, "platform" | "host" | "owner" | "repo" | "number">): string {
  if (ref.platform === "github" && ref.host === "github.com") return `${ref.owner}/${ref.repo}#${ref.number}`;
  if (ref.platform === "gitlab" && ref.host === "gitlab.com") return `${ref.owner}/${ref.repo}!${ref.number}`;
  return forgePullUrl(ref);
}
