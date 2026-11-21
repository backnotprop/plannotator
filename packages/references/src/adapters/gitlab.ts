// Source: apps/rooms/src/external-refs/gitlab.ts (resolve, headers, state mapping, the adapter object) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Cut: the form connect (baseUrl normalization, the /api/v4/user probe) and the sealed-secret parsing; the port supplies the token and its host.
//
// The GitLab adapter, read side: gitlab.com issues and merge requests,
// resolved over plain REST. createGitlabAdapter({ hosts }) also serves
// self-managed instances; each item reads its own host's API.
//
// PUBLIC RUNG ON: public gitlab.com projects answer with no credential at
// all ("return only public data when authentication isn't provided"), and
// an unauthenticated private project answers 404: existence hidden, mapped
// straight to not_linked.
//
// Verified against GitLab docs (2026-07-22):
//   REST + %2F path encoding: https://docs.gitlab.com/api/rest/
//   auth (PRIVATE-TOKEN):     https://docs.gitlab.com/api/rest/authentication/
//   issues (opened|closed):   https://docs.gitlab.com/api/issues/
//   MRs (opened|closed|merged|locked): https://docs.gitlab.com/api/merge_requests/

import type {
	ExternalRef,
	ExternalRefFacts,
	ExternalRefState,
	RefReadAdapter,
	ReferenceListQuery,
	ResolveResult,
	SearchResult,
} from "../contract.ts";
import { providerFetch, providerUserAgent } from "../fetch.ts";
import {
	type GitlabGrammar,
	gitlabGrammar,
	type GitlabHostsOptions,
	parseGitlabCanonical,
} from "../grammars/gitlab.ts";
import { apiOrigin, isMintedCanonical, readHost, servedHost } from "../hosts.ts";
import {
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
import { credentialFor, type ReferenceCredential, type ReferencePort } from "../port.ts";

/** The origin a GitLab item host serves its API from: the host itself
 * (`/api/v4` and `/api/graphql` live under it). The same as
 * `apiOrigin("gitlab", host)`, which a port binds its fetch to. */
export function gitlabApiBase(host: string): string {
	return apiOrigin("gitlab", host);
}

/** PRIVATE-TOKEN is the documented header for personal, group and project
 * access tokens (any `read_api` token). A `bearer` credential (an OAuth
 * token, such as glab's) rides `Authorization: Bearer`. */
function gitlabHeaders(userAgent: string, credential?: ReferenceCredential): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"user-agent": userAgent,
	};
	if (credential?.kind === "private-token") headers["PRIVATE-TOKEN"] = credential.token;
	if (credential?.kind === "bearer") headers.authorization = `Bearer ${credential.token}`;
	return headers;
}

// ── state mapping (GitLab's own words, three tones) ─────────────────────────

function gitlabState(state: string): ExternalRefState | null {
	if (state === "opened") return { label: "Open", tone: "open" };
	if (state === "closed") return { label: "Closed", tone: "closed" };
	if (state === "merged") return { label: "Merged", tone: "done" };
	// Rare and transitional: the MR is neither resolved nor rejected.
	if (state === "locked") return { label: "Locked", tone: "open" };
	return null;
}

interface GitlabItemPayload {
	title?: unknown;
	state?: unknown;
	author?: { username?: unknown } | null;
	created_at?: unknown;
	updated_at?: unknown;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

// ── resolve ─────────────────────────────────────────────────────────────────

async function resolveGitlab(
	grammar: GitlabGrammar,
	ref: ExternalRef,
	port: ReferencePort,
): Promise<ResolveResult> {
	const served = grammar.served;
	const parsed = parseGitlabCanonical(ref);
	if (parsed === null || !isMintedCanonical(grammar.match, ref.url)) {
		return { ok: false, reason: "not_resolvable" };
	}
	// The canonical URL's host picks the API and the credential; a ref on a
	// host this adapter does not serve is never read.
	const host = servedHost(served, parsed.host);
	if (host === null) return { ok: false, reason: "not_resolvable" };

	// The ladder: a credential whose host IS this URL's host reads with its
	// token; everything else (no credential, or a credential for another
	// instance, which credentialFor drops) rides the public rung
	// unauthenticated: the credential never leaves its own instance.
	const credential = await credentialFor(port, "gitlab", host, ["private-token", "bearer"]);
	if (credential !== null && credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	const token = credential ?? undefined;
	// The item host's own API, with or without a token (credentialFor only
	// returns a credential whose host is this host).
	const base = gitlabApiBase(host);

	// The namespaced-path rule: the whole project path, URL-encoded, is the id.
	const endpoint =
		`${base}/api/v4/projects/${encodeURIComponent(parsed.projectPath)}/` +
		`${parsed.form}/${parsed.iid}`;

	let response: Response;
	try {
		response = await providerFetch(port)(endpoint, {
			headers: gitlabHeaders(providerUserAgent(port), token),
		});
	} catch {
		return { ok: false, reason: "not_resolvable" };
	}
	// 401 with a token = the token is dead (revoked/expired): the reconnect
	// signal. 404 = private/uncovered/gone (GitLab hides existence, so do we).
	if (response.status === 401 && token !== undefined) {
		return { ok: false, reason: "not_resolvable", credentialDead: true };
	}
	if (response.status === 404 || response.status === 401 || response.status === 403) {
		return { ok: false, reason: "not_linked" };
	}
	if (response.status !== 200) {
		return { ok: false, reason: "not_resolvable" };
	}
	const payload = (await response.json().catch(() => null)) as GitlabItemPayload | null;
	const title = str(payload?.title);
	const stateWord = str(payload?.state);
	const state = stateWord === undefined ? null : gitlabState(stateWord);
	if (payload === null || title === undefined || state === null) {
		return { ok: false, reason: "not_resolvable" };
	}

	const leaf = parsed.projectPath.split("/").pop() ?? parsed.projectPath;
	const isIssue = parsed.form === "issues";
	const facts: ExternalRefFacts = {
		ref,
		kind: isIssue ? "issue" : "change",
		shortId: `${leaf}${isIssue ? "#" : "!"}${parsed.iid}`,
		title,
		state,
		author: str(payload.author?.username),
		createdAt: str(payload.created_at),
		updatedAt: str(payload.updated_at),
	};
	return { ok: true, facts };
}

// ── list(query): GraphQL project.issues ─────────────────────────────────────
//
// Verified against GitLab docs: https://docs.gitlab.com/api/graphql/reference/
// (Project.issues: state, labelName, assigneeUsernames, milestoneTitle,
// search, sort; max page size 100; complexity counts each field once).
// milestoneTitle and labelName take literal titles, but the REST API's
// wildcards (`None`, `Any`, `Upcoming`, `Started`) may be honoured too;
// every row is re-checked after the read (keepsRow), so a wildcard only
// narrows. gitlab.com can refuse `search` to an anonymous caller ("User
// must be authenticated to include the search argument"): an anonymous
// text list may then answer not_resolvable.

/** Labels and assignees read per row: GitLab's largest page. A row whose
 * labels run past this is kept whole by the label re-check. */
const ROW_CONNECTION = 100;

const PROJECT_ISSUES_QUERY = `query($fullPath: ID!, $first: Int!, $after: String, $state: IssuableState, $labelName: [String!], $assigneeUsernames: [String!], $milestoneTitle: [String!], $search: String, $sort: IssueSort) {
  project(fullPath: $fullPath) {
    issues(first: $first, after: $after, state: $state, labelName: $labelName, assigneeUsernames: $assigneeUsernames, milestoneTitle: $milestoneTitle, search: $search, sort: $sort) {
      pageInfo { hasNextPage endCursor }
      nodes {
        iid title webUrl state createdAt updatedAt
        author { username }
        labels(first: ${ROW_CONNECTION}) { pageInfo { hasNextPage } nodes { title } }
        assignees(first: ${ROW_CONNECTION}) { nodes { username } }
        milestone { title }
      }
    }
  }
}`;

/** A project path: two or more GitLab path segments. */
function validProjectPath(path: string): boolean {
	const segments = path.split("/");
	return (
		segments.length >= 2 &&
		segments.every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== "." && s !== "..")
	);
}

/** One page (up to 100) of a project's issues, filtered by GitLab itself
 * (labels mean every label). The public rung applies as in resolve: with
 * no credential a public project lists anonymously from its own host. */
async function listGitlab(
	grammar: GitlabGrammar,
	query: ReferenceListQuery,
	port: ReferencePort,
): Promise<SearchResult> {
	const checked = checkListQuery(query);
	if (!checked.ok) return checked;
	const q = checked.query;
	const host = readHost(grammar.served, q.host);
	if (host === null || q.scope === undefined || !validProjectPath(q.scope)) {
		return { ok: false, reason: "not_resolvable", field: "scope" };
	}
	const scope = q.scope;
	const credential = await credentialFor(port, "gitlab", host, ["private-token", "bearer"]);
	if (credential !== null && credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	const token = credential ?? undefined;
	const variables: Record<string, unknown> = {
		fullPath: scope,
		first: LIST_PAGE_SIZE,
		after: q.cursor ?? null,
		state: q.state === "open" ? "opened" : q.state,
		sort: q.order === "created_asc" ? "CREATED_ASC" : q.order === "created_desc" ? "CREATED_DESC" : "UPDATED_DESC",
	};
	if (q.labels.length > 0) variables["labelName"] = q.labels;
	if (q.assignee !== undefined) variables["assigneeUsernames"] = [q.assignee];
	if (q.milestone !== undefined) variables["milestoneTitle"] = [q.milestone];
	if (q.text !== undefined) variables["search"] = q.text;

	const answer = await postGraphql(
		providerFetch(port),
		`${gitlabApiBase(host)}/api/graphql`,
		gitlabHeaders(providerUserAgent(port), token),
		PROJECT_ISSUES_QUERY,
		variables,
	);
	if (!answer.ok) {
		// The resolve's rules: 401 on a token = dead; 401/403/404 = hidden.
		if (answer.status === 401 && token !== undefined) {
			return { ok: false, reason: "not_resolvable", credentialDead: true };
		}
		if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
			return { ok: false, reason: "not_linked" };
		}
		return { ok: false, reason: "not_resolvable" };
	}
	if (answer.data === null) return { ok: false, reason: "not_resolvable" };
	// A project this token (or the public rung) cannot see answers null.
	const project = objectAt(answer.data, "project");
	if (project === null) return { ok: false, reason: "not_linked" };
	const connection = objectAt(project, "issues");
	if (connection === null) return { ok: false, reason: "not_resolvable" };

	const items: ExternalRefFacts[] = [];
	for (const node of connectionNodes(connection)) {
		const facts = listFacts(grammar, host, scope, node);
		if (
			facts !== null &&
			keepsRow(q, {
				// GitLab's open states are `opened` and `locked`.
				open: node["state"] === "opened" || node["state"] === "locked",
				labels: facts.labels ?? [],
				labelsComplete: labelsComplete(node["labels"]),
				milestone: facts.milestone,
			})
		)
			items.push(facts);
	}
	const cursor = nextCursor(connection["pageInfo"]);
	return { ok: true, items, ...(cursor === undefined ? {} : { cursor }) };
}

/** One list node as facts, or null when it is not an issue of `scope` on
 * the list's own `host`. The canonical comes from the grammar, as a pasted
 * URL's. */
function listFacts(
	grammar: GitlabGrammar,
	host: string,
	scope: string,
	node: Record<string, unknown>,
): ExternalRefFacts | null {
	const webUrl = str(node["webUrl"]);
	const title = str(node["title"]);
	const stateWord = str(node["state"]);
	const state = stateWord === undefined ? null : gitlabState(stateWord);
	if (webUrl === undefined || title === undefined || state === null) return null;
	let ref: ExternalRef | null;
	try {
		ref = grammar.match(new URL(webUrl));
	} catch {
		return null;
	}
	const parsed = ref === null ? null : parseGitlabCanonical(ref);
	if (ref === null || parsed === null || parsed.form !== "issues" || parsed.host !== host) return null;
	if (parsed.projectPath.toLowerCase() !== scope.toLowerCase()) return null;
	const leaf = parsed.projectPath.split("/").pop() ?? parsed.projectPath;
	const milestone = str(objectAt(node, "milestone")?.["title"]);
	return {
		ref,
		kind: "issue",
		shortId: `${leaf}#${parsed.iid}`,
		title,
		state,
		author: str(objectAt(node, "author")?.["username"]),
		createdAt: str(node["createdAt"]),
		updatedAt: str(node["updatedAt"]),
		labels: connectionNames(node["labels"], "title"),
		assignees: connectionNames(node["assignees"], "username"),
		...(milestone === undefined ? {} : { milestone }),
	};
}

function buildGitlabAdapter(grammar: GitlabGrammar): RefReadAdapter {
	return {
		kindOf: (ref) => (new URL(ref.url).pathname.includes("/merge_requests/") ? "change" : "issue"),
		provider: "gitlab",
		match: grammar.match,
		matchCodeLink: grammar.matchCodeLink,
		resolve: (ref, port) => resolveGitlab(grammar, ref, port),
		list: (query, port) => listGitlab(grammar, query, port),
	} satisfies RefReadAdapter;
}

/** A GitLab adapter serving gitlab.com plus `options.hosts` (self-managed
 * instances). Each host reads its own API with a credential asked for that
 * host. Throws a TypeError for a host that is not a bare hostname. */
export function createGitlabAdapter(options: GitlabHostsOptions = {}): RefReadAdapter {
	return buildGitlabAdapter(gitlabGrammar(options));
}

/** The gitlab.com adapter. */
export const gitlabAdapter: RefReadAdapter = buildGitlabAdapter(gitlabGrammar());
