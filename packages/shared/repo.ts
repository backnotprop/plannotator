export interface RepoInfo {
	display: string;
	branch?: string;
	host?: string;
}

export function parseRemoteUrl(url: string): string | null {
	if (!url) return null;

	const sshPortMatch = url.match(/^ssh:\/\/[^/]+(?::\d+)?\/(.+?)(?:\.git)?$/);
	if (sshPortMatch) return sshPortMatch[1];

	if (!url.includes("://")) {
		const sshMatch = url.match(/:([^/][^:]*?)(?:\.git)?$/);
		if (sshMatch) return sshMatch[1];
	}

	const httpsMatch = url.match(/^https?:\/\/[^/]+\/(.+?)(?:\.git)?$/);
	if (httpsMatch) return httpsMatch[1];

	return null;
}

export function parseRemoteHost(url: string): string | null {
	if (!url) return null;
	const sshPort = url.match(/^ssh:\/\/(?:[^@/]+@)?([^:/?#]+)/i);
	if (sshPort) return sshPort[1];
	if (!url.includes('://')) {
		const ssh = url.match(/^[^@\s]+@([^:\s]+):/);
		if (ssh) return ssh[1];
	}
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
