/**
 * Which forge a git remote lives on, and where bare `#123` / `@user`
 * references in a document should link to (#1596).
 *
 * Browser-safe and dependency-free: the UI resolves ref links with it, and the
 * server-side commit-avatar lookup classifies remotes with the same rule.
 */

export type ForgePlatform = "github" | "gitlab";

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
 * - `host` absent, or not a plausible DNS name after `normalizeForgeHost`
 *   → github.com, the behavior before hosts were known (older servers, host
 *   apps that pass no host, and SSH aliases like `git@work-gh:o/r`).
 * - GitHub-like host → `https://<host>/<path>/issues/N`.
 * - GitLab-like host → `https://<host>/<path>/-/issues/N`.
 * - Any other host → null: a wrong-forge link is worse than no link.
 */
export function forgeRefLinks(repo: { display?: string; host?: string }): ForgeRefLinks | null {
  const path = repo.display;
  if (!path || !path.includes("/")) return null;
  const host = normalizeForgeHost(repo.host) ?? "github.com";
  const platform = classifyForgeHost(host);
  if (!platform) return null;
  const base = `https://${host}`;
  const issues = platform === "gitlab" ? `${base}/${path}/-/issues` : `${base}/${path}/issues`;
  return {
    issue: (num) => `${issues}/${num}`,
    user: (handle) => `${base}/${handle}`,
  };
}
