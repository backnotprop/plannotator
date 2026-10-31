// Source: apps/rooms/src/external-refs/github.ts (resolve, state mapping, the adapter object) (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Cut: the connect step (OAuth code exchange, installation binding, install URLs) and the App token mint; the port supplies the token.
//
// The GitHub adapter, read side. Everything GitHub-specific on the read
// side lives here and in the github grammar. createGithubAdapter({ hosts })
// also serves GitHub Enterprise hosts; each item reads its own host's API
// (githubApiBase) with a credential asked for that host.
//
// The resolve ladder now sits behind the port. Workspaces' ladder was: an
// org connection mints a per-call App installation token; with no
// connection, the App's own HOME installation mints one (an installation
// token reads PUBLIC repos regardless of its repo scope, which keeps public
// resolves off a shared anonymous egress-IP quota); only then does the read
// fall to UNAUTHENTICATED api.github.com. The port answers the first two
// rungs (a token, or `unavailable` when an org installation is gone); a
// null answer is the anonymous last rung, kept here. A port backing a HOME
// installation that fails to mint should answer null, not `unavailable`:
// that failure is deployment drift, not a dead org credential, and the
// resolve must still answer for public repos. Every failure is a typed
// answer, never a throw.
//
// Payload shapes and state words verified against GitHub REST docs
// (2026-07-22):
//   issues:  https://docs.github.com/en/rest/issues/issues?apiVersion=2022-11-28
//   pulls:   https://docs.github.com/en/rest/pulls/pulls?apiVersion=2022-11-28

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

// ── state mapping (the provider's own words, three tones) ───────────────────

// issueState (the one issue mapping, shared with list rows) lives in github-pulls.ts.

/** PR state → {label, tone}: merged → Merged/done, draft → Draft/open,
 * open → Open/open, closed-unmerged → Closed/closed (`merged` and `draft`
 * are booleans in the single-PR payload per the current pulls doc). */
function pullState(state: string, merged: boolean, draft: boolean): ExternalRefState {
	if (merged) return { label: "Merged", tone: "done" };
	if (state === "open" && draft) return { label: "Draft", tone: "open" };
	if (state === "open") return { label: "Open", tone: "open" };
	return { label: "Closed", tone: "closed" };
}

// ── the REST payloads (exactly the fields we read) ──────────────────────────

interface IssuePayload {
	title?: unknown;
	state?: unknown;
	state_reason?: unknown;
	user?: { login?: unknown } | null;
	created_at?: unknown;
	updated_at?: unknown;
	/** Present when the "issue" is really a PR (issues doc): carries
	 * merged_at, so an issues-form URL for a PR still answers honestly. */
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

// ── resolve ─────────────────────────────────────────────────────────────────

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
	// The canonical URL's host picks the API and the credential; a ref on a
	// host this adapter does not serve is never read.
	const host = servedHost(served, parsed.host);
	if (host === null) return { ok: false, reason: "not_resolvable" };

	// The ladder: the port's credential (an installation or a user token),
	// or no credential = the anonymous last rung.
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
	// 404 = private/uncovered/gone (GitHub hides existence, so do we);
	// 410 = deleted issue in a repo we CAN see: same plain-link outcome.
	if (response.status === 404 || response.status === 410) {
		return { ok: false, reason: "not_linked" };
	}
	// 403/429 carry GitHub's rate limits: flagged so a caller's cache holds
	// the miss briefly (an exhausted quota hour must not be hammered one
	// fetch per chip render); anything else non-200 is the provider refusing
	// or failing: all of it "unreachable right now".
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
		// An issues-form URL that is really a PR (GitHub redirects these in
		// the browser). The issues payload has no draft flag, but it does
		// carry pull_request.merged_at: enough for the merged/open/closed
		// truth without a second fetch.
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
		// The picker reads (github-pulls.ts): the installation's repositories,
		// and one repository's open pull requests.
		scopes: picker.scopes,
		search: picker.search,
		// The filtered issue list (github-pulls.ts): GraphQL repository.issues.
		list: picker.list,
		// The guide run's reads (github-pull-diff.ts).
		pulls,
	} satisfies RefReadAdapter;
}

/** A GitHub adapter serving github.com plus `options.hosts` (GitHub
 * Enterprise Server hosts, or *.ghe.com). Each host reads its own API
 * (githubApiBase) with a credential asked for that host. Throws a TypeError
 * for a host that is not a bare hostname. */
export function createGithubAdapter(options: GithubHostsOptions = {}): RefReadAdapter {
	const grammar = githubGrammar(options);
	return buildGithubAdapter(grammar, githubPickerReads(grammar), githubPullReads(grammar.served));
}

/** The github.com adapter. */
export const githubAdapter: RefReadAdapter = buildGithubAdapter(
	githubGrammar(),
	{ scopes: githubScopes, search: githubSearch, list: githubList },
	{ summary: readPullSummary, diff: fetchPullDiff, files: listPullFiles },
);
