export interface RepoInfo {
	/** Display string (e.g., "backnotprop/plannotator" or "my-project") */
	display: string;
	/** Current git branch (if in a git repo) */
	branch?: string;
	/** Host of the git remote (e.g., "github.com", "gitlab.com"). Populated */
	/** only when the remote URL is parseable; absent for directory-only fallbacks. */
	host?: string;
}

/**
 * Parse org/repo from a git remote URL
 *
 * Handles:
 * - SSH: git@github.com:org/repo.git
 * - HTTPS: https://github.com/org/repo.git
 * - SSH with port: ssh://git@github.com:22/org/repo.git
 * - GitLab subgroups: git@gitlab.com:group/subgroup/project.git
 */
export function parseRemoteUrl(url: string): string | null {
	if (!url) return null;

	// SSH with port: ssh://git@host:22/path.git — strip scheme+host+port
	const sshPortMatch = url.match(/^ssh:\/\/[^/]+(?::\d+)?\/(.+?)(?:\.git)?$/);
	if (sshPortMatch) return sshPortMatch[1];

	// SSH format: git@host:path.git — capture full path after ':'
	// Reject URLs with :// scheme (HTTPS with non-standard ports like :8443)
	if (!url.includes("://")) {
		const sshMatch = url.match(/:([^/][^:]*?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];
	}

	// HTTPS format: https://host/path.git — capture full path after host
	const httpsMatch = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
	if (httpsMatch) return httpsMatch[1];

	return null;
}

/**
 * Parse the host from a git remote URL. Returns null when the shape
 * doesn't match a known remote form. Used to identify the forge
 * (github.com, gitlab.com, self-hosted) so inline mention / issue
 * refs can link to the correct destination instead of assuming GitHub.
 */
export function parseRemoteHost(url: string): string | null {
	if (!url) return null;
	// ssh://git@host:port/path
	const sshPort = url.match(/^ssh:\/\/(?:[^@]+@)?([^:/]+)/i);
	if (sshPort) return sshPort[1];
	// git@host:path
	if (!url.includes('://')) {
		const ssh = url.match(/^[^@\s]+@([^:\s]+):/);
		if (ssh) return ssh[1];
	}
	// https://host/path or http://host/path
	const https = url.match(/^https?:\/\/([^/:]+)/i);
	if (https) return https[1];
	return null;
}

/**
 * Get directory name from path
 */
export function getDirName(path: string): string | null {
	if (!path) return null;
	const trimmed = path.trim().replace(/\/+$/, "");
	const parts = trimmed.split("/");
	return parts[parts.length - 1] || null;
}
