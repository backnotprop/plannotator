export interface RepoInfo {
	display: string;
	branch?: string;
	/** Host of the git remote (e.g., "github.com", "gitlab.com"). Populated */
	/** only when the remote URL is parseable; absent for directory-only fallbacks. */
	host?: string;
}

/** Parse org/repo from a git remote URL (SSH, HTTPS, SSH with port, GitLab subgroups). */
export function parseRemoteUrl(url: string): string | null {
	if (!url) return null;

	const sshPortMatch = url.match(/^ssh:\/\/[^/]+(?::\d+)?\/(.+?)(?:\.git)?$/);
	if (sshPortMatch) return sshPortMatch[1];

	// Reject URLs with :// scheme (HTTPS with non-standard ports like :8443)
	if (!url.includes("://")) {
		const sshMatch = url.match(/:([^/][^:]*?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];
	}

	const httpsMatch = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
	if (httpsMatch) return httpsMatch[1];

	return null;
}

/** Parse the host from a git remote URL; null when no known remote form matches. */
export function parseRemoteHost(url: string): string | null {
	if (!url) return null;
	const sshPort = url.match(/^ssh:\/\/(?:[^@/]+@)?([^:/?#]+)/i);
	if (sshPort) return sshPort[1];
	if (!url.includes('://')) {
		const ssh = url.match(/^[^@\s]+@([^:\s]+):/);
		if (ssh) return ssh[1];
	}
	// https://[user[:token]@]host/path — userinfo is not part of the host
	const https = url.match(/^https?:\/\/(?:[^@/]+@)?([^/:?#]+)/i);
	if (https) return https[1];
	return null;
}

export function getDirName(path: string): string | null {
	if (!path) return null;
	const trimmed = path.trim().replace(/\/+$/, "");
	const parts = trimmed.split("/");
	return parts[parts.length - 1] || null;
}
