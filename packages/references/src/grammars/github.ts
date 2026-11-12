import type { CodeLinkRef, ExternalRef } from "../contract.ts";
import { hostKey, servedHost, servedHosts, type ServedHosts } from "../hosts.ts";
import { parseBranchTail } from "./git-branch.ts";

const OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/;
const SEGMENT = /^[A-Za-z0-9_.-]{1,100}$/;
const NUMBER = /^[0-9]{1,9}$/;

export const GITHUB_PUBLIC_HOST = "github.com";

export interface GithubHostsOptions {
	readonly hosts?: readonly string[];
}

export interface GithubGrammar {
	readonly served: ServedHosts;
	match(url: URL): ExternalRef | null;
	matchCodeLink(url: URL): CodeLinkRef | null;
	canonical(host: string, repo: string, form: "issues" | "pull", n: number | string): ExternalRef;
}

const RESERVED_ROOTS = new Set([
	"about",
	"apps",
	"collections",
	"contact",
	"customer-stories",
	"enterprise",
	"explore",
	"features",
	"issues",
	"join",
	"login",
	"marketplace",
	"new",
	"notifications",
	"organizations",
	"orgs",
	"pricing",
	"pulls",
	"security",
	"settings",
	"site",
	"sponsors",
	"topics",
	"trending",
	"users",
	"dashboard",
	"codespaces",
]);

export function githubGrammar(options: GithubHostsOptions = {}): GithubGrammar {
	const served = servedHosts(GITHUB_PUBLIC_HOST, options.hosts);

	function canonical(
		host: string,
		repo: string,
		form: "issues" | "pull",
		n: number | string,
	): ExternalRef {
		return {
			provider: "github",
			key: hostKey(served, host, `${repo}#${n}`),
			url: `https://${host}/${repo}/${form}/${n}`,
		};
	}

	function urlHost(url: URL): string | null {
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.port !== "") return null;
		return servedHost(served, url.hostname);
	}

	function match(url: URL): ExternalRef | null {
		const host = urlHost(url);
		if (host === null) return null;
		const segments = url.pathname.split("/").filter((s) => s.length > 0);
		if (segments.length < 4) return null;
		const [owner, repo, form, number] = segments;
		if (owner === undefined || repo === undefined || form === undefined || number === undefined) {
			return null;
		}
		if (!OWNER.test(owner)) return null;
		if (!SEGMENT.test(repo) || repo === "." || repo === "..") return null;
		if (form !== "issues" && form !== "pull") return null;
		if (!NUMBER.test(number)) return null;
		const n = String(Number(number));
		if (n !== number || n === "0") return null;
		return canonical(host, `${owner}/${repo}`, form, n);
	}

	function matchCodeLink(url: URL): CodeLinkRef | null {
		const host = urlHost(url);
		if (host === null) return null;
		const segments = url.pathname.split("/").filter((s) => s.length > 0);

		const ref = match(url);
		if (ref !== null) {
			const parsed = parseGithubCanonical(ref);
			if (parsed === null) return null;
			return {
				kind: parsed.form === "pull" ? "pr" : "issue",
				repoPath: `${parsed.owner}/${parsed.repo}`,
				number: Number(parsed.n),
				url: ref.url,
			};
		}

		const [owner, repoRaw] = segments;
		if (owner === undefined || repoRaw === undefined) return null;
		if (!OWNER.test(owner)) return null;

		if (segments.length === 2) {
			if (RESERVED_ROOTS.has(owner.toLowerCase())) return null;
			const repo = repoRaw.endsWith(".git") ? repoRaw.slice(0, -4) : repoRaw;
			if (!SEGMENT.test(repo) || repo === "." || repo === "..") return null;
			return {
				kind: "repo",
				repoPath: `${owner}/${repo}`,
				url: `https://${host}/${owner}/${repo}`,
			};
		}

		if (segments.length >= 4 && segments[2] === "tree") {
			if (!SEGMENT.test(repoRaw) || repoRaw === "." || repoRaw === "..") return null;
			const tail = parseBranchTail(segments.slice(3));
			if (tail === null) return null;
			return {
				kind: "branch",
				repoPath: `${owner}/${repoRaw}`,
				branch: tail.branch,
				url: `https://${host}/${owner}/${repoRaw}/tree/${tail.canonicalTail}`,
			};
		}

		return null;
	}

	return { served, match, matchCodeLink, canonical };
}

const DEFAULT_GRAMMAR = githubGrammar();

export const matchGithubUrl: (url: URL) => ExternalRef | null = DEFAULT_GRAMMAR.match;

export const matchGithubCodeLink: (url: URL) => CodeLinkRef | null = DEFAULT_GRAMMAR.matchCodeLink;

export function parseGithubCanonical(
	ref: ExternalRef,
): { host: string; owner: string; repo: string; form: "issues" | "pull"; n: string } | null {
	let url: URL;
	try {
		url = new URL(ref.url);
	} catch {
		return null;
	}
	const segments = url.pathname.split("/").filter((s) => s.length > 0);
	const [owner, repo, form, n] = segments;
	if (owner === undefined || repo === undefined || n === undefined) return null;
	if (form !== "issues" && form !== "pull") return null;
	return { host: url.hostname.toLowerCase(), owner, repo, form, n };
}
