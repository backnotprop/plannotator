// Source: new in Plannotator after placement, not cut from Workspaces: the `hosts` option PROVENANCE.md planned against the extract of Workspaces main 7379b0195de140adc00b4496eefe553a3eec803e.
// The forge grammars and adapters share it, so GitHub Enterprise and self-managed GitLab hosts are served by one rule.
//
// A forge serves its public host (github.com, gitlab.com, with its `www.`
// alias read as the public host) plus the hosts a consumer names. Each
// named host is a bare lowercase DNS hostname: no scheme, port, path or
// credentials, and at least one dot. A canonical URL carries the host it
// was matched on, and every provider call for it goes to that host's own
// API. Which hosts may receive a token stays the port's decision.

/** The hosts one forge adapter serves. */
export interface ServedHosts {
	/** The public host: "github.com" or "gitlab.com". */
	readonly publicHost: string;
	/** Every served host, the public one included, lowercase. */
	readonly all: ReadonlySet<string>;
}

const LABEL = "[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?";
const HOSTNAME = new RegExp(`^(?=.{1,253}$)${LABEL}(?:\\.${LABEL})+$`);

/** The served set for a forge: its public host plus `extra`. Throws a
 * TypeError for a host that is not a bare hostname: a configuration error
 * surfaces when the adapter is built, never as a read answer. */
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

/** The canonical host a URL hostname maps to, or null when the forge does
 * not serve it. `www.` of the public host reads as the public host. */
export function servedHost(served: ServedHosts, hostname: string): string | null {
	const host = hostname.toLowerCase();
	if (host === `www.${served.publicHost}`) return served.publicHost;
	return served.all.has(host) ? host : null;
}

/** The host a picker or list read runs against: the given one (default
 * the public host), or null when the forge does not serve it. */
export function readHost(served: ServedHosts, host: string | undefined): string | null {
	return servedHost(served, host ?? served.publicHost);
}

/** A reference key on a served host. The public host keeps its keys
 * unprefixed, exactly as Workspaces stores them; another host's keys carry
 * `host:` (a colon appears in no repository path) so the same path on two
 * hosts never shares a key. */
export function hostKey(served: ServedHosts, host: string, key: string): string {
	return host === served.publicHost ? key : `${host}:${key}`;
}

/** True when `url` is a canonical the grammar mints: matching it again
 * gives back the same URL. A resolve reads only such a ref, so a crafted
 * ref (an encoded `..` in a path segment, say) never reaches an API path
 * the grammar would not produce. */
export function isMintedCanonical(match: (url: URL) => { readonly url: string } | null, url: string): boolean {
	try {
		return match(new URL(url))?.url === url;
	} catch {
		return false;
	}
}

/** The providers `apiOrigin` answers for. */
export type ApiOriginProvider = "github" | "gitlab" | "linear";

/** The one origin every provider call for an item on `host` goes to, and
 * so the only origin that may receive that host's credential:
 *
 *   github  github.com      https://api.github.com
 *           {x}.ghe.com     https://api.{x}.ghe.com
 *           any other host  https://{host}  (GitHub Enterprise Server:
 *                           REST under /api/v3, GraphQL at /api/graphql)
 *   gitlab  any host        https://{host}  (REST under /api/v4, GraphQL
 *                           at /api/graphql)
 *   linear  linear.app      https://api.linear.app
 *
 * A port that binds its fetch to a host binds it to this origin. */
export function apiOrigin(provider: ApiOriginProvider, host: string): string {
	const lower = host.toLowerCase();
	if (provider === "linear") return "https://api.linear.app";
	if (provider === "github") {
		if (lower === "github.com") return "https://api.github.com";
		if (lower.endsWith(".ghe.com")) return `https://api.${lower}`;
	}
	return `https://${lower}`;
}
