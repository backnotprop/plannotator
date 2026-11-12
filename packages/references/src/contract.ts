import type { ReferencePort } from "./port.ts";

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

export interface ExternalRef {
	readonly provider: ProviderId;
	readonly key: string;
	readonly url: string;
}

export type ExternalRefKind =
	| "issue"
	| "change"
	| "doc"
	| "project"
	| "deployment"
	| "monitor"
	| "resource";

export interface ExternalRefState {
	readonly label: string;
	readonly tone: "open" | "done" | "closed";
}

interface ExternalRefFactsFields {
	readonly ref: ExternalRef;
	readonly shortId: string;
	readonly title: string;
	readonly resourceType?: string;
	readonly place?: string;
	readonly author?: string;
	readonly createdAt?: string;
	readonly updatedAt?: string;
	readonly attendeeCount?: number;
	readonly durationMinutes?: number;
	readonly labels?: readonly string[];
	readonly assignees?: readonly string[];
	readonly milestone?: string;
}

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

export type ResolveResult =
	| { readonly ok: true; readonly facts: ExternalRefFacts }
	| {
			readonly ok: false;
			readonly reason: "not_linked" | "not_resolvable";
			readonly credentialDead?: boolean;
			readonly rateLimited?: boolean;
			readonly field?: "scope" | "cursor" | "filter";
	  };

export type ExternalRefFailure = Extract<ResolveResult, { readonly ok: false }>;

export type SearchResult =
	| { readonly ok: true; readonly items: readonly ExternalRefFacts[]; readonly cursor?: string }
	| ExternalRefFailure;

export type ReferenceListOrder = "updated_desc" | "created_desc" | "created_asc";

export interface ReferenceListQuery {
	readonly scope?: string;
	readonly host?: string;
	readonly state?: "open" | "closed" | "all";
	readonly labels?: readonly string[];
	readonly assignee?: string;
	readonly milestone?: string;
	readonly text?: string;
	readonly cursor?: string;
	readonly order?: ReferenceListOrder;
}

export type ScopesResult =
	| {
			readonly ok: true;
			readonly items: readonly { readonly id: string; readonly label: string }[];
	  }
	| ExternalRefFailure;

export type CodeLinkProviderId = "github" | "gitlab" | "bitbucket";

export type CodeLinkKind = "pr" | "repo" | "branch" | "issue";

export interface CodeLinkRef {
	readonly kind: CodeLinkKind;
	readonly repoPath: string;
	readonly number?: number;
	readonly branch?: string;
	readonly url: string;
}

export interface RefReadAdapter {
	search?(
		args: { query: string; scope?: string; cursor?: string; include?: "issues"; host?: string },
		port: ReferencePort,
	): Promise<SearchResult>;
	list?(query: ReferenceListQuery, port: ReferencePort): Promise<SearchResult>;
	scopes?(port: ReferencePort, options?: { readonly host?: string }): Promise<ScopesResult>;
	readonly pulls?: PullReads;
	readonly provider: ProviderId;
	match(url: URL): ExternalRef | null;
	kindOf?(ref: ExternalRef): ExternalRefKind;
	matchCodeLink?(url: URL): CodeLinkRef | null;
	resolve(ref: ExternalRef, port: ReferencePort): Promise<ResolveResult>;
}

export interface PullRef {
	readonly repo: string;
	readonly number: number;
	readonly host?: string;
}

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
