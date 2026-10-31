// Source: apps/rooms/src/external-refs/gitlab.ts (match, matchCodeLink, parseCanonical) merged with apps/web/src/components/external-refs/match.ts (matchGitlab, matchGitlabCodeLink) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// The server grammar is kept byte for byte; the client copy accepted the same URLs with the same canonicals, so it is retired, not merged in.
//
// HOSTS: gitlab.com and www.gitlab.com by default, exactly as Workspaces.
// `gitlabGrammar({ hosts })` adds self-managed instances (hosts.ts): the
// host checks accept them, and the canonical URL carries the matched host
// (www.gitlab.com reads as gitlab.com). gitlab.com canonicals and keys are
// byte-identical to Workspaces'; another host's key carries `host:`. The
// adapter asks the port for a credential by the canonical URL's host and
// reads that host's own API.
//
// The `/-/` separator makes parsing reliable at any group-nesting depth:
// everything before it is the project path, everything after is the
// resource + IID. Modern GitLab serves issues as `/-/work_items/{iid}` and
// still honors `/-/issues/{iid}`: both match, both canonicalize to the
// issues form (same REST endpoint).

import type { CodeLinkRef, ExternalRef } from "../contract.ts";
import { hostKey, servedHost, servedHosts, type ServedHosts } from "../hosts.ts";
import { parseBranchTail } from "./git-branch.ts";

/** Path segments: GitLab's namespace/project charset, no dot-only tricks. */
const SEGMENT = /^[A-Za-z0-9_.-]+$/;
const NUMBER = /^[0-9]{1,9}$/;

/** The public GitLab host. */
export const GITLAB_PUBLIC_HOST = "gitlab.com";

/** Options for a GitLab grammar or adapter. */
export interface GitlabHostsOptions {
	/** Self-managed GitLab hosts served beside gitlab.com: bare lowercase
	 * hostnames ("gitlab.acme.corp"). A host with a port is not supported. */
	readonly hosts?: readonly string[];
}

/** One host-configured GitLab grammar. */
export interface GitlabGrammar {
	/** Every host this grammar serves, gitlab.com included. */
	readonly served: ServedHosts;
	/** Issue and merge request URLs (see below). */
	match(url: URL): ExternalRef | null;
	/** Project, branch and merge request code links (see below). */
	matchCodeLink(url: URL): CodeLinkRef | null;
	/** The canonical reference for one item on a served host. */
	canonical(
		host: string,
		projectPath: string,
		form: "issues" | "merge_requests",
		iid: number | string,
	): ExternalRef;
}

/** Reserved first path segments that are gitlab.com SITE surfaces, never a
 * group: the bare-project form's denylist. One segment (`gitlab.com/acme`)
 * is a profile or group home, never a project: rejected by the 2+ segment
 * rule below, not this list. */
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

/** A GitLab grammar serving gitlab.com plus `options.hosts`. Throws a
 * TypeError for a host that is not a bare hostname. */
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

	/** The served host of an http(s) URL with no port, or null. */
	function urlHost(url: URL): string | null {
		if (url.protocol !== "https:" && url.protocol !== "http:") return null;
		if (url.port !== "") return null;
		return servedHost(served, url.hostname);
	}

	/**
	 * Recognize issue and MR URLs on a served host at any namespace depth:
	 *   https://{host}/{group[/subgroup…]}/{project}/-/issues/{iid}
	 *   https://{host}/{…}/-/work_items/{iid}        (the modern alias)
	 *   https://{host}/{…}/-/merge_requests/{iid}
	 * The key is GitLab's own sigil convention: `path#123` for issues,
	 * `path!45` for MRs, which also carries the kind.
	 */
	function match(url: URL): ExternalRef | null {
		const host = urlHost(url);
		if (host === null) return null;
		const segments = url.pathname.split("/").filter((s) => s.length > 0);
		const dash = segments.indexOf("-");
		// At least group/project before `/-/`, and form + iid right after it.
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

	/**
	 * CODE LINK recognition on a served host:
	 *   repo    https://{host}/{group[/sub...]}/{project}
	 *           (2+ segments, none "-", ".git"/"/", ?query, #fragment dropped;
	 *           the group-vs-project ambiguity is accepted: a group pasted by
	 *           mistake is one dead association, never an integrity break)
	 *   branch  https://{host}/{path...}/-/tree/{branch...}
	 *           (the dash-sigil split at any nesting depth; the whole tail
	 *           after tree/ is the branch)
	 *   pr      https://{host}/{path...}/-/merge_requests/{iid}
	 *           (the reference grammar narrowed to merge_requests; work_items
	 *           and issues forms answer null here: not a PR)
	 */
	function matchCodeLink(url: URL): CodeLinkRef | null {
		const host = urlHost(url);
		if (host === null) return null;
		const segments = url.pathname.split("/").filter((s) => s.length > 0);
		const dash = segments.indexOf("-");

		if (dash === -1) {
			// The bare-project form: 2+ segments after the reserved-root denylist.
			if (segments.length < 2) return null;
			const first = segments[0];
			if (first === undefined || RESERVED_ROOTS.has(first.toLowerCase())) return null;
			const path = [...segments];
			// `.git` is clone-URL noise on the project leaf only.
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

		// Dash-sigil forms: at least group/project before `/-/`, then the kind marker.
		if (dash < 2) return null;
		const projectSegments = segments.slice(0, dash);
		for (const segment of projectSegments) {
			if (!SEGMENT.test(segment) || segment === "." || segment === "..") return null;
		}
		const projectPath = projectSegments.join("/");
		const form = segments[dash + 1];

		if (form === "merge_requests") {
			// The reference grammar's iid rules, byte-identical canonical to the
			// reference chip's: one resolve-cache identity.
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

		// work_items, issues, and every other dash form: a reference at most,
		// never a code link.
		return null;
	}

	return { served, match, matchCodeLink, canonical };
}

const DEFAULT_GRAMMAR = gitlabGrammar();

/** gitlab.com issue and merge request URLs (the default grammar). */
export const matchGitlabUrl: (url: URL) => ExternalRef | null = DEFAULT_GRAMMAR.match;

/** gitlab.com code links (the default grammar). */
export const matchGitlabCodeLink: (url: URL) => CodeLinkRef | null = DEFAULT_GRAMMAR.matchCodeLink;

/** Re-parse the grammar's OWN canonical URL at resolve time. */
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
