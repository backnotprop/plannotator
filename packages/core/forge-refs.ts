/**
 * Which forge a git remote lives on, and where bare `#123` / `@user`
 * references in a document should link to (#1596).
 *
 * Browser-safe and dependency-free: the UI resolves ref links with it, and the
 * server-side commit-avatar lookup classifies remotes with the same rule.
 */

export type ForgePlatform = "github" | "gitlab" | "bitbucket";

/** How each forge names and addresses its pull requests and issues. */
export interface ForgeSpec {
  name: string;
  /** What the forge calls a pull request. */
  pullName: "Pull request" | "Merge request";
  /** The mark before a pull request's number: GitLab writes `!7`. */
  pullMark: "#" | "!";
  /** The path between a repository and a pull request's number. */
  pullPath: string;
  /** Issues and pull requests are numbered apart, so a ref's key carries its kind. */
  numbersByKind: boolean;
}

export const FORGE_SPECS: Readonly<Record<ForgePlatform, ForgeSpec>> = {
  github: { name: "GitHub", pullName: "Pull request", pullMark: "#", pullPath: "pull", numbersByKind: false },
  gitlab: { name: "GitLab", pullName: "Merge request", pullMark: "!", pullPath: "-/merge_requests", numbersByKind: true },
  bitbucket: { name: "Bitbucket", pullName: "Pull request", pullMark: "#", pullPath: "pull-requests", numbersByKind: true },
};

/**
 * Canonicalize a remote host before classifying it: lowercase, drop a port,
 * and fold the well-known aliases of the public forges (`www.github.com`,
 * `ssh.github.com`, SSH-config aliases like `github.com-work`,
 * `altssh.gitlab.com`) onto their canonical host. Returns null for anything
 * that is not a plausible DNS name (no dot, brackets, `@`, ...): such a host
 * is a local SSH alias or a parse artifact that says nothing reliable about
 * the forge, so callers treat it as absent.
 */
export function normalizeForgeHost(host: string | null | undefined): string | null {
  if (!host) return null;
  let h = host.trim().toLowerCase().replace(/:\d+$/, "");
  if (h === "www.github.com" || h === "ssh.github.com" || h.startsWith("github.com-")) {
    h = "github.com";
  } else if (h === "altssh.gitlab.com") {
    h = "gitlab.com";
  }
  if (!/^[a-z0-9.-]+$/.test(h) || !h.includes(".")) return null;
  return h;
}

/**
 * Classify a remote host by name: exact/prefix github is GitHub (github.com
 * and GitHub Enterprise hosts like `github.acme.com`); a host with a label
 * (before its last) that is `gitlab` or starts `gitlab-` is GitLab
 * (gitlab.com, `gitlab.acme.dev`, `code.gitlab.acme.dev`,
 * `gitlab-master.example.com`), and so is a host learned as one
 * (`learnGitlabHosts`); bitbucket.org is Bitbucket Cloud (Bitbucket Data
 * Center has another API and is not one). A structured match, not a bare
 * substring: `mygitlabproxy.example.com` does not qualify. Opaque
 * self-hosted names return null.
 */
export function classifyForgeHost(host: string): ForgePlatform | null {
  if (host === "github.com" || host.startsWith("github.")) return "github";
  if (host === "bitbucket.org") return "bitbucket";
  if (host.split(".").slice(0, -1).some(gitlabLabel) || knownGitlabHosts.has(host)) return "gitlab";
  return null;
}

const gitlabLabel = (label: string): boolean => label === "gitlab" || label.startsWith("gitlab-");

let knownGitlabHosts: ReadonlySet<string> = new Set();
const knownGitlabListeners = new Set<() => void>();

export function learnGitlabHosts(hosts: Iterable<string>): void {
  const next = new Set([...hosts].map((host) => host.toLowerCase()));
  if (next.size === knownGitlabHosts.size && [...next].every((host) => knownGitlabHosts.has(host))) return;
  knownGitlabHosts = next;
  for (const listener of knownGitlabListeners) listener();
}

export function subscribeGitlabHosts(listener: () => void): () => void {
  knownGitlabListeners.add(listener);
  return () => knownGitlabListeners.delete(listener);
}

export function gitlabHostsSnapshot(): ReadonlySet<string> {
  return knownGitlabHosts;
}

export interface ForgeRefLinks {
  issue(num: string | number): string;
  user(handle: string): string;
  /** GitLab's `!N`: the project's merge request N. Null on GitHub, where `!N` is no ref. */
  mergeRequest: ((num: string | number) => string) | null;
}

/**
 * Link builders for inline issue and mention refs, or null when refs should
 * render unlinked.
 *
 * - `display` without a `/` (a directory-name fallback, not a remote path) → null.
 * - `host` absent, or not a plausible DNS name after `normalizeForgeHost`
 *   → github.com, the behavior before hosts were known (older servers, host
 *   apps that pass no host, and SSH aliases like `git@work-gh:o/r`).
 * - GitHub-like host → `https://<host>/<path>/issues/N`.
 * - GitLab-like host → `https://<host>/<path>/-/issues/N`, and `!N` to
 *   `https://<host>/<path>/-/merge_requests/N` (`mergeRequest`).
 * - Bitbucket, or any other host → null: a wrong-forge link is worse than no
 *   link, and a Bitbucket repository's `#N` may name a pull request or an
 *   issue (numbered apart, the issue tracker often off).
 */
export function forgeRefLinks(repo: { display?: string; host?: string }): ForgeRefLinks | null {
  const path = repo.display;
  if (!path || !path.includes("/")) return null;
  const host = normalizeForgeHost(repo.host) ?? "github.com";
  const platform = classifyForgeHost(host);
  if (platform !== "github" && platform !== "gitlab") return null;
  const base = `https://${host}`;
  const issues = platform === "gitlab" ? `${base}/${path}/-/issues` : `${base}/${path}/issues`;
  return {
    issue: (num) => `${issues}/${num}`,
    user: (handle) => `${base}/${handle}`,
    mergeRequest: platform === "gitlab" ? (num) => `${base}/${path}/${FORGE_SPECS.gitlab.pullPath}/${num}` : null,
  };
}

/**
 * The grammar of a short ref, shared by the prose renderer (below) and the
 * Inbox's thread PRs (`parseForgePullRef`): a path part, and a number with
 * no leading zero.
 */
const PATH_PART = "[A-Za-z0-9_.-]{1,100}";
const REF_NUMBER = "[1-9]\\d{0,9}";
const GITLAB_SHORT_MR = new RegExp(`^(${PATH_PART}(?:\\/${PATH_PART})*)\\/(${PATH_PART})!(${REF_NUMBER})$`);

/**
 * GitLab's `group/sub/project!45`, the whole of `text`, or null: the
 * namespace (`group/sub`), the project and the number. No part is `.` or `..`.
 */
export function readGitlabShortMr(text: string): { namespace: string; project: string; number: number } | null {
  const m = GITLAB_SHORT_MR.exec(text);
  if (!m || [...m[1]!.split("/"), m[2]!].some((part) => part === "." || part === "..")) return null;
  return { namespace: m[1]!, project: m[2]!, number: Number(m[3]) };
}

/**
 * GitLab's bare `!123`, at the start of the text: the merge request of the
 * project. The caller keeps the boundary `#123` has (no letter, digit or `_`
 * before it), and only a GitLab project links it (`forgeRefLinks().mergeRequest`).
 * `!123abc`, `!important` and `!0` are no refs.
 */
export const BARE_MR_REF = new RegExp(`^!(${REF_NUMBER})(?!\\w)`);

/**
 * A cross-repo `owner/repo#123` ref: GitHub's standard form, and GitLab's
 * `group/project#123`; and GitLab's merge request `group/sub/project!45`, its
 * namespace as deep as GitLab nests groups (`#` takes two parts only: a
 * subgroup issue ref stays plain). The first part starts with a letter or
 * digit and has no dot (GitHub owners never do), so `_italic_`, `-flag/x#1`
 * and schemeless hosts (`example.com/page#1`, `www.x.org/a!2`) are never
 * refs. The lookbehind keeps a match out of the middle of a longer path, URL
 * or address (`a/owner/repo#1`, `x.owner/repo#1`, `john@owner/repo#1`).
 * Groups: first part, the `/part`s after it, the mark, the number.
 */
const MORE_PARTS = 21;
export const CROSS_REPO_REF_PATTERN = new RegExp(
  `(?<![\\w./@-])([A-Za-z0-9][A-Za-z0-9_-]{0,99})((?:\\/[A-Za-z0-9_.][A-Za-z0-9_.-]{0,99}){1,${MORE_PARTS}})([#!])(${REF_NUMBER})(?!\\w)`,
);
const CROSS_REPO_REF_AT_START = new RegExp(`^${CROSS_REPO_REF_PATTERN.source.replace("(?<![\\w./@-])", "")}`);

/**
 * A repo part that reads as a file, so `docs/guide.md#2` or `src/app.ts#12`
 * is a path with a fragment, not a ref; and `owner/repo.git#4`, a clone URL's
 * tail. Repos really named like that (`necolas/normalize.css`) stay plain
 * text. `.js` is left out on purpose: repos such as `vercel/next.js` and
 * `mrdoob/three.js` are named that way (a `.js` path a viewer knows as a file
 * stays a file: InlineMarkdown checks that).
 */
const FILE_LIKE_REPO =
  /\.(?:git|mdx?|markdown|txt|html?|rst|adoc|[cm]?ts|tsx|jsx|mjs|cjs|py|rb|go|rs|java|c|cpp|h|hpp|cs|swift|kt|scala|sh|bash|zsh|sql|graphql|json|ya?ml|toml|ini|css|scss|less|xml|tf|lua|dart|ex|exs|vue|svelte|astro|zig|proto|lock|log|csv|pdf|png|jpe?g|gif|svg)$/i;

/** Prose pairs written with a slash (`and/or#1` in a list is not a repo). */
const PROSE_PAIRS = new Set(["and/or", "either/or", "he/she", "his/her", "him/her", "s/he", "yes/no", "on/off", "true/false", "read/write", "input/output", "i/o", "before/after", "pros/cons", "client/server"]);

export interface CrossRepoRef {
  /** The ref as written: `owner/repo#123`, `group/sub/project!45`. */
  label: string;
  /** `owner/repo`, `group/sub/project`: the part a viewer may also know as a file path. */
  path: string;
  /** Where it links, or null when no link can be built (an unknown self-hosted forge). */
  href: string | null;
}

/**
 * Read an `owner/repo#123` ref, or a GitLab `group/sub/project!45`, at the
 * start of `text`, or null. `previousChar` is the character before `text`
 * (empty at the start): a ref never continues a word, path, URL or address.
 *
 * The link follows `forgeRefLinks`' host rule for the document's project: its
 * host when that is GitHub or GitLab, github.com when the project names no
 * host, and no link for an unknown self-hosted host. GitHub redirects
 * `/issues/N` to `/pull/N`, so one URL serves both. A `!45` is a ref only
 * when that host is a GitLab (its own host, self-hosted too): anywhere else it
 * is no ref at all. A caller that does not know its project at all passes no
 * project and gets no ref. A caller that names no repo but guesses a host
 * (the Inbox's `crossRepoRefsWithoutRepo`) passes `withoutRepo`: `!45` forms
 * need a real GitLab project, so they stay plain there; `owner/repo#123` links
 * on the guessed host as before.
 */
export function matchCrossRepoRef(
  text: string,
  previousChar: string,
  project: { host?: string; withoutRepo?: boolean },
): CrossRepoRef | null {
  if (previousChar && /[\w./@-]/.test(previousChar)) return null;
  const m = text.match(CROSS_REPO_REF_AT_START);
  if (!m) return null;
  const [label, owner, rest, mark, number] = m as unknown as [string, string, string, "#" | "!", string];
  const parts = rest.slice(1).split("/");
  const repo = parts[parts.length - 1]!;
  const path = `${owner}${rest}`;
  if (/^\d+$/.test(owner) || parts.some((part) => /^\.+$/.test(part)) || FILE_LIKE_REPO.test(repo) || PROSE_PAIRS.has(path.toLowerCase())) return null;
  if (mark === "#") {
    if (parts.length !== 1) return null;
    return { label, path, href: forgeRefLinks({ display: path, host: project.host })?.issue(number) ?? null };
  }
  const mergeRequest = !project.withoutRepo && readGitlabShortMr(label) ? forgeRefLinks({ display: path, host: project.host })?.mergeRequest : null;
  return mergeRequest ? { label, path, href: mergeRequest(number) } : null;
}

/**
 * Index of the first `owner/repo#123` (or GitLab `group/project!45`) ref in `text` after index 0 and before
 * `end`, or -1. A plain-text scanner splits its chunk there, so the ref is
 * read whole before path detection can take `owner/repo` for a file.
 * `accept` (default: every ref) lets the caller pass over a ref it renders
 * otherwise (a file it knows).
 */
export function findCrossRepoRef(
  text: string,
  end: number,
  project: { host?: string; withoutRepo?: boolean },
  accept: (ref: CrossRepoRef) => boolean = () => true,
): number {
  // Only a word's start can begin a ref; a sticky match there reads no further than the ref itself, so the scan
  // stays linear however deep a GitLab path may be.
  const re = new RegExp(CROSS_REPO_REF_AT_START.source.slice(1), "y");
  for (let i = 1; i < end && i < text.length; i++) {
    if (!/[A-Za-z0-9]/.test(text[i]!) || /[\w./@-]/.test(text[i - 1]!)) continue;
    re.lastIndex = i;
    if (!re.test(text)) continue;
    const ref = matchCrossRepoRef(text.slice(i), text[i - 1]!, project);
    if (ref && accept(ref)) return i;
  }
  return -1;
}
