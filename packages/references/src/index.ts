export type {
	CodeLinkKind,
	CodeLinkProviderId,
	CodeLinkRef,
	ExternalRef,
	ExternalRefFacts,
	ExternalRefFailure,
	ExternalRefKind,
	ExternalRefState,
	ProviderId,
	PullReads,
	PullRef,
	ReferenceListOrder,
	ReferenceListQuery,
	RefReadAdapter,
	ResolveResult,
	ScopesResult,
	SearchResult,
} from "./contract.ts";
export {
	credentialFor,
	type FetchLike,
	type ProviderCallFields,
	type ProviderCallLog,
	type ReferenceCredential,
	type ReferenceCredentialAnswer,
	type ReferenceCredentialKind,
	type ReferenceCredentialUnavailable,
	type ReferencePort,
} from "./port.ts";
export { DEFAULT_USER_AGENT, externalRefsFetch, providerFetch, providerUserAgent } from "./fetch.ts";
export { parseBranchTail } from "./grammars/git-branch.ts";
export { type ApiOriginProvider, apiOrigin, type ServedHosts } from "./hosts.ts";
export { LIST_PAGE_SIZE } from "./list-query.ts";
export {
	GITHUB_PUBLIC_HOST,
	type GithubGrammar,
	githubGrammar,
	type GithubHostsOptions,
	matchGithubCodeLink,
	matchGithubUrl,
	parseGithubCanonical,
} from "./grammars/github.ts";
export {
	GITLAB_PUBLIC_HOST,
	type GitlabGrammar,
	gitlabGrammar,
	type GitlabHostsOptions,
	matchGitlabCodeLink,
	matchGitlabUrl,
	parseGitlabCanonical,
} from "./grammars/gitlab.ts";
export { type LinearItem, matchLinearUrl, parseLinearCanonical } from "./grammars/linear.ts";
export { createGithubAdapter, githubAdapter } from "./adapters/github.ts";
export {
	githubApiBase,
	githubGraphqlUrl,
	githubList,
	type GithubPickerReads,
	githubPickerReads,
	githubScopes,
	githubSearch,
} from "./adapters/github-pulls.ts";
export {
	fetchPullDiff,
	GITHUB_DIFF_FILE_CEILING,
	githubPullReads,
	listPullFiles,
	type PullDiffResult,
	type PullFilesResult,
	type PullSummary,
	type PullSummaryResult,
	readPullSummary,
} from "./adapters/github-pull-diff.ts";
export { createGitlabAdapter, gitlabAdapter, gitlabApiBase } from "./adapters/gitlab.ts";
export { linearAdapter } from "./adapters/linear.ts";
export {
	adapterFor,
	allAdapters,
	createReferenceAdapters,
	createReferenceRegistry,
	type ReferenceAdapterHosts,
	matchCodeLinkUrl,
	matchExternalRef,
	matchExternalRefCandidates,
	matchExternalRefUrl,
	REFERENCE_ADAPTERS,
	type ReferenceRegistry,
} from "./registry.ts";
export { integrationPickerPresentation, type ReferencePickerPresentation } from "./picker-modes.ts";
