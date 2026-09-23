/**
 * Which forge a git remote lives on, and where bare `#123` / `@user`
 * references in a document should link to (#1596).
 *
 * Browser-safe and dependency-free: the UI resolves ref links with it, and the
 * server-side commit-avatar lookup classifies remotes with the same rule.
 */

export type ForgePlatform = "github" | "gitlab";

/**
 * Classify a remote host by name: exact/prefix github is GitHub (github.com
 * and GitHub Enterprise hosts like `github.acme.com`); gitlab.com, `gitlab.*`
 * and `*.gitlab.*` are GitLab. A structured match, not a bare substring:
 * `mygitlabproxy.example.com` does not qualify. Opaque self-hosted names
 * return null.
 */
export function classifyForgeHost(host: string): ForgePlatform | null {
  if (host === "github.com" || host.startsWith("github.")) return "github";
  if (host === "gitlab.com" || host.startsWith("gitlab.") || host.includes(".gitlab.")) {
    return "gitlab";
  }
  return null;
}

export interface ForgeRefLinks {
  issue(num: string | number): string;
  user(handle: string): string;
}

/**
 * Link builders for inline issue and mention refs, or null when refs should
 * render unlinked.
 *
 * - `display` without a `/` (a directory-name fallback, not a remote path) → null.
 * - `host` absent → github.com, the behavior before hosts were known (older
 *   servers and host apps that pass no host).
 * - GitHub-like host → `https://<host>/<path>/issues/N`.
 * - GitLab-like host → `https://<host>/<path>/-/issues/N`.
 * - Any other host → null: a wrong-forge link is worse than no link.
 */
export function forgeRefLinks(repo: { display?: string; host?: string }): ForgeRefLinks | null {
  const path = repo.display;
  if (!path || !path.includes("/")) return null;
  const host = repo.host || "github.com";
  const platform = classifyForgeHost(host);
  if (!platform) return null;
  const base = `https://${host}`;
  const issues = platform === "gitlab" ? `${base}/${path}/-/issues` : `${base}/${path}/issues`;
  return {
    issue: (num) => `${issues}/${num}`,
    user: (handle) => `${base}/${handle}`,
  };
}
