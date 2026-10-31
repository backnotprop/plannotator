// Source: apps/rooms/src/external-refs/adapter.ts (Workspaces repo, main 7379b0195de140adc00b4496eefe553a3eec803e).
// Read half only: the connect types, OrgConnectionHandle and AdapterEnv are cut; reads take the ReferencePort (port.ts).
//
// External references: the provider adapter seam. One adapter owns
// everything provider-specific on the READ side: URL matching, resolving a
// ref to chip facts, and the optional search, scopes and pull request reads.
// The registry (registry.ts) is the only module that imports an adapter.
// The connect step (OAuth redirects, form probes, App JWT minting, token
// refresh) is not in this package: each product backs the ReferencePort
// with its own credentials.
//
// THE CONTRACT: `kind` is a closed union; `state` is OPTIONAL (stateless
// doc chips, such as Linear documents, render with no state dot); `label`
// is always the provider's OWN state word verbatim ("Merged", "In Review");
// `tone` stays exactly three values and never grows a fourth.

import type { ReferencePort } from "./port.ts";

/** Provider credential families, including reviewed expansion candidates.
 * A type member does not enable an integration; the registry does that.
 * This union is identical to the Workspaces `ProviderId`; this package
 * registers only github, gitlab and linear. */
export type ProviderId =
	| "github"
	| "atlassian"
	| "linear"
	| "gitlab"
	| "bitbucket"
	| "fireflies"
	| "zoom"
	| "posthog"
	| "sentry"
	| "asana"
	| "shortcut"
	| "clickup"
	| "monday"
	| "trello"
	| "notion"
	| "figma"
	| "google"
	| "slack"
	| "loom"
	| "datadog"
	| "grafana"
	| "honeycomb"
	| "new-relic"
	| "pagerduty"
	| "incident-io"
	| "opsgenie"
	| "cloudflare"
	| "amplitude"
	| "mixpanel"
	| "vercel"
	| "netlify"
	| "fly"
	| "aws"
	| "gcp"
	| "azure"
	| "railway"
	| "render"
	| "planetscale"
	| "stripe"
	| "buildkite"
	| "circleci"
	| "intercom"
	| "zendesk"
	| "canny"
	| "productboard"
	| "hubspot"
	| "google-meet"
	| "google-drive"
	| "granola"
	| "otter";

/** A recognized provider reference, parsed from a pasted URL by `match`.
 * `key` is the provider's canonical id for the item, OPAQUE to callers
 * ("acme-eng/api#482" for GitHub); callers only use it as a cache-key
 * fragment. `url` is the normalized canonical URL the chip links to. */
export interface ExternalRef {
	readonly provider: ProviderId;
	readonly key: string;
	readonly url: string;
}

/** What kind of thing the chip cites. `change` = PR / MR; `doc` and
 * `project` arrive with the stateless providers (Linear documents and
 * projects). Kinds are additive: a consumer that stores them (Workspaces
 * pins them in a Postgres CHECK) adds a kind with a migration. */
export type ExternalRefKind =
	| "issue"
	| "change"
	| "doc"
	| "project"
	| "deployment"
	| "monitor"
	| "resource";

/** The chip's state dot: the provider's own word for display, one of three
 * canonical tones for the color. Never a fourth tone. */
export interface ExternalRefState {
	/** The provider's own state word, verbatim ("Open", "Merged", "In Review"). */
	readonly label: string;
	readonly tone: "open" | "done" | "closed";
}

/** The facts a resolved reference renders as: the whole read surface.
 * Titles and states only, never bodies. */
interface ExternalRefFactsFields {
	readonly ref: ExternalRef;
	/** The chip's mono text: "api#482", "PROJ-142". */
	readonly shortId: string;
	readonly title: string;
	/** Resource-only vendor type word. */
	readonly resourceType?: string;
	/** Resource-only vendor location and scope description. */
	readonly place?: string;
	readonly author?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	/** Meeting-notes facts: the hover card's attendee count and duration,
	 * set only where the provider API answers them cheaply on the one
	 * resolve call. Non-meeting providers never set them. */
	readonly attendeeCount?: number;
	readonly durationMinutes?: number;
	/** Issue filter facts, set by `list` (and only where the provider answers
	 * them on the list call). Label names; assignee logins or usernames (a
	 * Linear assignee's display name); the milestone title (a Linear
	 * project milestone's name). */
	readonly labels?: readonly string[];
	readonly assignees?: readonly string[];
	readonly milestone?: string;
}

/** A monitor cites its saved definition, never an alert occurrence. */
export type ExternalRefFacts = ExternalRefFactsFields &
	(
		| { readonly kind: "monitor"; readonly state?: never }
		| {
				readonly kind: "resource";
				readonly resourceType: string;
				readonly state?: ExternalRefState;
		  }
		| {
				readonly kind: Exclude<ExternalRefKind, "monitor" | "resource">;
				readonly state?: ExternalRefState;
		  }
	);

/** A resolve answer. NEVER a throw into the caller: every failure (404,
 * rate limit, network, unreachable instance) is a typed not-ok answer the
 * caller maps to the plain-link fallback. */
export type ResolveResult =
	| { readonly ok: true; readonly facts: ExternalRefFacts }
	| {
			readonly ok: false;
			/** `not_linked`: the credential (or the public rung) cannot read the
			 * item: private, uncovered, or gone; existence stays hidden.
			 * `not_resolvable`: the provider was unreachable or refused us:
			 * rate limit, network, 5xx, dead credential. */
			readonly reason: "not_linked" | "not_resolvable";
			/** True when the failure PROVES the credential is dead (App
			 * uninstalled, token revoked). The port owner records it (Workspaces
			 * stamps its connection row broken) so "Connected" never becomes a
			 * permanent lie. */
			readonly credentialDead?: boolean;
			/** True when the provider explicitly rate-limited this answer
			 * (GitHub 403/429). A caller's cache can hold it BRIEFLY so an
			 * exhausted quota hour is not hammered one fetch per chip render,
			 * while ordinary transient failures still heal on the very next
			 * request. */
			readonly rateLimited?: boolean;
			/** A picker input needs correction before the provider read can run.
			 * `filter`: a list filter (labels, assignee, milestone, text) is
			 * empty or too long. */
			readonly field?: "scope" | "cursor" | "filter";
	  };

/** Shared provider read failures. No provider response body or credential escapes. */
export type ExternalRefFailure = Extract<ResolveResult, { readonly ok: false }>;

/** One provider-native page of selectable reference facts. */
export type SearchResult =
	| { readonly ok: true; readonly items: readonly ExternalRefFacts[]; readonly cursor?: string }
	| ExternalRefFailure;

/** The order of a `list` page. `created_asc` is oldest first (what an
 * import that takes at most one page per run wants). */
export type ReferenceListOrder = "updated_desc" | "created_desc" | "created_asc";

/** A filtered issue list (`RefReadAdapter.list`). Every filter is
 * optional; filters combine with AND, and `labels` means every label. */
export interface ReferenceListQuery {
	/** The repository or project: GitHub `owner/repo` and GitLab
	 * `group/sub/project` (required); a Linear team key such as `ENG`
	 * (optional: the whole workspace). */
	readonly scope?: string;
	/** One of the adapter's served hosts (default the public host). */
	readonly host?: string;
	/** Default `open`. Merged and draft are tones, never a state here. */
	readonly state?: "open" | "closed" | "all";
	readonly labels?: readonly string[];
	/** A GitHub login, a GitLab username, or a Linear display name or email. */
	readonly assignee?: string;
	/** A milestone title (Linear: a project milestone name). */
	readonly milestone?: string;
	/** Free text. On GitHub, text runs the search API, which answers at
	 * most 1,000 results per query: a text list ends there with no cursor. */
	readonly text?: string;
	/** The previous page's `cursor`, with the same query. */
	readonly cursor?: string;
	/** Default `updated_desc`. */
	readonly order?: ReferenceListOrder;
}

/** The provider's own scopes, such as repositories or projects. */
export type ScopesResult =
	| {
			readonly ok: true;
			readonly items: readonly { readonly id: string; readonly label: string }[];
	  }
	| ExternalRefFailure;

/** The forges whose URLs can become code-link rows: the strict subset of
 * ProviderId a code-link store admits. Registry answers narrow to this
 * union. */
export type CodeLinkProviderId = "github" | "gitlab" | "bitbucket";

/** What a code-link row can point at. `pr` is the umbrella wire word for
 * pull AND merge requests ("Merge request" is GitLab UI copy only).
 * `issue` is a GitHub issue; only GitHub's grammar mints it. */
export type CodeLinkKind = "pr" | "repo" | "branch" | "issue";

/** The association a code-link row stores. repoPath is the provider's full
 * path in display case; number is set exactly for kinds "pr" and "issue";
 * branch (decoded, exact case) exactly for kind "branch". url is the
 * canonical form, byte-identical to what match() would emit for the same
 * item where both exist, so a link row and a resolve cache share one
 * identity. Facts (title, merged) stay resolve-time. */
export interface CodeLinkRef {
	readonly kind: CodeLinkKind;
	readonly repoPath: string;
	readonly number?: number;
	readonly branch?: string;
	readonly url: string;
}

/** One provider's read side, whole: recognize its URLs, resolve a ref to
 * facts, and the optional search, scopes and pull reads. Every read takes
 * the ReferencePort; no adapter reads env or config. */
export interface RefReadAdapter {
	/** Provider-native search or listing. Empty query uses the provider's default list.
	 * `include: "issues"` is GitHub's alone (a `#` list of open issues and pull
	 * requests together). Other providers ignore it. `host` picks one of the
	 * adapter's served hosts (default the public host); a host it does not
	 * serve answers `field: "scope"`. */
	search?(
		args: { query: string; scope?: string; cursor?: string; include?: "issues"; host?: string },
		port: ReferencePort,
	): Promise<SearchResult>;
	/** One page (up to 100) of a scope's issues, filtered. Issues only: pull
	 * and merge requests are never listed. Answers like `search`; `cursor`
	 * is set when another page exists. Rows are re-checked after the read,
	 * so a page can hold fewer than 100 items, even none, and still carry a
	 * cursor: read on until a page has no cursor. A GitHub list with `text`
	 * runs GitHub search, capped at 1,000 results per query. */
	list?(query: ReferenceListQuery, port: ReferencePort): Promise<SearchResult>;
	/** Optional narrowing choices, on `options.host` (default the public
	 * host). Absent method means no scope control. */
	scopes?(port: ReferencePort, options?: { readonly host?: string }): Promise<ScopesResult>;
	/** A forge's pull request reads for guided reviews: its facts and its
	 * diff pinned to one base and head. Only GitHub implements it
	 * (adapters/github-pull-diff.ts). */
	readonly pulls?: PullReads;
	readonly provider: ProviderId;
	/** Pure URL recognition: no credential, no fetch, no side effects. */
	match(url: URL): ExternalRef | null;
	/** Pure: the kind of thing a ref `match` returned points at, read from
	 * its canonical URL alone, the same kind its resolved facts carry.
	 * Optional only so test fakes stay small; every registered adapter sets
	 * it. */
	kindOf?(ref: ExternalRef): ExternalRefKind;
	/** Pure CODE LINK recognition: the typed association a link row stores
	 * (repo home, branch page, pull/merge request, or a GitHub issue), or
	 * null when the URL is none of this provider's code-link forms (a code
	 * link is narrower than a reference). Optional: only forges implement it. */
	matchCodeLink?(url: URL): CodeLinkRef | null;
	/** Fetch the item's facts. The adapter asks the port for a credential;
	 * a null credential is the provider's public rung, if it has one.
	 * Answers, never throws. */
	resolve(ref: ExternalRef, port: ReferencePort): Promise<ResolveResult>;
}

/** A pull request as a guide addresses it. */
export interface PullRef {
	readonly repo: string;
	readonly number: number;
	/** The item host (default github.com): a GitHub Enterprise host the
	 * adapter serves. A host it does not serve answers not_linked. */
	readonly host?: string;
}

/** See RefReadAdapter.pulls. The answer shapes are the GitHub module's own,
 * which is the one implementation. */
export interface PullReads {
	summary(
		pull: PullRef,
		port: ReferencePort,
	): Promise<import("./adapters/github-pull-diff.ts").PullSummaryResult>;
	diff(
		pull: PullRef,
		port: ReferencePort,
	): Promise<import("./adapters/github-pull-diff.ts").PullDiffResult>;
	files(
		pull: PullRef,
		port: ReferencePort,
	): Promise<import("./adapters/github-pull-diff.ts").PullFilesResult>;
}
