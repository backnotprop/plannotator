// Source: apps/rooms/src/external-refs/github-pulls.ts, plus GITHUB_API_BASE and githubHeaders lifted from apps/rooms/src/external-refs/github-app.ts (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Changed: installationAuth (which minted an App token) is githubAuth, which asks the port; reads take the port's wrapped fetch.
//
// GitHub's picker reads. In Workspaces these run on a per-call
// installation token of the team's GitHub App installation and need only
// Metadata read and Pull requests read (Issues read for `include:
// "issues"`). Here the token comes from the port.
//
//   scopes    GET /installation/repositories: the repositories the
//             installation covers, each `owner/repo`. Installation tokens
//             only: a user token has no installation to list.
//   search    GET /repos/{owner}/{repo}/pulls?state=open: one page of a
//             repository's open pull requests (the scope is required).
//             With `include: "issues"`: GET /repos/{owner}/{repo}/issues?state=open,
//             one page of open issues and pull requests together, most
//             recently updated first (GitHub's issues list carries both; a
//             pull request's item has a `pull_request` key).
//   the diff  github-pull-diff.ts (the pinned diff read and the size facts).
//
// HOSTS: every read runs against one host, github.com by default. A
// GitHub Enterprise host (the adapter's `hosts` option) reads its own API
// (githubApiBase) with a credential asked for that host; a host the
// adapter does not serve is a scope error with no credential asked.
//
// Payload shapes: docs.github.com/en/rest/pulls/pulls and
// /rest/apps/installations (2022-11-28), read 2026-09-24.

import type {
	ExternalRef,
	ExternalRefFacts,
	ExternalRefFailure,
	ExternalRefState,
	ReferenceListQuery,
	ScopesResult,
	SearchResult,
} from "../contract.ts";
import { providerFetch, providerUserAgent } from "../fetch.ts";
import { type GithubGrammar, githubGrammar, parseGithubCanonical } from "../grammars/github.ts";
import { apiOrigin, readHost } from "../hosts.ts";
import {
	asObject,
	checkListQuery,
	connectionNames,
	connectionNodes,
	keepsRow,
	labelsComplete,
	LIST_PAGE_SIZE,
	nextCursor,
	objectAt,
	postGraphql,
} from "../list-query.ts";
import { credentialFor, type FetchLike, type ReferencePort } from "../port.ts";

export const GITHUB_API_BASE = "https://api.github.com";

/** The item host GitHub credentials are asked for by default. */
export const GITHUB_HOST = "github.com";

/** True when `host` is GitHub Enterprise Server: its API sits under
 * paths on the host itself, not on an api. host. */
function isEnterpriseServer(host: string): boolean {
	return apiOrigin("github", host) === `https://${host.toLowerCase()}`;
}

/** The REST API base for an item host: api.github.com for github.com,
 * api.{host} for GitHub Enterprise Cloud with data residency (*.ghe.com),
 * and https://{host}/api/v3 for GitHub Enterprise Server. This is a base
 * URL, not an origin: a port binds its fetch to `apiOrigin("github", host)`. */
export function githubApiBase(host: string): string {
	const origin = apiOrigin("github", host);
	return isEnterpriseServer(host) ? `${origin}/api/v3` : origin;
}

/** The GraphQL endpoint for an item host (same three cases), on the same
 * `apiOrigin("github", host)`. */
export function githubGraphqlUrl(host: string): string {
	const origin = apiOrigin("github", host);
	return isEnterpriseServer(host) ? `${origin}/api/graphql` : `${origin}/graphql`;
}

/** One GitHub REST API as the reads call it: the item host, its API base,
 * the port's wrapped fetch, and the port's user agent. */
export interface GithubApi {
	readonly host: string;
	readonly base: string;
	readonly fetch: FetchLike;
	readonly userAgent: string;
}

/** The GitHub API for a port and an item host (default github.com). */
export function githubApi(port: ReferencePort, host: string = GITHUB_HOST): GithubApi {
	return {
		host,
		base: githubApiBase(host),
		fetch: providerFetch(port),
		userAgent: providerUserAgent(port),
	};
}

/** GitHub REST headers. */
export function githubHeaders(userAgent: string, authorization?: string): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/vnd.github+json",
		"user-agent": userAgent,
		"x-github-api-version": "2022-11-28",
	};
	if (authorization !== undefined) headers.authorization = authorization;
	return headers;
}

export const REPO = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?\/[A-Za-z0-9_.-]{1,100}$/;
const PAGE = /^[1-9][0-9]{0,3}$/;
/** GitHub's own page size ceiling for both lists. */
const PER_PAGE = 100;

/** The authorization for a credentialed GitHub read on `host`. No
 * credential is not_linked: the picker and pull reads have no anonymous
 * rung. */
export async function githubAuth(
	port: ReferencePort,
	host: string = GITHUB_HOST,
): Promise<
	| { ok: true; authorization: string; kind: "installation" | "bearer" }
	| ExternalRefFailure
> {
	const credential = await credentialFor(port, "github", host, ["installation", "bearer"]);
	if (credential === null) return { ok: false, reason: "not_linked" };
	if (credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	return {
		ok: true,
		authorization: `Bearer ${credential.token}`,
		kind: credential.kind === "installation" ? "installation" : "bearer",
	};
}

export function failure(status: number): ExternalRefFailure {
	if (status === 404) return { ok: false, reason: "not_linked" };
	if (status === 403 || status === 429) {
		return { ok: false, reason: "not_resolvable", rateLimited: true };
	}
	return { ok: false, reason: "not_resolvable" };
}

export async function get(
	api: GithubApi,
	path: string,
	authorization: string,
	accept?: string,
): Promise<{ ok: true; response: Response } | { ok: false; status: number | null }> {
	const headers = githubHeaders(api.userAgent, authorization);
	if (accept !== undefined) headers.accept = accept;
	try {
		const response = await api.fetch(`${api.base}${path}`, { headers });
		return response.status === 200
			? { ok: true, response }
			: { ok: false, status: response.status };
	} catch {
		return { ok: false, status: null };
	}
}

/** The page number of a `Link: <...page=N>; rel="next"` header, if any. */
function nextPage(response: Response): string | undefined {
	for (const part of (response.headers.get("link") ?? "").split(",")) {
		if (!/rel="next"/u.test(part)) continue;
		const target = /<([^>]+)>/u.exec(part)?.[1];
		if (target === undefined) return undefined;
		try {
			return new URL(target).searchParams.get("page") ?? undefined;
		} catch {
			return undefined;
		}
	}
	return undefined;
}

export function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** Issue state → {label, tone}. GitHub's word for any closed issue is
 * "Closed"; state_reason (completed | not_planned | duplicate | reopened |
 * null) is cheaply in the payload, so a not-planned or duplicate close
 * earns the closed tone and every other close the done tone. A null reason
 * is an issue closed before GitHub had close reasons, which GitHub itself
 * shows as completed. This is the one mapping: list rows and reference
 * chips both read it (lowercase words; GraphQL's enums are lowercased). */
export function issueState(state: string, stateReason: string | null): ExternalRefState {
	if (state === "open") return { label: "Open", tone: "open" };
	if (stateReason === "not_planned" || stateReason === "duplicate") {
		return { label: "Closed", tone: "closed" };
	}
	return { label: "Closed", tone: "done" };
}

// ── list(query): GraphQL ─────────────────────────────────────────────────────
//
// With no text: repository.issues with filterBy and orderBy, which has no
// result cap. filterBy carries the state, the assignee, the FIRST label
// (filterBy.labels ORs its labels, so one is exact) and the milestone by
// number; the row re-check (keepsRow) requires every other label. The
// milestone number comes from repository.milestones(query:), a title
// search, paged until the exact title is found (MILESTONE_PAGES).
// With text: the search API, which answers at most 1,000 results per query
// (GitHub's cap), so a text list ends after 10 pages of 100 with no cursor.
// Docs: docs.github.com/en/graphql/reference/objects#repository (issues,
// milestones, IssueFilters, IssueOrder), /queries#search, and
// docs.github.com/en/search-github/searching-on-github/searching-issues-and-pull-requests.

/** Labels read per row: GraphQL's largest page. A row whose labels run
 * past this is kept whole by the label re-check (labelsComplete). */
const ROW_LABELS = 100;
/** Milestone title-search pages read (100 each) before the exact title is
 * given up on and the milestone goes to search as a qualifier instead. */
const MILESTONE_PAGES = 10;
/** GitHub's search query limit, in characters, not counting qualifiers. */
const SEARCH_TEXT_LIMIT = 256;
/** Assignees read per row: GitHub allows at most 10 on an issue. */
const ROW_ASSIGNEES = 20;

const LIST_ISSUE_FIELDS = `number title url state stateReason createdAt updatedAt
      author { login }
      labels(first: ${ROW_LABELS}) { pageInfo { hasNextPage } nodes { name } }
      assignees(first: ${ROW_ASSIGNEES}) { nodes { login } }
      milestone { title }`;

const REPOSITORY_ISSUES_QUERY = `query($owner: String!, $name: String!, $first: Int!, $after: String, $filterBy: IssueFilters, $orderBy: IssueOrder) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $after, filterBy: $filterBy, orderBy: $orderBy) {
      pageInfo { hasNextPage endCursor }
      nodes { ${LIST_ISSUE_FIELDS} }
    }
  }
}`;

const MILESTONES_QUERY = `query($owner: String!, $name: String!, $query: String!, $after: String) {
  repository(owner: $owner, name: $name) {
    milestones(first: 100, after: $after, query: $query, states: [OPEN, CLOSED]) {
      pageInfo { hasNextPage endCursor }
      nodes { number title }
    }
  }
}`;

const SEARCH_ISSUES_QUERY = `query($q: String!, $first: Int!, $after: String) {
  search(query: $q, type: ISSUE, first: $first, after: $after) {
    pageInfo { hasNextPage endCursor }
    nodes { ... on Issue { ${LIST_ISSUE_FIELDS} } }
  }
}`;

/** A GitHub login: letters, digits and hyphens, plus `_` for Enterprise
 * Managed Users (`mona_acme`; every *.ghe.com user is one), and `[bot]`.
 * It is sent as a GraphQL variable, or as a search value where neither
 * `_` nor `-` can start a qualifier. */
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9_-]{0,99})(?:\[bot\])?$/;

/** A quoted search qualifier value (`label:"..."`). A colon inside quotes
 * cannot start another qualifier, so `type: bug` stays as written. A value
 * holding `"` or `\` cannot be quoted faithfully and is refused before
 * this (QUOTE_BREAKING); line breaks become spaces. */
function quotedValue(value: string): string {
	return value.replace(/[\r\n]/gu, " ").replace(/\s+/gu, " ").trim();
}

/** Characters a quoted search value cannot carry as written. */
const QUOTE_BREAKING = /["\\]/u;

/** Free text as search terms. Quotes, backslashes and parentheses are
 * removed, then every word is quoted, so no word can act as a qualifier
 * (`repo:other/x`) or an operator (OR, AND, NOT, a leading `-`) and widen
 * the search past `repo:`. Rows from another repository are still dropped
 * after the read (listFacts), as a backstop. */
function quotedWords(text: string): string {
	return text
		.replace(/["\\()]/gu, " ")
		.split(/\s+/u)
		.filter((word) => word.length > 0)
		.map((word) => `"${word}"`)
		.join(" ");
}

/** One GraphQL query on `api`'s host, answered as data or a failure. */
async function githubGraphql(
	api: GithubApi,
	authorization: string,
	query: string,
	variables: Record<string, unknown>,
): Promise<{ ok: true; data: Record<string, unknown> } | ExternalRefFailure> {
	const answer = await postGraphql(
		api.fetch,
		githubGraphqlUrl(api.host),
		githubHeaders(api.userAgent, authorization),
		query,
		variables,
	);
	if (!answer.ok) {
		return answer.status === null ? { ok: false, reason: "not_resolvable" } : failure(answer.status);
	}
	if (answer.errors.some((error) => asObject(error)?.["type"] === "RATE_LIMITED")) {
		return { ok: false, reason: "not_resolvable", rateLimited: true };
	}
	if (answer.data === null) return { ok: false, reason: "not_resolvable" };
	return { ok: true, data: answer.data };
}

interface PullListItem {
	number?: unknown;
	title?: unknown;
	html_url?: unknown;
	draft?: unknown;
	user?: { login?: unknown } | null;
	created_at?: unknown;
	updated_at?: unknown;
}

interface IssueListItem extends PullListItem {
	/** Present exactly when the item is a pull request (issues doc). */
	pull_request?: unknown;
}

/** The picker reads of one GitHub grammar: its hosts, its canonicals. */
export interface GithubPickerReads {
	scopes(port: ReferencePort, options?: { readonly host?: string }): Promise<ScopesResult>;
	search(
		args: { query: string; scope?: string; cursor?: string; include?: "issues"; host?: string },
		port: ReferencePort,
	): Promise<SearchResult>;
	list(query: ReferenceListQuery, port: ReferencePort): Promise<SearchResult>;
}

/** The picker reads for the hosts `grammar` serves. */
export function githubPickerReads(grammar: GithubGrammar): GithubPickerReads {
	function pullFacts(host: string, repo: string, pull: PullListItem): ExternalRefFacts | null {
		const n = typeof pull.number === "number" && Number.isInteger(pull.number) ? pull.number : null;
		const title = str(pull.title);
		if (n === null || title === undefined) return null;
		return {
			ref: grammar.canonical(host, repo, "pull", n),
			kind: "change",
			shortId: `${repo.split("/")[1]}#${n}`,
			title,
			state:
				pull.draft === true
					? { label: "Draft", tone: "open" }
					: { label: "Open", tone: "open" },
			author: str(pull.user?.login),
			createdAt: str(pull.created_at),
			updatedAt: str(pull.updated_at),
		};
	}

	function issueFacts(host: string, repo: string, issue: IssueListItem): ExternalRefFacts | null {
		if (issue.pull_request !== undefined && issue.pull_request !== null) {
			return pullFacts(host, repo, issue);
		}
		const n =
			typeof issue.number === "number" && Number.isInteger(issue.number) ? issue.number : null;
		const title = str(issue.title);
		if (n === null || title === undefined) return null;
		return {
			ref: grammar.canonical(host, repo, "issues", n),
			kind: "issue",
			shortId: `${repo.split("/")[1]}#${n}`,
			title,
			state: { label: "Open", tone: "open" },
			author: str(issue.user?.login),
			createdAt: str(issue.created_at),
			updatedAt: str(issue.updated_at),
		};
	}

	/** The installation's repositories on one host, every page. */
	async function scopes(
		port: ReferencePort,
		options: { readonly host?: string } = {},
	): Promise<ScopesResult> {
		const host = readHost(grammar.served, options.host);
		if (host === null) return { ok: false, reason: "not_resolvable", field: "scope" };
		const auth = await githubAuth(port, host);
		if (!auth.ok) return auth;
		// GET /installation/repositories answers only an installation token.
		if (auth.kind !== "installation") return { ok: false, reason: "not_linked" };
		const api = githubApi(port, host);
		const items: { id: string; label: string }[] = [];
		let page: string | undefined = "1";
		while (page !== undefined) {
			const answer = await get(
				api,
				`/installation/repositories?per_page=${PER_PAGE}&page=${page}`,
				auth.authorization,
			);
			if (!answer.ok)
				return answer.status === null
					? { ok: false, reason: "not_resolvable" }
					: failure(answer.status);
			const body = (await answer.response.json().catch(() => null)) as {
				repositories?: { full_name?: unknown }[];
			} | null;
			if (body === null || !Array.isArray(body.repositories)) {
				return { ok: false, reason: "not_resolvable" };
			}
			for (const repo of body.repositories) {
				const name = str(repo.full_name);
				if (name !== undefined) items.push({ id: name, label: name });
			}
			page = nextPage(answer.response);
		}
		return { ok: true, items };
	}

	/** One page of a repository's open pull requests, newest first; with
	 * `include: "issues"`, one page of its open issues and pull requests
	 * together, most recently updated first. `query` narrows the page by title
	 * or number (GitHub's lists have no search parameter); the scope,
	 * `owner/repo`, is required, on `host` (default github.com). */
	async function search(
		args: { query: string; scope?: string; cursor?: string; include?: "issues"; host?: string },
		port: ReferencePort,
	): Promise<SearchResult> {
		const host = readHost(grammar.served, args.host);
		if (host === null || args.scope === undefined || !REPO.test(args.scope)) {
			return { ok: false, reason: "not_resolvable", field: "scope" };
		}
		if (args.cursor !== undefined && !PAGE.test(args.cursor)) {
			return { ok: false, reason: "not_resolvable", field: "cursor" };
		}
		const auth = await githubAuth(port, host);
		if (!auth.ok) return auth;
		const withIssues = args.include === "issues";
		const answer = await get(
			githubApi(port, host),
			withIssues
				? `/repos/${args.scope}/issues?state=open&sort=updated&direction=desc&per_page=${PER_PAGE}&page=${args.cursor ?? "1"}`
				: `/repos/${args.scope}/pulls?state=open&sort=created&direction=desc&per_page=${PER_PAGE}&page=${args.cursor ?? "1"}`,
			auth.authorization,
		);
		if (!answer.ok)
			return answer.status === null
				? { ok: false, reason: "not_resolvable" }
				: failure(answer.status);
		const body: unknown = await answer.response.json().catch(() => null);
		if (!Array.isArray(body)) return { ok: false, reason: "not_resolvable" };
		const query = args.query.trim().toLowerCase().replace(/^#/u, "");
		const items: ExternalRefFacts[] = [];
		for (const pull of body as IssueListItem[]) {
			const facts = withIssues
				? issueFacts(host, args.scope, pull)
				: pullFacts(host, args.scope, pull);
			if (facts === null) continue;
			if (
				query !== "" &&
				!facts.title.toLowerCase().includes(query) &&
				String(pull.number) !== query
			)
				continue;
			items.push(facts);
		}
		const cursor = nextPage(answer.response);
		return { ok: true, items, ...(cursor === undefined ? {} : { cursor }) };
	}

	/** One list node as facts, or null when it is not an issue of `scope`
	 * on the list's own `host` (the search API can answer other
	 * repositories; a list on host H answers refs on H only). */
	function listFacts(
		host: string,
		scope: string,
		node: Record<string, unknown>,
	): ExternalRefFacts | null {
		const url = str(node["url"]);
		const title = str(node["title"]);
		const state = str(node["state"]);
		if (url === undefined || title === undefined || state === undefined) return null;
		let ref: ExternalRef | null;
		try {
			ref = grammar.match(new URL(url));
		} catch {
			return null;
		}
		const parsed = ref === null ? null : parseGithubCanonical(ref);
		if (ref === null || parsed === null || parsed.form !== "issues" || parsed.host !== host) return null;
		if (`${parsed.owner}/${parsed.repo}`.toLowerCase() !== scope.toLowerCase()) return null;
		const milestone = str(objectAt(node, "milestone")?.["title"]);
		return {
			ref,
			kind: "issue",
			shortId: `${parsed.repo}#${parsed.n}`,
			title,
			state: issueState(state.toLowerCase(), str(node["stateReason"])?.toLowerCase() ?? null),
			author: str(objectAt(node, "author")?.["login"]),
			createdAt: str(node["createdAt"]),
			updatedAt: str(node["updatedAt"]),
			labels: connectionNames(node["labels"], "name"),
			assignees: connectionNames(node["assignees"], "login"),
			...(milestone === undefined ? {} : { milestone }),
		};
	}

	/** The number of the milestone titled `title` (case-insensitive), "none"
	 * when the repository has no such milestone, or "unknown" when the title
	 * search ran past MILESTONE_PAGES pages without it. */
	async function milestoneNumber(
		api: GithubApi,
		authorization: string,
		owner: string,
		name: string,
		title: string,
	): Promise<{ ok: true; number: number | "none" | "unknown" } | ExternalRefFailure> {
		const wanted = title.toLowerCase();
		let after: string | null = null;
		for (let page = 0; page < MILESTONE_PAGES; page++) {
			const answer = await githubGraphql(api, authorization, MILESTONES_QUERY, { owner, name, query: title, after });
			if (!answer.ok) return answer;
			const repository = objectAt(answer.data, "repository");
			if (repository === null) return { ok: false, reason: "not_linked" };
			const connection = objectAt(repository, "milestones");
			const found = connectionNodes(connection).find(
				(m) => typeof m["title"] === "string" && m["title"].toLowerCase() === wanted,
			);
			if (found !== undefined && typeof found["number"] === "number") return { ok: true, number: found["number"] };
			const next = nextCursor(connection?.["pageInfo"]);
			if (next === undefined) return { ok: true, number: "none" };
			after = next;
		}
		return { ok: true, number: "unknown" };
	}

	/** One page (up to 100) of a repository's issues, filtered: GraphQL
	 * repository.issues with filterBy and orderBy, or the search API when the
	 * query has text (see the section note: search answers at most 1,000
	 * results). Each row is re-checked after the read (host, repository,
	 * state, every label, milestone title), so a page can hold fewer than
	 * 100 rows and still carry a cursor. No credential is not_linked:
	 * GitHub's GraphQL API has no anonymous rung. */
	async function list(query: ReferenceListQuery, port: ReferencePort): Promise<SearchResult> {
		const checked = checkListQuery(query);
		if (!checked.ok) return checked;
		const q = checked.query;
		const host = readHost(grammar.served, q.host);
		if (host === null || q.scope === undefined || !REPO.test(q.scope)) {
			return { ok: false, reason: "not_resolvable", field: "scope" };
		}
		if (q.assignee !== undefined && !LOGIN.test(q.assignee)) {
			return { ok: false, reason: "not_resolvable", field: "filter" };
		}
		const text = quotedWords(q.text ?? "");
		// A search value that cannot be quoted as written, or text past
		// GitHub's search length limit, would answer an empty or failed page.
		const searchValues = [...q.labels, ...(q.milestone === undefined ? [] : [q.milestone])];
		if (
			q.text !== undefined &&
			(text.length > SEARCH_TEXT_LIMIT || searchValues.some((v) => QUOTE_BREAKING.test(v)))
		) {
			return { ok: false, reason: "not_resolvable", field: "filter" };
		}
		const scope = q.scope;
		const auth = await githubAuth(port, host);
		if (!auth.ok) return auth;
		const api = githubApi(port, host);
		const [owner, name] = scope.split("/") as [string, string];

		let milestone: number | "none" | "unknown" | undefined;
		if (q.text === undefined && q.milestone !== undefined) {
			const lookup = await milestoneNumber(api, auth.authorization, owner, name, q.milestone);
			if (!lookup.ok) return lookup;
			if (lookup.number === "none") return { ok: true, items: [] };
			milestone = lookup.number;
			if (milestone === "unknown" && searchValues.some((v) => QUOTE_BREAKING.test(v))) {
				return { ok: false, reason: "not_resolvable", field: "filter" };
			}
		}

		let connection: Record<string, unknown> | null;
		if (q.text !== undefined || milestone === "unknown") {
			const words = [`repo:${scope}`, "is:issue"];
			if (q.state !== "all") words.push(`is:${q.state}`);
			for (const label of q.labels) words.push(`label:"${quotedValue(label)}"`);
			if (q.assignee !== undefined) words.push(`assignee:${q.assignee}`);
			if (q.milestone !== undefined) words.push(`milestone:"${quotedValue(q.milestone)}"`);
			words.push(
				q.order === "created_asc" ? "sort:created-asc" : q.order === "created_desc" ? "sort:created-desc" : "sort:updated-desc",
			);
			if (text !== "") words.push(text);
			const answer = await githubGraphql(api, auth.authorization, SEARCH_ISSUES_QUERY, {
				q: words.join(" "),
				first: LIST_PAGE_SIZE,
				after: q.cursor ?? null,
			});
			if (!answer.ok) return answer;
			connection = objectAt(answer.data, "search");
		} else {
			const filterBy: Record<string, unknown> = {};
			if (q.state !== "all") filterBy["states"] = [q.state === "open" ? "OPEN" : "CLOSED"];
			// The first label only, where "any" and "every" agree; the re-check
			// requires the rest.
			const first = q.labels[0];
			if (first !== undefined) filterBy["labels"] = [first];
			if (q.assignee !== undefined) filterBy["assignee"] = q.assignee;
			if (typeof milestone === "number") filterBy["milestoneNumber"] = String(milestone);
			const answer = await githubGraphql(api, auth.authorization, REPOSITORY_ISSUES_QUERY, {
				owner,
				name,
				first: LIST_PAGE_SIZE,
				after: q.cursor ?? null,
				filterBy,
				orderBy: {
					field: q.order === "updated_desc" ? "UPDATED_AT" : "CREATED_AT",
					direction: q.order === "created_asc" ? "ASC" : "DESC",
				},
			});
			if (!answer.ok) return answer;
			const repository = objectAt(answer.data, "repository");
			// A repository the token cannot see answers null (NOT_FOUND).
			if (repository === null) return { ok: false, reason: "not_linked" };
			connection = objectAt(repository, "issues");
		}
		if (connection === null) return { ok: false, reason: "not_resolvable" };
		const items: ExternalRefFacts[] = [];
		for (const node of connectionNodes(connection)) {
			const facts = listFacts(host, scope, node);
			if (
				facts === null ||
				!keepsRow(q, {
					open: str(node["state"])?.toUpperCase() === "OPEN",
					labels: facts.labels ?? [],
					labelsComplete: labelsComplete(node["labels"]),
					milestone: facts.milestone,
				})
			)
				continue;
			items.push(facts);
		}
		const cursor = nextCursor(connection["pageInfo"]);
		return { ok: true, items, ...(cursor === undefined ? {} : { cursor }) };
	}

	return { scopes, search, list };
}

const DEFAULT_READS = githubPickerReads(githubGrammar());

/** The github.com installation's repositories, every page. */
export const githubScopes: GithubPickerReads["scopes"] = DEFAULT_READS.scopes;

/** One page of a github.com repository's open pull requests (or, with
 * `include: "issues"`, its open issues and pull requests). */
export const githubSearch: GithubPickerReads["search"] = DEFAULT_READS.search;

/** One filtered page of a github.com repository's issues. */
export const githubList: GithubPickerReads["list"] = DEFAULT_READS.list;
