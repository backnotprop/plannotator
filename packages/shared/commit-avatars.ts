/**
 * Commit author avatars for the Commits panel.
 *
 * Local commits carry only a git author name/email — no platform login — so
 * the PR review's avatar machinery (GitHub GraphQL keyed by login, GitLab
 * notes carrying `avatar_url`) can't be reused directly. What IS reused:
 *
 *  - `parseRemoteUrl` / `parseRemoteHost` (./repo) to identify the forge from
 *    `git remote get-url origin`.
 *  - The gh/glab CLI invocation shape, including the `--hostname` convention
 *    for self-hosted instances (mirrors pr-github's hostnameArgs and
 *    pr-gitlab's apiArgs).
 *  - GitLab's relative-avatar absolutization rule (self-hosted instances
 *    return `/uploads/...` paths that must be pinned to the GitLab host).
 *
 * Per platform:
 *  - GitHub / GHE: one `gh api repos/{owner}/{repo}/commits?per_page=100`
 *    call per session builds an author-email → avatar_url map (the API links
 *    pushed commits to their GitHub accounts). Keying by EMAIL means local
 *    unpushed commits by the same author still resolve.
 *  - GitLab: the commits API carries no avatars, but `GET /avatar?email=`
 *    (gravatar-backed) resolves one email per call — deduped and capped.
 *  - Unknown hosts (self-hosted forges without a telling hostname): skipped.
 *
 * Everything is best-effort and memoized: a missing/unauthenticated CLI is
 * recorded once and never retried this session, and lookups never fail the
 * commits endpoint — rows just render the initials fallback.
 */

import { parseRemoteUrl, parseRemoteHost } from "./repo";

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface CommandRunner {
  runCommand(cmd: string, args: string[]): Promise<CommandResult>;
}

export type AvatarPlatform = "github" | "gitlab";

export interface AvatarRemote {
  platform: AvatarPlatform;
  host: string;
  /** `owner/repo` (GitHub) or `group/subgroup/project` (GitLab). */
  path: string;
}

/**
 * Classify a git remote URL to a forge we can query for avatars. Bare remote
 * URLs have none of the path markers parsePRUrl keys off (`/pull/`,
 * `/-/merge_requests/`), so this goes by hostname: exact/prefix github or a
 * host containing "gitlab". Self-hosted forges with an opaque hostname return
 * null — probing both CLIs blind would be slow and noisy. Accepted edge.
 */
export function classifyAvatarRemote(remoteUrl: string): AvatarRemote | null {
  const host = parseRemoteHost(remoteUrl);
  const path = parseRemoteUrl(remoteUrl);
  if (!host || !path) return null;
  if (host === "github.com" || host.startsWith("github.")) {
    return { platform: "github", host, path };
  }
  // Structured match, not a bare substring: `gitlab.company.com` and
  // `sub.gitlab.example.io` qualify, `mygitlabproxy.example.com` doesn't.
  if (host === "gitlab.com" || host.startsWith("gitlab.") || host.includes(".gitlab.")) {
    return { platform: "gitlab", host, path };
  }
  return null;
}

/** Mirrors pr-github's hostnameArgs: `--hostname` only off github.com. */
function ghArgs(host: string, args: string[]): string[] {
  return host !== "github.com" ? [...args, "--hostname", host] : args;
}

/** Mirrors pr-gitlab's apiArgs: `--hostname` only off gitlab.com. */
function glabArgs(host: string, endpoint: string): string[] {
  const args = ["api", endpoint];
  if (host !== "gitlab.com") args.push("--hostname", host);
  return args;
}

/**
 * Build the email → avatar map from the GitHub commits-list API response.
 * `author` is the linked GitHub account and is null for unlinked emails.
 * Exported for tests.
 */
export function buildGitHubEmailAvatarMap(payload: unknown): Map<string, string> {
  const map = new Map<string, string>();
  if (!Array.isArray(payload)) return map;
  for (const entry of payload) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const email = (((e.commit as Record<string, unknown> | undefined)?.author) as
      | Record<string, unknown>
      | undefined)?.email;
    const avatar = (e.author as Record<string, unknown> | null | undefined)?.avatar_url;
    if (typeof email === "string" && email && typeof avatar === "string" && avatar && !map.has(email)) {
      map.set(email, avatar);
    }
  }
  return map;
}

/**
 * Same rule as pr-gitlab's resolveAvatar: self-hosted GitLab often returns
 * relative `/uploads/...` avatar paths that would otherwise resolve against
 * our local server. Exported for tests.
 */
export function absolutizeGitLabAvatar(host: string, url: string): string {
  return url.startsWith("/") ? `https://${host}${url}` : url;
}

/** Bound per-request subprocess fan-out for GitLab's per-email endpoint. */
const MAX_GITLAB_EMAIL_LOOKUPS_PER_CALL = 10;

/**
 * Hard ceiling on how long one resolve() may sit on /api/commits' critical
 * path. The gh/glab runner has no subprocess timeout, so a hanging network
 * (black-holed DNS, proxy that never answers) would otherwise hold the
 * commits response — which is already computed — hostage to decoration.
 * On expiry resolve() returns what the cache has (initials fallback); the
 * in-flight fetch keeps running in the background and later calls pick its
 * results out of the cache.
 */
const DEFAULT_FETCH_TIMEOUT_MS = 4000;

export interface CommitAvatarResolver {
  /**
   * Resolve avatar URLs for the given author emails, computed against the
   * repo at `cwd`. Returns only the emails that resolved; misses are memoized
   * as unresolvable and never re-queried this session.
   */
  resolve(cwd: string | undefined, emails: readonly string[]): Promise<Map<string, string>>;
}

export function createCommitAvatarResolver(
  runner: CommandRunner,
  options?: { fetchTimeoutMs?: number },
): CommitAvatarResolver {
  const fetchTimeoutMs = options?.fetchTimeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  // email → url (resolved) or null (known-unresolvable this session).
  const emailCache = new Map<string, string | null>();
  // cwd-key → classified remote (null = no queryable forge).
  const remoteCache = new Map<string, AvatarRemote | null>();
  // Platform-level failure memo: gh/glab missing or unauthenticated — stop
  // paying a subprocess per page for a CLI that will never answer.
  const brokenPlatforms = new Set<AvatarPlatform>();
  // The one-shot GitHub commits-list fetch, per remote path.
  const githubFetched = new Set<string>();

  async function classifyRemote(cwd: string | undefined): Promise<AvatarRemote | null> {
    const key = cwd ?? "";
    const cached = remoteCache.get(key);
    if (cached !== undefined) return cached;
    let remote: AvatarRemote | null = null;
    try {
      const result = await runner.runCommand("git", [
        ...(cwd ? ["-C", cwd] : []),
        "remote",
        "get-url",
        "origin",
      ]);
      if (result.exitCode === 0) remote = classifyAvatarRemote(result.stdout.trim());
    } catch {
      remote = null;
    }
    remoteCache.set(key, remote);
    return remote;
  }

  async function fetchGitHubAvatars(remote: AvatarRemote): Promise<void> {
    if (githubFetched.has(remote.path) || brokenPlatforms.has("github")) return;
    githubFetched.add(remote.path);
    try {
      const result = await runner.runCommand(
        "gh",
        ghArgs(remote.host, ["api", `repos/${remote.path}/commits?per_page=100`]),
      );
      if (result.exitCode !== 0) {
        brokenPlatforms.add("github");
        return;
      }
      const map = buildGitHubEmailAvatarMap(JSON.parse(result.stdout));
      for (const [email, url] of map) {
        if (!emailCache.get(email)) emailCache.set(email, url);
      }
    } catch {
      brokenPlatforms.add("github");
    }
  }

  async function fetchGitLabAvatar(remote: AvatarRemote, email: string): Promise<void> {
    try {
      const result = await runner.runCommand(
        "glab",
        glabArgs(remote.host, `avatar?email=${encodeURIComponent(email)}`),
      );
      if (result.exitCode !== 0) {
        brokenPlatforms.add("gitlab");
        return;
      }
      const parsed = JSON.parse(result.stdout) as { avatar_url?: unknown };
      if (typeof parsed.avatar_url === "string" && parsed.avatar_url) {
        emailCache.set(email, absolutizeGitLabAvatar(remote.host, parsed.avatar_url));
      }
    } catch {
      brokenPlatforms.add("gitlab");
    }
  }

  return {
    async resolve(cwd, emails) {
      const resolved = new Map<string, string>();
      const collect = (unique: Set<string>) => {
        for (const email of unique) {
          const url = emailCache.get(email);
          if (url) resolved.set(email, url);
        }
      };
      const unique = new Set(emails.filter(Boolean));
      if (unique.size === 0) return resolved;

      const pending = [...unique].filter((email) => !emailCache.has(email));
      if (pending.length === 0) {
        collect(unique);
        return resolved;
      }

      // Misses are memoized ONLY for emails an attempt actually covered —
      // the GitLab per-call cap is a rate limit, not a verdict, so emails
      // past it stay unmemoized and get their lookup on a later call.
      const attempted = new Set<string>();
      const attempt = (async () => {
        const remote = await classifyRemote(cwd);
        if (!remote || brokenPlatforms.has(remote.platform)) return;
        if (remote.platform === "github") {
          // One commits-list fetch covers the whole email map — every pending
          // email counts as attempted whether or not it resolved (unresolved
          // means the forge has no linked account for it).
          await fetchGitHubAvatars(remote);
          for (const email of pending) attempted.add(email);
        } else {
          // Parallel, not sequential: these lookups sit on /api/commits'
          // critical path, and ten serial subprocess spawns added seconds to
          // the rail's first paint on multi-author GitLab histories.
          const batch = pending.slice(0, MAX_GITLAB_EMAIL_LOOKUPS_PER_CALL);
          for (const email of batch) attempted.add(email);
          await Promise.all(batch.map((email) => fetchGitLabAvatar(remote, email)));
        }
      })();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timedOut = await Promise.race([
        attempt.then(() => false, () => false),
        new Promise<boolean>((res) => { timer = setTimeout(() => res(true), fetchTimeoutMs); }),
      ]);
      clearTimeout(timer);
      if (timedOut) {
        // The attempt is still running — nothing was verifiably covered, so
        // memoize no misses. Whatever it eventually caches serves later calls.
        attempted.clear();
      }

      for (const email of attempted) {
        if (!emailCache.has(email)) emailCache.set(email, null);
      }
      collect(unique);
      return resolved;
    },
  };
}
