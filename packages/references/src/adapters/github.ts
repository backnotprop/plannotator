import type {
	ExternalRef,
	ExternalRefFacts,
	ExternalRefState,
	PullReads,
	RefReadAdapter,
	ResolveResult,
} from "../contract.ts";
import {
	type GithubGrammar,
	githubGrammar,
	type GithubHostsOptions,
	parseGithubCanonical,
} from "../grammars/github.ts";
import { isMintedCanonical, servedHost } from "../hosts.ts";
import { credentialFor, type ReferencePort } from "../port.ts";
import { fetchPullDiff, githubPullReads, listPullFiles, readPullSummary } from "./github-pull-diff.ts";
import {
	githubApi,
	githubHeaders,
	type GithubPickerReads,
	githubPickerReads,
	githubScopes,
	githubList,
	githubSearch,
	issueState,
} from "./github-pulls.ts";

function pullState(state: string, merged: boolean, draft: boolean): ExternalRefState {
	if (merged) return { label: "Merged", tone: "done" };
	if (state === "open" && draft) return { label: "Draft", tone: "open" };
	if (state === "open") return { label: "Open", tone: "open" };
	return { label: "Closed", tone: "closed" };
}

interface IssuePayload {
	title?: unknown;
	state?: unknown;
	state_reason?: unknown;
	user?: { login?: unknown } | null;
	created_at?: unknown;
	updated_at?: unknown;
	pull_request?: { merged_at?: unknown } | null;
}

interface PullPayload {
	title?: unknown;
	state?: unknown;
	merged?: unknown;
	draft?: unknown;
	user?: { login?: unknown } | null;
	created_at?: unknown;
	updated_at?: unknown;
}

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

async function resolveGithub(
	grammar: GithubGrammar,
	ref: ExternalRef,
	port: ReferencePort,
): Promise<ResolveResult> {
	const served = grammar.served;
	const parsed = parseGithubCanonical(ref);
	if (parsed === null || !isMintedCanonical(grammar.match, ref.url)) {
		return { ok: false, reason: "not_resolvable" };
	}
	const host = servedHost(served, parsed.host);
	if (host === null) return { ok: false, reason: "not_resolvable" };

	const credential = await credentialFor(port, "github", host, ["installation", "bearer"]);
	if (credential !== null && credential.kind === "unavailable") {
		return { ok: false, reason: "not_resolvable", credentialDead: credential.credentialDead };
	}
	const authorization = credential === null ? undefined : `Bearer ${credential.token}`;

	const api = githubApi(port, host);
	const repoBase = `${api.base}/repos/${parsed.owner}/${parsed.repo}`;
	const endpoint =
		parsed.form === "pull" ? `${repoBase}/pulls/${parsed.n}` : `${repoBase}/issues/${parsed.n}`;

	let response: Response;
	try {
		response = await api.fetch(endpoint, { headers: githubHeaders(api.userAgent, authorization) });
	} catch {
		return { ok: false, reason: "not_resolvable" };
	}
	if (response.status === 404 || response.status === 410) {
		return { ok: false, reason: "not_linked" };
	}
	if (response.status === 403 || response.status === 429) {
		return { ok: false, reason: "not_resolvable", rateLimited: true };
	}
	if (response.status !== 200) {
		return { ok: false, reason: "not_resolvable" };
	}
	const payload = (await response.json().catch(() => null)) as IssuePayload | PullPayload | null;
	if (payload === null) return { ok: false, reason: "not_resolvable" };

	const title = str(payload.title);
	const state = str(payload.state);
	if (title === undefined || state === undefined) {
		return { ok: false, reason: "not_resolvable" };
	}

	const shortId = `${parsed.repo}#${parsed.n}`;
	const common = {
		ref,
		shortId,
		title,
		author: str(payload.user?.login),
		createdAt: str(payload.created_at),
		updatedAt: str(payload.updated_at),
	};

	if (parsed.form === "pull") {
		const pull = payload as PullPayload;
		const facts: ExternalRefFacts = {
			...common,
			kind: "change",
			state: pullState(state, pull.merged === true, pull.draft === true),
		};
		return { ok: true, facts };
	}

	const issue = payload as IssuePayload;
	if (issue.pull_request !== undefined && issue.pull_request !== null) {
		const merged = str(issue.pull_request.merged_at) !== undefined;
		const facts: ExternalRefFacts = {
			...common,
			kind: "change",
			state: merged
				? { label: "Merged", tone: "done" }
				: state === "open"
					? { label: "Open", tone: "open" }
					: { label: "Closed", tone: "closed" },
		};
		return { ok: true, facts };
	}

	const reason = str(issue.state_reason) ?? null;
	const facts: ExternalRefFacts = {
		...common,
		kind: "issue",
		state: issueState(state, reason),
	};
	return { ok: true, facts };
}

function buildGithubAdapter(
	grammar: GithubGrammar,
	picker: GithubPickerReads,
	pulls: PullReads,
): RefReadAdapter {
	return {
		kindOf: (ref) => (new URL(ref.url).pathname.includes("/pull/") ? "change" : "issue"),
		provider: "github",
		match: grammar.match,
		matchCodeLink: grammar.matchCodeLink,
		resolve: (ref, port) => resolveGithub(grammar, ref, port),
		scopes: picker.scopes,
		search: picker.search,
		list: picker.list,
		pulls,
	} satisfies RefReadAdapter;
}

export function createGithubAdapter(options: GithubHostsOptions = {}): RefReadAdapter {
	const grammar = githubGrammar(options);
	return buildGithubAdapter(grammar, githubPickerReads(grammar), githubPullReads(grammar.served));
}

export const githubAdapter: RefReadAdapter = buildGithubAdapter(
	githubGrammar(),
	{ scopes: githubScopes, search: githubSearch, list: githubList },
	{ summary: readPullSummary, diff: fetchPullDiff, files: listPullFiles },
);
