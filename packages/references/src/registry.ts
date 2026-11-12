import type { CodeLinkProviderId, CodeLinkRef, ExternalRef, ProviderId, RefReadAdapter } from "./contract.ts";
import { createGithubAdapter, githubAdapter } from "./adapters/github.ts";
import { createGitlabAdapter, gitlabAdapter } from "./adapters/gitlab.ts";
import { linearAdapter } from "./adapters/linear.ts";
import { GITHUB_PUBLIC_HOST, type GithubHostsOptions } from "./grammars/github.ts";
import { GITLAB_PUBLIC_HOST, type GitlabHostsOptions } from "./grammars/gitlab.ts";
import { apiOrigin, servedHosts } from "./hosts.ts";

const LINEAR_HOST = "linear.app";

export const REFERENCE_ADAPTERS: readonly RefReadAdapter[] = [
	githubAdapter,
	gitlabAdapter,
	linearAdapter,
];

export interface ReferenceAdapterHosts {
	readonly github?: GithubHostsOptions;
	readonly gitlab?: GitlabHostsOptions;
}

export function createReferenceAdapters(hosts: ReferenceAdapterHosts = {}): readonly RefReadAdapter[] {
	const github = servedHosts(GITHUB_PUBLIC_HOST, hosts.github?.hosts);
	const gitlab = servedHosts(GITLAB_PUBLIC_HOST, hosts.gitlab?.hosts);
	const publicHosts = [GITHUB_PUBLIC_HOST, GITLAB_PUBLIC_HOST, LINEAR_HOST];
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

function isCodeLinkProvider(provider: ProviderId): provider is CodeLinkProviderId {
	return provider === "github" || provider === "gitlab" || provider === "bitbucket";
}

export interface ReferenceRegistry {
	adapterFor(provider: string): RefReadAdapter | null;
	allAdapters(): readonly RefReadAdapter[];
	matchExternalRefCandidates(url: URL): readonly { adapter: RefReadAdapter; ref: ExternalRef }[];
	matchExternalRef(url: URL): { adapter: RefReadAdapter; ref: ExternalRef } | null;
	matchCodeLinkUrl(url: URL): { provider: CodeLinkProviderId; link: CodeLinkRef } | null;
	matchExternalRefUrl(raw: string): string | null;
}

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
