/**
 * Clone from a git URL (approval "launch-create-clone", C1-C8): what a pasted text is, read the same way in the window
 * (which rows to offer) and on the machine that clones (which URL git is given). Pure: no network, no files.
 *
 * Read as a repo: `https://host/owner/repo(.git)`, `git@host:owner/repo(.git)`, `ssh://[user@]host[:port]/path(.git)`,
 * and a known forge without a scheme (`github.com/acme/billing-api`, read as https). A known forge's `…/tree/<branch>/…`
 * (or `blob`) names a branch: it is cloned, and the agent starts at the repo's top folder (decision 8a). A known forge
 * with one segment is an account, not a repo (C6); an unknown host's https URL needs a check first (C7, C8). A bare
 * `acme/billing-api` stays a project search (C3).
 *
 * Never a way to smuggle anything into `git clone`: the URL git gets is rebuilt from the parts read (an https URL's
 * user and password are dropped, so no credential is ever passed on), every part is plain (letters, digits, `.`, `_`,
 * `-`, `~`), none starts with `-` (no option injection), none is `..`, and nothing but https and ssh is read (`http://`,
 * `git://`, `file://` and `ext::` stay words).
 */

/** Forges whose URLs are known: their repo is `owner/repo` (GitLab: every group up to `/-/`). */
export const INBOX_KNOWN_FORGES = ["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"] as const;

/** A repo to clone. `url`: what git is given; `slug`: `owner/repo` as the words name it; `repo`: the folder's name. */
export interface InboxGitRepo {
  kind: "repo";
  host: string;
  slug: string;
  repo: string;
  url: string;
  transport: "https" | "ssh";
  /** `…/tree/<branch>`: clone that branch (decision 8a). */
  branch?: string;
  /** An unknown host: the window checks it is a git repo before offering to clone (C8). */
  unchecked?: true;
}

export type InboxGitUrl =
  | InboxGitRepo
  /** A known forge's account, not a repo (C6). */
  | { kind: "account"; host: string; owner: string }
  /** An https URL that can't be a repo (one segment on an unknown host, C7). */
  | { kind: "notrepo"; host: string; text: string };

/** One plain part of a host or path: no spaces, no shell or URL syntax, never `-…` (an option) or `..`. */
const PART = /^[A-Za-z0-9_~][A-Za-z0-9._~-]*$/;
const HOST = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;
/** A branch name as git allows it, without anything that reads as an option or a range. */
const BRANCH = /^[A-Za-z0-9_][A-Za-z0-9._/-]{0,199}$/;

const plain = (segment: string) => PART.test(segment) && segment !== "." && segment !== "..";

/** The path's segments without `.git` on the last; null when any is not plain. */
function segmentsOf(path: string): string[] | null {
  const segments = path.split("/").filter((segment) => segment !== "");
  if (segments.length > 0) segments[segments.length - 1] = segments[segments.length - 1]!.replace(/\.git$/, "");
  // `-` alone is GitLab's separator (`group/repo/-/tree/main`); it is never part of a repo's own path (checked below).
  return segments.every((s) => s === "-" || plain(s)) ? segments : null;
}

/** What a pasted text is (see above), or null: words to find a project by. */
export function parseInboxGitUrl(text: string): InboxGitUrl | null {
  const t = text.trim();
  if (t === "" || t.startsWith("-") || /[\s\0]/.test(t)) return null;
  let host: string;
  let path: string;
  let transport: "https" | "ssh";
  let user: string | null = null;
  let port: string | null = null;
  let shorthand = false;
  let m: RegExpExecArray | null;
  if ((m = /^([A-Za-z0-9_][A-Za-z0-9._-]*)@([^:/]+):(?!\/\/)(.+?)\/?$/.exec(t))) {
    user = m[1]!;
    host = m[2]!;
    path = m[3]!;
    transport = "ssh";
  } else if ((m = /^ssh:\/\/(?:([A-Za-z0-9_][A-Za-z0-9._-]*)@)?([^:/@]+)(?::(\d{1,5}))?\/(.+?)\/?$/.exec(t))) {
    user = m[1] ?? null;
    host = m[2]!;
    port = m[3] ?? null;
    path = m[4]!;
    transport = "ssh";
  } else if ((m = /^https:\/\/(?:[^@/]*@)?([^:/@?#]+)(?::(\d{1,5}))?(?:\/([^?#]*))?(?:[?#].*)?$/.exec(t))) {
    host = m[1]!;
    port = m[2] ?? null;
    path = (m[3] ?? "").replace(/\/+$/, "");
    transport = "https";
  } else if ((m = /^(?:www\.)?(github\.com|gitlab\.com|bitbucket\.org|codeberg\.org)\/(.+?)\/?$/i.exec(t))) {
    host = m[1]!;
    path = m[2]!;
    transport = "https";
    shorthand = true;
  } else return null;
  host = host.toLowerCase().replace(/^www\./, "");
  if (!HOST.test(host)) return null;
  const known = (INBOX_KNOWN_FORGES as readonly string[]).includes(host);
  const segments = segmentsOf(path);
  if (segments === null) return null;
  const at = port && !(transport === "https" && port === "443") ? `:${port}` : "";
  if (known && transport === "https") {
    if (segments.length < 2) return segments[0] === "-" ? null : { kind: "account", host, owner: segments[0] ?? "" };
    let repoSegments: string[];
    let rest: string[];
    if (host === "gitlab.com") {
      const dash = segments.indexOf("-");
      repoSegments = dash === -1 ? segments : segments.slice(0, dash);
      rest = dash === -1 ? [] : segments.slice(dash + 1);
    } else {
      repoSegments = segments.slice(0, 2);
      rest = segments.slice(2);
    }
    if (repoSegments.includes("-")) return null;
    if (repoSegments.length < 2) return { kind: "account", host, owner: repoSegments[0] ?? "" };
    const slug = repoSegments.join("/");
    const branch = (rest[0] === "tree" || rest[0] === "blob") && rest[1] && BRANCH.test(rest[1]) ? rest[1] : undefined;
    // Anything else after the repo (issues, pulls, a file) is still that repo.
    return { kind: "repo", host, slug, repo: repoSegments[repoSegments.length - 1]!, url: `https://${host}${at}/${slug}.git`, transport, ...(branch ? { branch } : {}) };
  }
  void shorthand;
  if (segments.length === 0 || segments.includes("-")) return null;
  const slug = segments.join("/");
  const repo = segments[segments.length - 1]!;
  if (transport === "ssh") {
    const who = user ? `${user}@` : "";
    const url = port || t.startsWith("ssh://") ? `ssh://${who}${host}${port ? `:${port}` : ""}/${slug}.git` : `${who}${host}:${slug}.git`;
    return { kind: "repo", host, slug, repo, url, transport };
  }
  if (segments.length < 2) return { kind: "notrepo", host, text: t };
  return { kind: "repo", host, slug, repo, url: `https://${host}${at}/${slug}.git`, transport, unchecked: true };
}

/** The repo a remote URL names, for "already cloned" (C9): `host/slug`, case and `.git` aside; null when it can't be read. */
export function inboxGitRemoteKey(url: string): string | null {
  const read = parseInboxGitUrl(url);
  return read && read.kind === "repo" ? `${read.host}/${read.slug}`.toLowerCase() : null;
}

/** "acme/billing-api" for the words: the slug. */
export function inboxGitSlug(repo: Pick<InboxGitRepo, "slug">): string {
  return repo.slug;
}
