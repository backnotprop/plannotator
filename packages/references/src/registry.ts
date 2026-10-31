// Source: apps/rooms/src/external-refs/registry.ts, plus matchExternalRefUrl from apps/web/src/components/external-refs/match.ts (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Changed: the fixed ADAPTERS list is three entries and the functions are built by createReferenceRegistry so a consumer can compose more adapters.
//
// The adapter registry: the ONLY module that imports an adapter file. A
// caller asks it two questions ("which adapter owns this provider?" and
// "does any adapter recognize this URL?") and never names a provider
// itself.
//
// MATCH ORDER IS REGISTRATION ORDER. Fixed-host adapters (github.com,
// gitlab.com, linear.app) come first; a consumer that adds structural
// suffix matchers (`*.atlassian.net`, `*.slack.com`) appends them after the
// fixed hosts so a suffix matcher can never shadow a fixed host. Hosts are
// disjoint today. Where two adapters deliberately claim one grammar
// (Workspaces' Google Meet before Google Drive), the earlier one answers
// first and matchExternalRefCandidates lets the caller fall through to the
// next on not_linked. A NEW overlapping claim is a decision, not an
// accident: keep hosts disjoint, or order them on purpose.

import type { CodeLinkProviderId, CodeLinkRef, ExternalRef, ProviderId, RefReadAdapter } from "./contract.ts";
import { createGithubAdapter, githubAdapter } from "./adapters/github.ts";
import { createGitlabAdapter, gitlabAdapter } from "./adapters/gitlab.ts";
import { linearAdapter } from "./adapters/linear.ts";
import { GITHUB_PUBLIC_HOST, type GithubHostsOptions } from "./grammars/github.ts";
import { GITLAB_PUBLIC_HOST, type GitlabHostsOptions } from "./grammars/gitlab.ts";
import { apiOrigin, servedHosts } from "./hosts.ts";

/** Linear's one host. */
const LINEAR_HOST = "linear.app";

/** The three adapters this package carries, in their match order. */
export const REFERENCE_ADAPTERS: readonly RefReadAdapter[] = [
	githubAdapter,
	gitlabAdapter,
	linearAdapter,
];

/** The hosts each forge serves beside its public host. */
export interface ReferenceAdapterHosts {
	readonly github?: GithubHostsOptions;
	readonly gitlab?: GitlabHostsOptions;
}

/** The same three adapters, in the same order, with GitHub Enterprise and
 * self-managed GitLab hosts added. Hosts stay disjoint: throws a TypeError
 * for a host that is not a bare hostname, a host named for both forges, or
 * a host another provider owns (github.com, gitlab.com, linear.app and
 * their `www.` forms), or a host whose API origin (`apiOrigin`) another
 * served host already has (`api.github.com`, `api.linear.app`). */
export function createReferenceAdapters(hosts: ReferenceAdapterHosts = {}): readonly RefReadAdapter[] {
	const github = servedHosts(GITHUB_PUBLIC_HOST, hosts.github?.hosts);
	const gitlab = servedHosts(GITLAB_PUBLIC_HOST, hosts.gitlab?.hosts);
	const publicHosts = [GITHUB_PUBLIC_HOST, GITLAB_PUBLIC_HOST, LINEAR_HOST];
	/** A host another provider's public host (or its `www.` form) is. */
	const othersPublic = (host: string, own: string) =>
		publicHosts.some((p) => p !== own && (host === p || host === `www.${p}`));
	const clash = (host: string) =>
		new TypeError(`hosts: "${host}" is served by another provider; hosts must be disjoint`);
	for (const host of github.all) {
		if (gitlab.all.has(host) || othersPublic(host, GITHUB_PUBLIC_HOST)) throw clash(host);
	}
	for (const host of gitlab.all) {
		if (othersPublic(host, GITLAB_PUBLIC_HOST)) throw clash(host);
	}
	// API origins stay disjoint too (`api.github.com` named as a GitHub
	// Enterprise host would share github.com's), so a port can map an
	// origin back to exactly one host.
	const origins = new Map<string, string>();
	const claim = (provider: "github" | "gitlab" | "linear", host: string) => {
		const origin = apiOrigin(provider, host);
		const owner = origins.get(origin);
		if (owner !== undefined) {
			throw new TypeError(`hosts: "${host}" would read ${origin}, the API origin of "${owner}"; origins must be disjoint`);
		}
		origins.set(origin, host);
	};
	claim("linear", LINEAR_HOST);
	for (const host of github.all) claim("github", host);
	for (const host of gitlab.all) claim("gitlab", host);
	return [createGithubAdapter(hosts.github), createGitlabAdapter(hosts.gitlab), linearAdapter];
}

/** Whether a provider is one a code-link store admits: the narrowing from
 * the full adapter union to the forge trio. A future adapter that grows a
 * code-link matcher without joining that set must widen BOTH, so a
 * non-trio answer is skipped here rather than minted into an unstorable row. */
function isCodeLinkProvider(provider: ProviderId): provider is CodeLinkProviderId {
	return provider === "github" || provider === "gitlab" || provider === "bitbucket";
}

export interface ReferenceRegistry {
	/** The adapter owning a provider id, or null for an unknown provider. */
	adapterFor(provider: string): RefReadAdapter | null;
	/** All registered adapters, in match order. */
	allAdapters(): readonly RefReadAdapter[];
	/** EVERY adapter that recognizes the URL, in registration order. The
	 * caller resolves the first and moves to the next only when that one
	 * answers not_linked. */
	matchExternalRefCandidates(url: URL): readonly { adapter: RefReadAdapter; ref: ExternalRef }[];
	/** First adapter that recognizes the URL, with its parsed ref. Null = no
	 * provider claims it: the caller's plain-link answer. */
	matchExternalRef(url: URL): { adapter: RefReadAdapter; ref: ExternalRef } | null;
	/** First adapter that recognizes the URL as one of ITS code-link forms
	 * (repo home, branch page, pull/merge request, GitHub issue), with the
	 * typed association. Null = no provider claims it. */
	matchCodeLinkUrl(url: URL): { provider: CodeLinkProviderId; link: CodeLinkRef } | null;
	/** The string form the Workspaces web client used: one absolute URL in,
	 * its canonical resolve URL out, or null (a plain link). Deciding which
	 * links are worth a resolve call costs no fetch. */
	matchExternalRefUrl(raw: string): string | null;
}

/** Build a registry over `adapters`, in that match order. */
export function createReferenceRegistry(adapters: readonly RefReadAdapter[]): ReferenceRegistry {
	const ADAPTERS = [...adapters];

	function matchExternalRefCandidates(
		url: URL,
	): readonly { adapter: RefReadAdapter; ref: ExternalRef }[] {
		const candidates: { adapter: RefReadAdapter; ref: ExternalRef }[] = [];
		for (const adapter of ADAPTERS) {
			const ref = adapter.match(url);
			if (ref !== null) candidates.push({ adapter, ref });
		}
		return candidates;
	}

	function matchExternalRef(url: URL): { adapter: RefReadAdapter; ref: ExternalRef } | null {
		return matchExternalRefCandidates(url)[0] ?? null;
	}

	return {
		adapterFor: (provider) => ADAPTERS.find((a) => a.provider === provider) ?? null,
		allAdapters: () => ADAPTERS,
		matchExternalRefCandidates,
		matchExternalRef,
		matchCodeLinkUrl(url) {
			for (const adapter of ADAPTERS) {
				if (!isCodeLinkProvider(adapter.provider)) continue;
				const link = adapter.matchCodeLink?.(url);
				if (link !== undefined && link !== null) return { provider: adapter.provider, link };
			}
			return null;
		},
		matchExternalRefUrl(raw) {
			let url: URL;
			try {
				url = new URL(raw);
			} catch {
				return null;
			}
			return matchExternalRef(url)?.ref.url ?? null;
		},
	};
}

const DEFAULT_REGISTRY = createReferenceRegistry(REFERENCE_ADAPTERS);

export const adapterFor = DEFAULT_REGISTRY.adapterFor;
export const allAdapters = DEFAULT_REGISTRY.allAdapters;
export const matchExternalRefCandidates = DEFAULT_REGISTRY.matchExternalRefCandidates;
export const matchExternalRef = DEFAULT_REGISTRY.matchExternalRef;
export const matchCodeLinkUrl = DEFAULT_REGISTRY.matchCodeLinkUrl;
export const matchExternalRefUrl = DEFAULT_REGISTRY.matchExternalRefUrl;
