export interface ServedHosts {
	readonly publicHost: string;
	readonly all: ReadonlySet<string>;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

export function servedHosts(publicHost: string, extra: readonly string[] = []): ServedHosts {
	const all = new Set([publicHost]);
	for (const raw of extra) {
		const host = raw.trim().toLowerCase();
		if (!HOSTNAME.test(host)) {
			throw new TypeError(`hosts: "${raw}" is not a bare hostname (no scheme, port or path)`);
		}
		all.add(host === `www.${publicHost}` ? publicHost : host);
	}
	return { publicHost, all };
}

export function servedHost(served: ServedHosts, hostname: string): string | null {
	const host = hostname.toLowerCase();
	if (host === `www.${served.publicHost}`) return served.publicHost;
	return served.all.has(host) ? host : null;
}

export function readHost(served: ServedHosts, host: string | undefined): string | null {
	return servedHost(served, host ?? served.publicHost);
}

export function hostKey(served: ServedHosts, host: string, key: string): string {
	return host === served.publicHost ? key : `${host}:${key}`;
}

export function isMintedCanonical(match: (url: URL) => { readonly url: string } | null, url: string): boolean {
	try {
		return match(new URL(url))?.url === url;
	} catch {
		return false;
	}
}

export type ApiOriginProvider = "github" | "gitlab" | "linear";

export function apiOrigin(provider: ApiOriginProvider, host: string): string {
	const lower = host.toLowerCase();
	if (provider === "linear") return "https://api.linear.app";
	if (provider === "github") {
		if (lower === "github.com") return "https://api.github.com";
		if (lower.endsWith(".ghe.com")) return `https://api.${lower}`;
	}
	return `https://${lower}`;
}
