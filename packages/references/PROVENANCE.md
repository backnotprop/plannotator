# Provenance: @plannotator/references extract (2026-10-30)

Every file under `package/src/` was cut from the Workspaces product repo at
main `7379b0195de140adc00b4496eefe553a3eec803e`, read from
`/Users/ramos/workspaces/projects/workspaces/worktrees/main` (read only; no
edits, no state-changing git commands). Paths below are relative to that
repo. "Last touched" is `git log -1` for the source file at that main, as
an evidence anchor.

## License

The receiving open-source repo is licensed "MIT OR Apache-2.0", and its
published packages `@plannotator/core` and `@plannotator/ui` declare
`"license": "Apache-2.0"` with no per-file license headers. This package
follows that: `package.json` declares `"license": "Apache-2.0"`, and no file
carries a license header. On placement in the open-source repo these files
take Apache-2.0, under the owner's ruling that this code may be opened. Each
`src` file keeps a two-line provenance comment naming its Workspaces source
and the main commit.

## File by file

| Package file | Source (last touched) | Removed | Renamed or changed | Tests carried |
| --- | --- | --- | --- | --- |
| `src/contract.ts` | `apps/rooms/src/external-refs/adapter.ts` (96d921b52) | `ConnectStep`, `ConnectOutcome`, `ConnectionSeed`, `OrgConnectionHandle`, `AdapterEnv` (and its `EnvVars` import), `RefAdapter.connect`, `RefAdapter.personalList` | `RefAdapter` is `RefReadAdapter`: `resolve(ref, port)`, `search(args, port)`, `scopes(port)`, `PullReads` methods take `(pull, port)`. `ProviderId`, `ExternalRef`, `ExternalRefKind`, `ExternalRefState`, `ExternalRefFacts`, `ResolveResult`, `ExternalRefFailure`, `SearchResult`, `ScopesResult`, `CodeLinkProviderId`, `CodeLinkKind`, `CodeLinkRef`, `PullRef` are identical in name and shape. Comments that named Workspaces internals (the core, `broken_at`) now say "the port owner". | (types; exercised by every suite) |
| `src/port.ts` | new; replaces `AdapterEnv` and `OrgConnectionHandle` of `adapter.ts` | n/a | `ReferencePort { fetch, credential(provider, host) }`, `ReferenceCredential { kind, token, host, account? }`, `ReferenceCredentialUnavailable { kind: "unavailable", credentialDead }`, `credentialFor` (host, kind and empty-token guard). `fetch` is typed `FetchLike`, a plain call signature any platform `fetch` satisfies. | github, gitlab, linear suites (wrong host, wrong kind, empty token, port throws) |
| `src/fetch.ts` | `apps/rooms/src/external-refs/fetch.ts` (35fa3a1d8) | the module-level `injectedFetch` and `setExternalRefsFetchForTesting` | `externalRefsFetch(fetcher, input, init)` takes the fetcher first; new `providerFetch(port)` wraps the port's fetch. Policy (10 s deadline, 20 same-origin hops, the POST replay rule, the host-only `console.info` line) unchanged. | `apps/rooms/test/external-refs-fetch.test.ts`, all 9 cases, against a fake origin that serves the same routes as the Miniflare fixture `apps/rooms/test/fixtures/posthog-ingest.js` (`redirect-source.example`, `redirect-target.example`); plus a 20-hop cap case and a log-fields case |
| `src/grammars/git-branch.ts` | `apps/rooms/src/external-refs/git-branch.ts` (4ecd88af4); the client copy in `apps/web/src/components/external-refs/match.ts` was the same rule | nothing | moved under `grammars/` | branch rows of `apps/rooms/test/code-link-grammar.test.ts` |
| `src/grammars/github.ts` | `apps/rooms/src/external-refs/github.ts` (0692d94ff): `matchGithubUrl`, `RESERVED_ROOTS`, `codeLinkSegments`, `matchGithubCodeLink`, `parseCanonical`; merged with `matchGithub` and `matchGithubCodeLink` of `apps/web/src/components/external-refs/match.ts` (648cc56ec) | the client copy (same accept set, same canonicals for these three providers; the web test cases pass against the server grammar here) | `parseCanonical` is exported as `parseGithubCanonical` | `apps/rooms/test/external-refs.test.ts` "the GitHub match grammar" (4 cases); `apps/web/test/external-ref-match.test.ts` "the GitHub owner/repo grammar splits" and the sentence-final `2.` refusal; GitHub rows of `apps/rooms/test/code-link-grammar.test.ts` (same table as `apps/web/test/code-link-match.test.ts`) |
| `src/grammars/gitlab.ts` | `apps/rooms/src/external-refs/gitlab.ts` (0692d94ff): `matchGitlabUrl`, `RESERVED_ROOTS`, `matchGitlabCodeLink`, `parseCanonical`; merged with `matchGitlab` and `matchGitlabCodeLink` of `match.ts` | the client copy | `parseCanonical` is `parseGitlabCanonical` | `apps/rooms/test/external-refs-providers.test.ts` "gitlab — match grammar"; GitLab cases of `apps/web/test/external-ref-match.test.ts`; GitLab rows of `code-link-grammar.test.ts` |
| `src/grammars/linear.ts` | `apps/rooms/src/external-refs/linear.ts` (0692d94ff): `matchLinearUrl`, `parseCanonical`, `LinearItem`; merged with `matchLinear` of `match.ts` | the client copy | `parseCanonical` is `parseLinearCanonical`; `LinearItem` exported | `external-refs-providers.test.ts` "linear — match grammar"; Linear cases of `external-ref-match.test.ts` |
| `src/adapters/github.ts` | `apps/rooms/src/external-refs/github.ts` (0692d94ff): `issueState`, `pullState`, payload types, `resolveGithub`, the adapter object | the whole connect side: `exchangeConnectCode`, `completeGithubConnect`, `installationDisplayLabel`, `bindExistingInstallation`, `beginUrl`, `configured`, the OAuth URLs, every `env.vars.GITHUB_APP_*` read, the `zod` import (connect only); the mint calls (`mintGithubInstallationToken`, `githubHomeInstallationId`) and the once-per-isolate home-rung warn with `resetGithubHomeRungWarnForTesting` | the credential comes from `credentialFor(port, "github", host, ["installation", "bearer"])` | `external-refs.test.ts` "resolve through the route — the public rung" (4 cases), "the connection rung" (mint → authorized read, dead credential), the HOME-installation cases as port answers |
| `src/adapters/github-pulls.ts` | `apps/rooms/src/external-refs/github-pulls.ts` (ee150656d); `GITHUB_API_BASE` and `githubHeaders` from `apps/rooms/src/external-refs/github-app.ts` (399ee07a9) | `installationAuth`'s mint; all of `github-app.ts` except the two constants above (no `jose`, no `EnvVars`, no JWT, no `githubAppConfigured`) | `installationAuth(connection, env)` is `githubAuth(port)`; `get(path, auth, env, accept)` is `get(path, auth, fetcher, accept)`; `githubScopes(port)`, `githubSearch(args, port)`; new `GITHUB_HOST` constant | `apps/rooms/test/github-pulls.test.ts` G1, G2, G10, G5 |
| `src/adapters/github-pull-diff.ts` | `apps/rooms/src/external-refs/github-pull-diff.ts` (3f4ab8562) | nothing but the connection and env parameters | `readPullSummary(pull, port)`, `fetchPullDiff(pull, port)`, `listPullFiles(pull, port)`; `installationAuth` is `githubAuth`; the internal `read` and `readFilePages` take a fetcher. Kept because it needs `@plannotator/core/diff-paths` (`formatPatchPathToken`, `formatDiffMetadataPathToken`), which is open source in the receiving repo. | `github-pulls.test.ts` G3, G4, G6, G7, G8, G9 (the exact diff strings; the cross-checks through `@plannotator/core/diff-files` and `guide-format` were dropped to keep the test imports to the package) |
| `src/adapters/gitlab.ts` | `apps/rooms/src/external-refs/gitlab.ts` (0692d94ff): `gitlabHeaders`, `gitlabState`, `resolveGitlab`, the adapter object | the form connect (`normalizeBaseUrl`, `probeGitlab`, `fields`, `configured`), the sealed-secret parsing (`GitlabCredential`, `parseCredential`) | `gitlabHeaders(credential)` sends `PRIVATE-TOKEN` for `private-token` and `Authorization: Bearer` for `bearer`; the API base is `https://{credential.host}` | `external-refs-providers.test.ts` "gitlab — resolve through the route" (3 resolve cases; the 2 probe cases are connect side) |
| `src/adapters/linear.ts` | `apps/rooms/src/external-refs/linear.ts` (0692d94ff): the three queries, `graphql`, the tone maps, `resolveLinear`, the adapter object | `appOrigin` import, the OAuth connect (`beginUrl`, `completeLinearConnect`, `linearConfigured`, `linearRedirectUri`, `ORGANIZATION_QUERY`), the token endpoint (`tokenRequest`), the refresh loop (`freshCredential`, `refreshInFlight`, `resetLinearRefreshForTesting`, `EXPIRY_HEADROOM_MS`), `updateSecret`, the sealed-credential parsing | `graphql(query, vars, token, fetcher)`; the workspace binding reads `credential.account` instead of `connection.externalAccount` | `external-refs-providers.test.ts` "linear — resolve, refresh custody, and state tables": the issue resolve, the three state tables, the workspace-binding pin, no public rung; the refresh cases became port answers (refused = `credentialDead: true`, transient = `false`); the OAuth cases stay in Workspaces |
| `src/registry.ts` | `apps/rooms/src/external-refs/registry.ts` (33332aa62); `matchExternalRefUrl` from `apps/web/src/components/external-refs/match.ts` | the other 30 adapter imports and the Google Meet/Drive ordering note (kept as a general rule) | `ADAPTERS` is `REFERENCE_ADAPTERS` (three); the functions come from `createReferenceRegistry(adapters)` with default bindings under the original names | new: order, kindOf census, composition, code-link narrowing (Workspaces pins its registry through the adapter suites and `external-refs-tripwire.test.ts`) |
| `src/picker-modes.ts` | `apps/web/src/lib/integration-providers.ts` (33332aa62): `ReferencePickerPresentation`, `PASTE_PRESENTATION`, the `github` and `linear` rows of `DISCOVERY_PRESENTATIONS`, `integrationPickerPresentation` | the other providers' rows, `ReferenceProviderEntry` (connect copy, form fields, disclosure), `REFERENCE_PROVIDERS`, `integrationAccountLabel` | `integrationPickerPresentation` takes `{ id, picker? }` | new: the three rows and the override |
| `src/index.ts` | new barrel | n/a | n/a | n/a |
| `package.json`, `tsconfig.json`, `tsconfig.test.json`, `README.md`, `test/helpers.ts` | new | n/a | `tsconfig.json` matches the Workspaces base strictness (`strict`, `noUnusedLocals`, `noUnusedParameters`, `verbatimModuleSyntax`, `.ts` import extensions). `@plannotator/core` is pinned at `0.25.14`, as `@plannotator/ui` pins it. | `test/registry.test.ts` also holds a tripwire: no `src` code reads env, mints a JWT, or imports anything outside the package but `@plannotator/core/diff-paths`, and every `src` file carries the two-line header |

Not carried from Workspaces: `resolve-cache.ts`, `secret-store.ts`,
`github-app.ts` (beyond two constants), the resolve action, HTTP routes,
the MCP tool, the 30 other adapters, and the web client's text scanners
(`findExternalRefMatches`, `findExternalRefUrls`, `findAuthoredBareUrls`,
`MAX_REFS_PER_SURFACE`) and its string-form `matchCodeLinkUrl(raw)` with its
`CodeLinkMatch { canonical }` shape. The registry's `matchCodeLinkUrl(url)`
answers `{ provider, link }` with `link.url` as the canonical; the client
shape is `{ provider, ...link, canonical: link.url }`.

`zod` is not a dependency: in these files it was used only by GitHub's
connect step.

## Behaviour differences that could not be avoided

1. **GitHub's resolve ladder moved behind the port.** Workspaces minted an
   org installation token, else a home-installation token, else read
   anonymously, and warned once per isolate when the home mint failed. The
   package sends whatever the port answers and reads anonymously on `null`.
   The Workspaces port must answer `null` (not `unavailable`) when the home
   installation fails to mint, or public resolves stop degrading to
   anonymous. The once-per-isolate warn moves to the port.
2. **The dead-credential proofs that came from stored rows moved to the
   port.** An empty installation id (GitHub), a secret that will not open or
   parse (GitLab, Linear), a mint 404 (GitHub) and a refused refresh
   (Linear) were adapter answers; now the port answers
   `{ kind: "unavailable", credentialDead: true }`. The adapter's own
   proofs stay: a GitLab 401 on a token, a Linear GraphQL 401.
3. **Linear's workspace binding runs after the port call.** Workspaces
   compared the URL's workspace with the connection's account before opening
   the secret, so a foreign-workspace URL made zero fetches of any kind.
   Now the adapter calls `port.credential` first. It still makes zero
   provider fetches for a foreign workspace, but a Workspaces port that
   refreshes an expired Linear token inside `credential()` would spend one
   token-endpoint call on a foreign-workspace URL that it used to skip.
4. **GitHub picker and pull reads with no credential answer `not_linked`.**
   Workspaces never called them without a connection. They do not fall back
   to anonymous reads.
5. **GitHub accepts user tokens.** `bearer` credentials ride the same
   `Authorization: Bearer` header as installation tokens for resolve, search
   and pull reads. `scopes` (`GET /installation/repositories`) answers
   `not_linked` for a `bearer` token without a fetch, because only an
   installation can list its repositories. Workspaces only ever had
   installation tokens.
6. **GitLab accepts OAuth tokens.** A `bearer` credential is sent as
   `Authorization: Bearer`; Workspaces sent only `PRIVATE-TOKEN`.
7. **GitLab's API base comes from the credential's host**
   (`https://{host}`), not the stored `baseUrl` origin. For `gitlab.com`
   the request URL is byte-identical. A stored self-managed origin with a
   port is not representable, and today it never applied (the grammar
   matches only `gitlab.com`).
8. **New guard: a credential for another host, of the wrong kind, or with
   an empty token is ignored** (`credentialFor`). GitLab already ignored a
   credential for another instance; GitHub and Linear had no host notion.
9. **A port that throws** reads as `{ kind: "unavailable", credentialDead:
   false }`, so the adapter answers `not_resolvable` with
   `credentialDead: false` instead of throwing.
10. **The fetch test seam is gone.** `setExternalRefsFetchForTesting` was
    module state; the port's `fetch` is the seam. `externalRefsFetch` now
    takes the fetcher as its first argument. Workspaces' other callers
    (`assistant/provider-keys.ts`, the agent providers) keep their own copy
    or adapt at adoption.
11. **Kept as is, though they now run outside Workspaces:** the
    `user-agent: plannotator-workspaces` header on GitHub and GitLab, and the
    `console.info("external_ref_provider_call", { host, status, duration_ms })`
    line on every provider call.
12. **Linear personal API keys are not supported.** The `bearer` kind sends
    `Authorization: Bearer`. The Workspaces Linear test notes that personal
    keys take no `Bearer` prefix; sending one would 401, which the adapter
    reads as `credentialDead: true`. A typed Linear key needs a new
    credential kind, added to `ReferenceCredentialKind` and to Linear's
    accepted kinds in `adapters/linear.ts`.

## Where the receiving builder adds the next two capabilities

### (a) The `hosts` option (self-managed GitLab, GitHub Enterprise)

- `src/grammars/github.ts`: the host checks in `matchGithubUrl` and
  `codeLinkSegments`, and the canonical templates `https://github.com/...`
  in `matchGithubUrl` and `matchGithubCodeLink` (repo and branch forms). The
  natural shape is a factory, `githubGrammar({ hosts })`, whose canonical
  URLs carry the matched host.
- `src/grammars/gitlab.ts`: the host checks in `matchGitlabUrl` and
  `matchGitlabCodeLink`, and the four `https://gitlab.com/...` canonical
  templates.
- `src/adapters/github.ts`: `GITHUB_API_BASE` is fixed to
  `https://api.github.com`; an Enterprise host needs `https://{host}/api/v3`.
  The credential is already asked for by the canonical URL's host.
- `src/adapters/github-pulls.ts` and `src/adapters/github-pull-diff.ts`:
  `GITHUB_HOST` (the credential lookup), `GITHUB_API_BASE`, and the
  `https://github.com/${repo}` URL templates in `pullFacts`, `issueFacts` and
  `read`. `search`, `scopes` and the pull reads take an `owner/repo` scope
  with no host, so a hosts-aware version needs a host argument.
- `src/adapters/gitlab.ts`: already asks for the credential by the URL's
  host and builds the API base from the credential's host. Only
  `DEFAULT_BASE_URL` (the anonymous base) must become `https://{url host}`.
- `src/registry.ts`: `createReferenceRegistry` takes adapters, so a
  consumer passes host-configured adapters. Keep fixed hosts before
  structural matchers.
- `src/port.ts`: no change; the host gate stays the port's job.

### (b) `list(query)` and the filter facts

Suggested additive types, not implemented:

```ts
// src/contract.ts, beside SearchResult
export interface ReferenceListQuery {
	readonly scope?: string;
	/** Mapped per provider; merged and draft read as tone, never a new state. */
	readonly state?: "open" | "closed" | "all";
	readonly labels?: readonly string[];
	readonly assignee?: string;
	readonly milestone?: string;
	readonly text?: string;
	readonly cursor?: string;
}

// src/contract.ts, RefReadAdapter, beside search?
list?(query: ReferenceListQuery, port: ReferencePort): Promise<SearchResult>;

// src/contract.ts, ExternalRefFactsFields, after durationMinutes
readonly labels?: readonly string[];
readonly assignees?: readonly string[];
readonly milestone?: string;
```

Notes for that work:

- `list` answers `SearchResult`, so the picker and the Inbox page through it
  the same way as `search`.
- Linear's `author` today is the assignee, else the creator
  (`adapters/linear.ts`). When `assignees` lands, decide whether `author`
  stays as it is so the Workspaces chip does not change.
- When Workspaces adopts the new fact fields, its live OpenAPI
  `IntegrationFacts` schema and the fixture tests that deep-equal facts
  change with them.
- Workspaces' GitHub and GitLab adapters read REST; a GraphQL `list` is new
  code there, not a drop-in.

## Since placement in Plannotator

The sections above record the extract as it was cut. Changes made in this
repo after placement, in commit order:

- Difference 12 is resolved: `ReferenceCredentialKind` gains
  `linear-api-key`, which Linear accepts beside `bearer` and sends as the
  bare `Authorization: <key>`. Both kinds still need `account`.
- Difference 11 moves to the port: `ReferencePort` gains an optional
  `userAgent` (default `plannotator-workspaces`, sent on GitHub and GitLab
  calls as before) and an optional `log` (default `console.info` with the
  same `external_ref_provider_call` event and fields). A `log` that throws
  is ignored. The GitHub reads share a small `GithubApi` value (base,
  wrapped fetch, user agent) in place of a bare fetcher.
- The `hosts` option (plug point (a) below the differences) is in:
  `githubGrammar({ hosts })`, `gitlabGrammar({ hosts })`,
  `createGithubAdapter({ hosts })`, `createGitlabAdapter({ hosts })` and
  `createReferenceAdapters({ github, gitlab })`, sharing one rule in the new
  `src/hosts.ts`. The default grammars and adapters serve the public hosts
  only, with byte-identical canonicals and keys. A configured host's key is
  `host:` + the Workspaces key form. The GitHub API base is per host
  (`githubApiBase`: `api.github.com`, `{host}/api/v3`, `api.{host}` for
  `*.ghe.com`); GitLab reads `https://{item host}` with or without a token
  (Workspaces read `gitlab.com` anonymously, which was the same host for
  every URL it matched). Additive contract fields: `search` args and
  `PullRef` take `host?`, `scopes` takes `options?: { host? }`, and
  `parseGithubCanonical` / `parseGitlabCanonical` answer `host`.
- `list(query)` (plug point (b)) is in for GitHub, GitLab and Linear, close
  to the suggested types: `ReferenceListQuery` also has `host` and `order`
  (`updated_desc`, `created_desc`, `created_asc`); `RefReadAdapter.list?`
  answers `SearchResult`; the facts gain `labels`, `assignees` and
  `milestone`; `ResolveResult.field` gains `"filter"`. All three read
  GraphQL (GitHub `repository.issues`, or `search` only with text; GitLab
  `project.issues`; Linear `issues(filter:)`), 100 a page. Labels mean every
  label on all three. Linear's `author` stays the assignee, else the
  creator, as in resolve; `assignees` carries the assignee's display name.
  The shared helpers are in the new `src/list-query.ts`.
- Widened unions, in one place: `ReferenceCredentialKind` gains
  `"linear-api-key"`, and the failure's `field` in `ResolveResult` (and so
  in `ExternalRefFailure` and `SearchResult`) gains `"filter"`. A Workspaces switch
  over either union that has no default branch needs the new member.
- Review fixes (#2387). `list`: a quoted GitHub search value keeps its
  colons (only `"`, `\` and line breaks are removed); free-text words are
  quoted and parentheses removed, so no operator or qualifier widens the
  search; logins may hold `_` (Enterprise Managed Users); two or more
  labels or a milestone go through GitHub search (labels AND, exact
  milestone title; the `milestones(query:)` lookup is gone); GitHub and
  GitLab rows are re-checked for host, repository, state, labels and
  milestone, so a page may hold fewer than 100 items, even none, and still
  carry a cursor. `apiOrigin(provider, host)` names the one origin each
  host's calls use. `providerFetch` calls `port.log` as a method and
  swallows a rejected async log. `resolve` reads only a ref whose URL is
  the canonical its grammar mints. `createReferenceAdapters` throws on a
  host named for both forges or owned by another provider.
- Delta review fixes (#2387), replacing part of the entry above: GitHub
  `list` runs search only with text (search answers at most 1,000
  results). With no text it reads `repository.issues` with the first
  label and the milestone number in `filterBy` (the number from a paged
  milestone title search), and the re-check requires the other labels.
  With text, a label or milestone holding `"` or `\`, or quoted text over
  256 characters, answers `field: "filter"`. `createReferenceAdapters`
  also refuses hosts that share an API origin. Linear `resolve` makes the
  same canonical check. A log's rejected thenable is swallowed too.
- Unchanged from the extract, recorded so it is not mistaken for new: a
  canonical on a host the adapter does not serve answers `not_resolvable`
  before the port is asked for a credential, and no fetch runs (Workspaces
  served one host per forge, so it never met this case).
