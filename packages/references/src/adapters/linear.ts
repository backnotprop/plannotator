// Source: apps/rooms/src/external-refs/linear.ts (resolve, GraphQL queries, state mapping, the adapter object) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Cut: the OAuth connect, the token endpoint exchange, the refresh single-flight and updateSecret; the port supplies a live access token and its workspace.
//
// The Linear adapter, read side: issues, projects, and documents under
// linear.app, resolved over GraphQL.
//
// TOKEN CUSTODY moved to the port. Workspaces' Linear credential is an
// OAuth `actor=app` install whose access token dies in about 24 hours and
// whose refresh token ROTATES on every refresh; the Workspaces port keeps
// the refresh loop (single-flight, the rotated pair persisted before use)
// and answers `unavailable` with credentialDead true only when the token
// endpoint REFUSES the refresh (400/401). A network failure, 429 or 5xx on
// refresh is transient: credentialDead false.
//
// Verified against the Linear docs (2026-07-23):
//   GraphQL: https://linear.app/developers/graphql
//     (POST api.linear.app/graphql, `Authorization: Bearer` for OAuth
//     tokens, a bare `Authorization: <key>` for personal API keys (the
//     `linear-api-key` kind); issue(id:) accepts the human identifier "ENG-123"; workflow
//     state types: triage backlog unstarted started completed canceled)
//
// NO PUBLIC RUNG: nothing on linear.app reads unauthenticated. No
// credential answers not_linked with zero fetches.

import type {
	ExternalRef,
	ExternalRefFacts,
	ExternalRefState,
	RefReadAdapter,
	ReferenceListQuery,
	ResolveResult,
	SearchResult,
} from "../contract.ts";
import { providerFetch } from "../fetch.ts";
import { matchLinearUrl, parseLinearCanonical } from "../grammars/linear.ts";
import { apiOrigin, isMintedCanonical } from "../hosts.ts";
import {
	checkListQuery,
	connectionNames,
	connectionNodes,
	LIST_PAGE_SIZE,
	nextCursor,
	objectAt,
	postGraphql,
} from "../list-query.ts";
import {
	credentialFor,
	type FetchLike,
	type ReferenceCredential,
	type ReferencePort,
} from "../port.ts";

const LINEAR_GRAPHQL_URL = `${apiOrigin("linear", "linear.app")}/graphql`;

// ── GraphQL: one query per entity type ──────────────────────────────────────

const ISSUE_QUERY = `query($id: String!) {
  issue(id: $id) {
    identifier title createdAt updatedAt
    state { name type }
    assignee { name } creator { name }
  }
}`;

const PROJECT_QUERY = `query($id: String!) {
  project(id: $id) {
    name updatedAt
    status { name type }
    lead { name }
  }
}`;

const DOCUMENT_QUERY = `query($slugId: String!) {
  documents(filter: { slugId: { eq: $slugId } }, first: 1) {
    nodes { title updatedAt creator { name } }
  }
}`;

interface GraphqlAnswer {
	data?: Record<string, unknown> | null;
}

/** The Authorization header value for a Linear credential: an OAuth access
 * token takes `Bearer`, a personal API key is sent bare. */
function linearAuthorization(credential: ReferenceCredential): string {
	return credential.kind === "linear-api-key" ? credential.token : `Bearer ${credential.token}`;
}

/** POST one GraphQL query; null data node = the entity is not readable
 * here (wrong workspace, private team, gone): the not_linked answer. */
async function graphql(
	query: string,
	variables: Record<string, string>,
	authorization: string,
	fetcher: FetchLike,
): Promise<{ ok: true; data: Record<string, unknown> } | { ok: false; result: ResolveResult }> {
	let response: Response;
	try {
		response = await fetcher(LINEAR_GRAPHQL_URL, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				authorization,
			},
			body: JSON.stringify({ query, variables }),
		});
	} catch {
		return { ok: false, result: { ok: false, reason: "not_resolvable" } };
	}
	// A 401 on a token the port handed out as live: revoked out from under us.
	if (response.status === 401) {
		return {
			ok: false,
			result: { ok: false, reason: "not_resolvable", credentialDead: true },
		};
	}
	if (response.status !== 200) {
		return { ok: false, result: { ok: false, reason: "not_resolvable" } };
	}
	const payload = (await response.json().catch(() => null)) as GraphqlAnswer | null;
	if (payload === null || payload.data === null || payload.data === undefined) {
		// GraphQL "errors" for a missing entity: not readable here.
		return { ok: false, result: { ok: false, reason: "not_linked" } };
	}
	return { ok: true, data: payload.data };
}

// ── state mapping (the workspace's own words, three tones) ──────────────────

/** Issue workflow-state types (the fixed six). */
function issueTone(type: string | undefined): ExternalRefState["tone"] {
	if (type === "completed") return "done";
	if (type === "canceled") return "closed";
	return "open"; // triage | backlog | unstarted | started
}

/** Project status types: same map with `paused` also reading open. */
function projectTone(type: string | undefined): ExternalRefState["tone"] {
	if (type === "completed") return "done";
	if (type === "canceled") return "closed";
	return "open"; // backlog | planned | started | paused
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function node(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

// ── resolve ─────────────────────────────────────────────────────────────────

async function resolveLinear(ref: ExternalRef, port: ReferencePort): Promise<ResolveResult> {
	const parsed = parseLinearCanonical(ref);
	// Only a canonical the grammar mints is read, as on the forges.
	if (parsed === null || !isMintedCanonical(matchLinearUrl, ref.url)) {
		return { ok: false, reason: "not_resolvable" };
	}
	const item = parsed.item;

	const credential = await credentialFor(port, "linear", new URL(ref.url).hostname.toLowerCase(), [
		"bearer",
		"linear-api-key",
	]);
	// No public rung: without a credential nothing resolves.
	if (credential === null) return { ok: false, reason: "not_linked" };
	if (credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}

	// THE WORKSPACE BINDING: the issue query asks Linear by bare human
	// identifier ("ENG-123"), and Linear answers within the TOKEN'S OWN
	// workspace, so without this comparison a pasted foreign-workspace URL
	// (nearly every workspace has an ENG-1) would render the credential's
	// workspace's same-named issue under a link pointing at someone else's.
	// The credential's account IS its workspace urlKey; a URL on any other
	// workspace is simply not linked here, with ZERO provider fetches. This
	// holds for both kinds: a personal API key is also bound to one workspace.
	const installed = credential.account?.toLowerCase() ?? null;
	if (installed === null || installed !== parsed.workspace) {
		return { ok: false, reason: "not_linked" };
	}
	const authorization = linearAuthorization(credential);
	const fetcher = providerFetch(port);

	if (item.form === "issue") {
		const answer = await graphql(ISSUE_QUERY, { id: item.identifier }, authorization, fetcher);
		if (!answer.ok) return answer.result;
		const issue = node(answer.data["issue"]);
		const title = str(issue?.["title"]);
		const state = node(issue?.["state"]);
		const label = str(state?.["name"]);
		if (issue === null || title === undefined || label === undefined) {
			return { ok: false, reason: "not_linked" };
		}
		const facts: ExternalRefFacts = {
			ref,
			kind: "issue",
			shortId: str(issue["identifier"]) ?? item.identifier,
			title,
			state: { label, tone: issueTone(str(state?.["type"])) },
			author: str(node(issue["assignee"])?.["name"]) ?? str(node(issue["creator"])?.["name"]),
			createdAt: str(issue["createdAt"]),
			updatedAt: str(issue["updatedAt"]),
		};
		return { ok: true, facts };
	}

	if (item.form === "project") {
		const answer = await graphql(PROJECT_QUERY, { id: item.slugId }, authorization, fetcher);
		if (!answer.ok) return answer.result;
		const project = node(answer.data["project"]);
		const title = str(project?.["name"]);
		const status = node(project?.["status"]);
		const label = str(status?.["name"]);
		if (project === null || title === undefined || label === undefined) {
			return { ok: false, reason: "not_linked" };
		}
		const facts: ExternalRefFacts = {
			ref,
			kind: "project",
			// No number exists; the honest mono word, never a fake id.
			shortId: "Project",
			title,
			state: { label, tone: projectTone(str(status?.["type"])) },
			author: str(node(project["lead"])?.["name"]),
			updatedAt: str(project["updatedAt"]),
		};
		return { ok: true, facts };
	}

	const answer = await graphql(DOCUMENT_QUERY, { slugId: item.slugId }, authorization, fetcher);
	if (!answer.ok) return answer.result;
	const documents = node(answer.data["documents"]);
	const nodes = Array.isArray(documents?.["nodes"]) ? (documents["nodes"] as unknown[]) : [];
	const doc = node(nodes[0]);
	const title = str(doc?.["title"]);
	if (doc === null || title === undefined) {
		return { ok: false, reason: "not_linked" };
	}
	const facts: ExternalRefFacts = {
		ref,
		kind: "doc",
		shortId: "Doc",
		title,
		author: str(node(doc["creator"])?.["name"]),
		updatedAt: str(doc["updatedAt"]),
		// No state: Linear documents carry none at all (the stateless chip).
	};
	return { ok: true, facts };
}

// ── list(query): GraphQL issues(filter:) ────────────────────────────────────
//
// Linear pages Relay style (first/after and last/before) and takes an
// `orderBy` of createdAt or updatedAt with no direction argument. Docs:
// https://linear.app/developers/pagination ("We implement Relay style
// cursor-based pagination model with first/after and last/before";
// "By default results are ordered by createdAt"; ordering by updatedAt
// gives "most recently updated" first), read 2026-10-30. So both orders
// run newest first, and the query always sends `orderBy` explicitly.
// Oldest first (`created_asc`) reads the LAST page of the createdAt order
// (`last: 100, before: cursor`) and reverses it; the next cursor is that
// page's startCursor while hasPreviousPage holds, which steps toward newer
// issues. Not probed against a live workspace.

/** Labels read per row: Linear filters labels itself, so this bounds the
 * facts only; real issues carry far fewer. */
const ROW_LABELS = 50;

const LIST_ISSUES_QUERY = `query($first: Int, $after: String, $last: Int, $before: String, $filter: IssueFilter, $orderBy: PaginationOrderBy) {
  issues(first: $first, after: $after, last: $last, before: $before, filter: $filter, orderBy: $orderBy) {
    pageInfo { hasNextPage endCursor hasPreviousPage startCursor }
    nodes {
      identifier title url createdAt updatedAt
      state { name type }
      assignee { name displayName } creator { name }
      labels(first: ${ROW_LABELS}) { nodes { name } }
      projectMilestone { name }
    }
  }
}`;

/** A Linear team key ("ENG"). */
const TEAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const CLOSED_TYPES = ["completed", "canceled"];

/** One page (up to 100) of the credential's workspace issues, filtered by
 * Linear itself. `scope` is a team key (optional). Like resolve: no public
 * rung, and the credential's `account` binds the answer to its workspace. */
async function listLinear(query: ReferenceListQuery, port: ReferencePort): Promise<SearchResult> {
	const checked = checkListQuery(query);
	if (!checked.ok) return checked;
	const q = checked.query;
	if (
		(q.host !== undefined && q.host.toLowerCase() !== "linear.app") ||
		(q.scope !== undefined && !TEAM_KEY.test(q.scope))
	) {
		return { ok: false, reason: "not_resolvable", field: "scope" };
	}
	const credential = await credentialFor(port, "linear", "linear.app", ["bearer", "linear-api-key"]);
	if (credential === null) return { ok: false, reason: "not_linked" };
	if (credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	const workspace = credential.account?.toLowerCase();
	if (workspace === undefined) return { ok: false, reason: "not_linked" };

	const and: Record<string, unknown>[] = [];
	if (q.scope !== undefined) and.push({ team: { key: { eqIgnoreCase: q.scope } } });
	if (q.state !== "all") {
		and.push({ state: { type: q.state === "open" ? { nin: CLOSED_TYPES } : { in: CLOSED_TYPES } } });
	}
	for (const label of q.labels) and.push({ labels: { some: { name: { eqIgnoreCase: label } } } });
	if (q.assignee !== undefined) {
		and.push({
			assignee: {
				or: [{ displayName: { eqIgnoreCase: q.assignee } }, { email: { eqIgnoreCase: q.assignee } }],
			},
		});
	}
	if (q.milestone !== undefined) {
		and.push({ projectMilestone: { name: { eqIgnoreCase: q.milestone } } });
	}
	if (q.text !== undefined) {
		and.push({
			or: [{ title: { containsIgnoreCase: q.text } }, { description: { containsIgnoreCase: q.text } }],
		});
	}
	const backward = q.order === "created_asc";
	const variables: Record<string, unknown> = {
		filter: and.length === 0 ? null : { and },
		orderBy: q.order === "updated_desc" ? "updatedAt" : "createdAt",
		...(backward
			? { last: LIST_PAGE_SIZE, before: q.cursor ?? null }
			: { first: LIST_PAGE_SIZE, after: q.cursor ?? null }),
	};

	const answer = await postGraphql(
		providerFetch(port),
		LINEAR_GRAPHQL_URL,
		{ authorization: linearAuthorization(credential) },
		LIST_ISSUES_QUERY,
		variables,
	);
	if (!answer.ok) {
		// A 401 on a token the port handed out as live: revoked.
		return answer.status === 401
			? { ok: false, reason: "not_resolvable", credentialDead: true }
			: { ok: false, reason: "not_resolvable" };
	}
	const connection = objectAt(answer.data, "issues");
	if (connection === null) return { ok: false, reason: "not_resolvable" };

	const nodes = connectionNodes(connection);
	if (backward) nodes.reverse();
	const items: ExternalRefFacts[] = [];
	for (const issue of nodes) {
		const facts = linearListFacts(workspace, issue);
		if (facts !== null) items.push(facts);
	}
	const cursor = nextCursor(connection["pageInfo"], backward ? "backward" : "forward");
	return { ok: true, items, ...(cursor === undefined ? {} : { cursor }) };
}

/** One list node as facts, or null when its URL is not an issue in the
 * credential's workspace. The canonical comes from the grammar. */
function linearListFacts(workspace: string, issue: Record<string, unknown>): ExternalRefFacts | null {
	const url = str(issue["url"]);
	const title = str(issue["title"]);
	const state = node(issue["state"]);
	const label = str(state?.["name"]);
	if (url === undefined || title === undefined || label === undefined) return null;
	let ref: ExternalRef | null;
	try {
		ref = matchLinearUrl(new URL(url));
	} catch {
		return null;
	}
	const parsed = ref === null ? null : parseLinearCanonical(ref);
	if (ref === null || parsed === null || parsed.item.form !== "issue" || parsed.workspace !== workspace) {
		return null;
	}
	const assignee = node(issue["assignee"]);
	const assigneeName = str(assignee?.["displayName"]);
	const milestone = str(node(issue["projectMilestone"])?.["name"]);
	return {
		ref,
		kind: "issue",
		shortId: str(issue["identifier"]) ?? parsed.item.identifier,
		title,
		state: { label, tone: issueTone(str(state?.["type"])) },
		// The resolve's rule, so a chip and a list row agree.
		author: str(assignee?.["name"]) ?? str(node(issue["creator"])?.["name"]),
		createdAt: str(issue["createdAt"]),
		updatedAt: str(issue["updatedAt"]),
		labels: connectionNames(issue["labels"], "name"),
		assignees: assigneeName === undefined ? [] : [assigneeName],
		...(milestone === undefined ? {} : { milestone }),
	};
}

export const linearAdapter: RefReadAdapter = {
	kindOf: (ref) => {
		const form = new URL(ref.url).pathname.split("/")[2];
		return form === "issue" ? "issue" : form === "project" ? "project" : "doc";
	},
	provider: "linear",
	match: matchLinearUrl,
	resolve: resolveLinear,
	list: listLinear,
} satisfies RefReadAdapter;
