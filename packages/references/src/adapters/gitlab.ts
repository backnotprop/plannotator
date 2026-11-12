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

export function gitlabApiBase(host: string): string {
	return apiOrigin("gitlab", host);
}

function gitlabHeaders(userAgent: string, credential?: ReferenceCredential): Record<string, string> {
	const headers: Record<string, string> = {
		accept: "application/json",
		"user-agent": userAgent,
	};
	if (credential?.kind === "private-token") headers["PRIVATE-TOKEN"] = credential.token;
	if (credential?.kind === "bearer") headers.authorization = `Bearer ${credential.token}`;
	return headers;
}

function gitlabState(state: string): ExternalRefState | null {
	if (state === "opened") return { label: "Open", tone: "open" };
	if (state === "closed") return { label: "Closed", tone: "closed" };
	if (state === "merged") return { label: "Merged", tone: "done" };
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
	const host = servedHost(served, parsed.host);
	if (host === null) return { ok: false, reason: "not_resolvable" };

	const credential = await credentialFor(port, "gitlab", host, ["private-token", "bearer"]);
	if (credential !== null && credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	const token = credential ?? undefined;
	const base = gitlabApiBase(host);

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

function validProjectPath(path: string): boolean {
	const segments = path.split("/");
	return (
		segments.length >= 2 &&
		segments.every((s) => /^[A-Za-z0-9_.-]+$/.test(s) && s !== "." && s !== "..")
	);
}

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
		if (answer.status === 401 && token !== undefined) {
			return { ok: false, reason: "not_resolvable", credentialDead: true };
		}
		if (answer.status === 401 || answer.status === 403 || answer.status === 404) {
			return { ok: false, reason: "not_linked" };
		}
		return { ok: false, reason: "not_resolvable" };
	}
	if (answer.data === null) return { ok: false, reason: "not_resolvable" };
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

export function createGitlabAdapter(options: GitlabHostsOptions = {}): RefReadAdapter {
	return buildGitlabAdapter(gitlabGrammar(options));
}

export const gitlabAdapter: RefReadAdapter = buildGitlabAdapter(gitlabGrammar());
