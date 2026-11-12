import type { CodeLinkRef, ExternalRef } from "../contract.ts";
import { hostKey, servedHost, servedHosts, type ServedHosts } from "../hosts.ts";
import { parseBranchTail } from "./git-branch.ts";

const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const NUMBER = /^[0-9]{1,9}$/;

export const GITLAB_PUBLIC_HOST = "gitlab.com";

export interface GitlabHostsOptions {
	readonly hosts?: readonly string[];
}

export interface GitlabGrammar {
	readonly served: ServedHosts;
	match(url: URL): ExternalRef | null;
	matchCodeLink(url: URL): CodeLinkRef | null;
	canonical(
		host: string,
		projectPath: string,
		form: "issues" | "merge_requests",
		iid: number | string,
	): ExternalRef;
}

const RESERVED_ROOTS = new Set([
	"-",
	"admin",
	"api",
	"dashboard",
	"explore",
	"groups",
	"help",
	"projects",
	"public",
	"s",
	"search",
	"snippets",
	"users",
]);

export function gitlabGrammar(options: GitlabHostsOptions = {}): GitlabGrammar {
	const served = servedHosts(GITLAB_PUBLIC_HOST, options.hosts);

	function canonical(
		host: string,
		projectPath: string,
		form: "issues" | "merge_requests",
		iid: number | string,
	): ExternalRef {
		const isIssue = form === "issues";
		return {
			provider: "gitlab",
			key: hostKey(served, host, `${projectPath}${isIssue ? "#" : "!"}${iid}`),
			url: `https://${host}/${projectPath}/-/${form}/${iid}`,
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
		const dash = segments.indexOf("-");
		if (dash < 2 || segments.length < dash + 3) return null;
		const projectSegments = segments.slice(0, dash);
		for (const segment of projectSegments) {
			if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null;
		}
		const form = segments[dash + 1];
		const iidRaw = segments[dash + 2] ?? "";
		if (form !== "issues" && form !== "work_items" && form !== "merge_requests") return null;
		if (!NUMBER.test(iidRaw)) return null;
		const iid = String(Number(iidRaw));
		if (iid !== iidRaw || iid === "0") return null;
		return canonical(
			host,
			projectSegments.join("/"),
			form === "merge_requests" ? "merge_requests" : "issues",
			iid,
		);
	}

	function matchCodeLink(url: URL): CodeLinkRef | null {
		const host = urlHost(url);
		if (host === null) return null;
		const segments = url.pathname.split("/").filter((s) => s.length > 0);
		const dash = segments.indexOf("-");

		if (dash === -1) {
			if (segments.length < 2) return null;
			const first = segments[0];
			if (first === undefined || RESERVED_ROOTS.has(first.toLowerCase())) return null;
			const path = [...segments];
			const leaf = path[path.length - 1];
			if (leaf !== undefined && leaf.endsWith(".git")) path[path.length - 1] = leaf.slice(0, -4);
			for (const segment of path) {
				if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null;
			}
			const projectPath = path.join("/");
			return {
				kind: "repo",
				repoPath: projectPath,
				url: `https://${host}/${projectPath}`,
			};
		}

		if (dash < 2) return null;
		const projectSegments = segments.slice(0, dash);
		for (const segment of projectSegments) {
			if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null;
		}
		const projectPath = projectSegments.join("/");
		const form = segments[dash + 1];

		if (form === "merge_requests") {
			const iidRaw = segments[dash + 2] ?? "";
			if (!NUMBER.test(iidRaw)) return null;
			const iid = String(Number(iidRaw));
			if (iid !== iidRaw || iid === "0") return null;
			return {
				kind: "pr",
				repoPath: projectPath,
				number: Number(iid),
				url: canonical(host, projectPath, "merge_requests", iid).url,
			};
		}

		if (form === "tree") {
			const tail = parseBranchTail(segments.slice(dash + 2));
			if (tail === null) return null;
			return {
				kind: "branch",
				repoPath: projectPath,
				branch: tail.branch,
				url: `https://${host}/${projectPath}/-/tree/${tail.canonicalTail}`,
			};
		}

		return null;
	}

	return { served, match, matchCodeLink, canonical };
}

const DEFAULT_GRAMMAR = gitlabGrammar();

export const matchGitlabUrl: (url: URL) => ExternalRef | null = DEFAULT_GRAMMAR.match;

export const matchGitlabCodeLink: (url: URL) => CodeLinkRef | null = DEFAULT_GRAMMAR.matchCodeLink;

export function parseGitlabCanonical(
	ref: ExternalRef,
): { host: string; projectPath: string; form: "issues" | "merge_requests"; iid: string } | null {
	let url: URL;
	try {
		url = new URL(ref.url);
	} catch {
		return null;
	}
	const segments = url.pathname.split("/").filter((s) => s.length > 0);
	const dash = segments.indexOf("-");
	if (dash < 2) return null;
	const form = segments[dash + 1];
	const iid = segments[dash + 2];
	if ((form !== "issues" && form !== "merge_requests") || iid === undefined) return null;
	return { host: url.hostname.toLowerCase(), projectPath: segments.slice(0, dash).join("/"), form, iid };
}
