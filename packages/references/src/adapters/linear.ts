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

function linearAuthorization(credential: ReferenceCredential): string {
	return credential.kind === "linear-api-key" ? credential.token : `Bearer ${credential.token}`;
}

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
		return { ok: false, result: { ok: false, reason: "not_linked" } };
	}
	return { ok: true, data: payload.data };
}

function issueTone(type: string | undefined): ExternalRefState["tone"] {
	if (type === "completed") return "done";
	if (type === "canceled") return "closed";
	return "open";
}

function projectTone(type: string | undefined): ExternalRefState["tone"] {
	if (type === "completed") return "done";
	if (type === "canceled") return "closed";
	return "open";
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

function node(value: unknown): Record<string, unknown> | null {
	return value !== null && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

async function resolveLinear(ref: ExternalRef, port: ReferencePort): Promise<ResolveResult> {
	const parsed = parseLinearCanonical(ref);
	if (parsed === null || !isMintedCanonical(matchLinearUrl, ref.url)) {
		return { ok: false, reason: "not_resolvable" };
	}
	const item = parsed.item;

	const credential = await credentialFor(port, "linear", new URL(ref.url).hostname.toLowerCase(), [
		"bearer",
		"linear-api-key",
	]);
	if (credential === null) return { ok: false, reason: "not_linked" };
	if (credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}

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
	};
	return { ok: true, facts };
}

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

const TEAM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,15}$/;
const CLOSED_TYPES = ["completed", "canceled"];

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
