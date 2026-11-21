# @plannotator/references

The read side of the external references layer: turn a provider URL into a
typed reference, and resolve that reference into live title and state facts.
It carries one URL grammar per provider, a read-side registry, and read
adapters for GitHub, GitLab and Linear. Every provider call goes through one
small credential port that the host app supplies.

The code was cut from the Workspaces references layer. Types and names match
the Workspaces originals so Workspaces can adopt the package by re-import.

## What is in it

| Module | What it does |
| --- | --- |
| `contract.ts` | `ExternalRef`, `ExternalRefFacts`, `ExternalRefState`, `ResolveResult`, `SearchResult`, `ScopesResult`, the code-link types, and `RefReadAdapter` (the read half of the adapter interface). |
| `port.ts` | `ReferencePort`, `ReferenceCredential` and `credentialFor`. |
| `hosts.ts` | The served-hosts rule the forge grammars and adapters share (the `hosts` option), and `apiOrigin(provider, host)`. |
| `fetch.ts` | The outbound fetch policy: ten-second deadline, same-origin redirects only (at most 20), one log line with host, status and duration. |
| `grammars/` | `github.ts`, `gitlab.ts`, `linear.ts`: URL recognition and canonical URLs (`githubGrammar({ hosts })`, `gitlabGrammar({ hosts })`). `git-branch.ts`: the branch-tail rules for code links. Pure functions, no fetch. |
| `adapters/` | `github.ts` (resolve), `github-pulls.ts` (search, scopes, list), `github-pull-diff.ts` (pull summary, pinned diff, file list), `gitlab.ts` (resolve, list), `linear.ts` (resolve, list). |
| `list-query.ts` | What the three `list` reads share: the query checks, the every-label rule, one GraphQL POST. |
| `registry.ts` | `createReferenceRegistry(adapters)`, `createReferenceAdapters({ github, gitlab })` (the three adapters with extra hosts), and a default registry over the three adapters: `adapterFor`, `matchExternalRef`, `matchExternalRefCandidates`, `matchCodeLinkUrl`, `matchExternalRefUrl`. |
| `picker-modes.ts` | The picker presentation rows for GitHub and Linear. GitLab falls to the paste default. |

## Hosts

By default the hosts are `github.com`, `gitlab.com` and `linear.app` (each
with its `www.` form). GitHub Enterprise and self-managed GitLab hosts are
added per adapter:

```ts
import { createReferenceAdapters, createReferenceRegistry } from "@plannotator/references";

const registry = createReferenceRegistry(
  createReferenceAdapters({
    github: { hosts: ["github.acme.corp"] },
    gitlab: { hosts: ["gitlab.acme.corp"] },
  }),
);
```

- A host is a bare lowercase hostname: no scheme, port or path. Anything
  else throws a `TypeError` when the adapter is built.
  `createReferenceAdapters` also throws when a host is named for both
  forges, is another provider's host (`github.com`, `gitlab.com`,
  `linear.app`, or their `www.` forms), or would read an API origin that
  another served host already reads (`api.github.com`, `api.linear.app`).
- `resolve` (GitHub, GitLab and Linear) reads only a ref whose URL is the canonical its grammar mints
  (matching the URL again gives back the same URL). A hand-made ref, or
  one on a host the adapter does not serve, answers `not_resolvable` before
  any credential is asked.
- A canonical URL keeps the host it was matched on. On `github.com` and
  `gitlab.com`, keys and URLs are the same as before. On another host the
  key starts with `host:` (`github.acme.corp:acme/web#12`), so the same
  path on two hosts never shares a key.
- Each item is read from its own host's API, with a credential asked for
  that host. `apiOrigin(provider, host)` returns the one origin every call
  for that host goes to, so a port can bind its fetch (and the host's
  token) to it:

  | Provider and host | `apiOrigin` | Calls |
  | --- | --- | --- |
  | GitHub `github.com` | `https://api.github.com` | REST `/…`, GraphQL `/graphql` |
  | GitHub `{x}.ghe.com` | `https://api.{x}.ghe.com` | REST `/…`, GraphQL `/graphql` |
  | GitHub Enterprise Server `{host}` | `https://{host}` | REST `/api/v3/…`, GraphQL `/api/graphql` |
  | GitLab `{host}` (gitlab.com too) | `https://{host}` | REST `/api/v4/…`, GraphQL `/api/graphql` |
  | Linear `linear.app` | `https://api.linear.app` | GraphQL `/graphql` |

  `githubApiBase(host)` is the REST base URL (with `/api/v3` on GitHub
  Enterprise Server), not an origin; bind to `apiOrigin` instead.
- `search`, `scopes` and the pull reads take an optional `host` (default the
  public host). For a host the adapter does not serve, the answer is a
  scope error (or `not_linked` for a pull). No credential is asked and no
  fetch runs.

## Quick use

```ts
import { matchExternalRef, type ReferencePort } from "@plannotator/references";

const port: ReferencePort = {
  fetch,
  async credential(provider, host) {
    // Return a token for this provider and host, or null.
    return null;
  },
};

const found = matchExternalRef(new URL("https://github.com/acme/api/issues/482"));
if (found) {
  const result = await found.adapter.resolve(found.ref, port);
  // result.ok ? result.facts : result.reason ("not_linked" | "not_resolvable")
}
```

Adapters answer and never throw. A failure is `{ ok: false, reason }`, with
`credentialDead: true` when the provider proved the credential dead, and
`rateLimited: true` when GitHub rate-limited the read (403 or 429).

## Listing issues

`adapter.list(query, port)` answers one page (up to 100) of a scope's
issues, filtered by the provider, in the same `SearchResult` shape as
`search`. Pull and merge requests are never listed. A page can hold fewer
than 100 items, even none, and still carry a `cursor`: the rows are
re-checked after the read. Read on until a page has no `cursor`.

```ts
const page = await githubAdapter.list?.(
  { scope: "acme/web", state: "open", labels: ["bug"], assignee: "mara", order: "created_asc" },
  port,
);
// page.ok ? page.items (facts with labels, assignees, milestone) and page.cursor : page.field / page.reason
```

| Field | Meaning |
| --- | --- |
| `scope` | GitHub `owner/repo`, GitLab `group/sub/project` (both required); a Linear team key (optional). |
| `host` | One of the adapter's served hosts (default the public host). |
| `state` | `open` (default), `closed` or `all`. |
| `labels` | Every label must be on the issue. |
| `assignee` | A GitHub login, a GitLab username, or a Linear display name or email. |
| `milestone` | A milestone title (Linear: a project milestone name). |
| `text` | Free text. |
| `order` | `updated_desc` (default), `created_desc`, or `created_asc` (oldest first). |
| `cursor` | The previous page's `cursor`, with the same query. |

- GitHub, with no `text`, reads GraphQL `repository.issues` with
  `filterBy` and `orderBy`. That read has no result cap. `filterBy` takes
  the state, the assignee, the first label (it matches any of its labels,
  so one is exact), and the milestone by number. The number is found by
  paging the repository's milestone title search (up to 10 pages of 100)
  for the exact title. No such milestone is an empty page. The re-check
  below requires every other label.
- GitHub, with `text`, uses the search API. **GitHub search answers at most
  1,000 results per query**, so a text list ends after 10 pages with no
  cursor. A label or milestone is a quoted value (`label:"type: bug"`
  stays as written); one holding `"` or `\` answers `field: "filter"`. In
  the free text, quotes, backslashes and parentheses are removed and every
  word is quoted, so no word can be a qualifier (`repo:other/x`) or an
  operator (`OR`, `AND`, `NOT`, a leading `-`). Quoted text longer than
  GitHub's 256-character search limit answers `field: "filter"`. (A
  milestone title search that runs past 10 pages without the exact title
  also falls back to search.) There is no anonymous rung.
- GitLab reads GraphQL `project.issues` with `state`, `labelName`,
  `assigneeUsernames`, `milestoneTitle`, `search` and `sort`. With no
  credential, a public project lists anonymously from its own host.
  gitlab.com may refuse `search` to an anonymous caller, so an anonymous
  `text` list can answer `not_resolvable`. GitLab's milestone wildcards
  (`None`, `Any`, `Upcoming`, `Started`) and label wildcards (`None`,
  `Any`) never widen the answer: see the re-check below.
- GitHub and GitLab rows are re-checked after the read: the row's host and
  repository or project, its state, every label, and the milestone title
  (labels and milestone case-insensitive). A row whose labels run past the
  page read for it (100 labels) is kept, never dropped for a label it may
  carry. On GitHub with no text, such a row (more than 100 labels) can
  therefore lack a second or later label asked for.
- Linear reads `issues(filter:)` in the credential's workspace (`account`).
  It always sends `orderBy` (`createdAt` or `updatedAt`); Linear orders
  newest first and has no direction argument, so oldest first reads the
  last page (`last: 100, before: cursor`) and reverses it. The next
  cursor is that page's `startCursor` while `hasPreviousPage` holds.
- A bad cursor, or an empty or too-long filter, answers `field: "cursor"` or
  `field: "filter"` before a credential is asked.

## The port

```ts
interface ReferencePort {
  fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  credential(provider: ProviderId, host: string): Promise<ReferenceCredentialAnswer>;
  /** user-agent on GitHub and GitLab calls; default "plannotator-workspaces". */
  userAgent?: string;
  /** the one line per provider call; default console.info. */
  log?: (event: "external_ref_provider_call", fields: { host: string; status: number | undefined; duration_ms: number }) => void;
}

type ReferenceCredentialAnswer =
  | { kind: "installation" | "bearer" | "private-token" | "linear-api-key"; token: string; host: string; account?: string }
  | { kind: "unavailable"; credentialDead: boolean }
  | null;
```

An adapter asks for a credential with the provider id and the host of the
canonical URL it is resolving (`"github.com"`, `"gitlab.com"`, `"linear.app"`, or a configured host).

| Provider | Kinds it sends | Header | No credential (`null`) |
| --- | --- | --- | --- |
| GitHub | `installation`, `bearer` | `Authorization: Bearer` | resolve reads the item host's API (`apiOrigin("github", host)`) anonymously; search, scopes, list and pull reads answer `not_linked` |
| GitLab | `private-token`, `bearer` | `PRIVATE-TOKEN`, or `Authorization: Bearer` | resolve and list read the item host's API (`apiOrigin("gitlab", host)`) anonymously |
| Linear | `bearer` or `linear-api-key` (each with `account`) | `Authorization: Bearer`, or the bare `Authorization: <key>` | `not_linked`, with no fetch |

Rules the adapters apply to every answer (`credentialFor` in `port.ts`):

- A credential whose `host` differs from the host asked for is never used.
- A credential of a kind the provider cannot send, or with an empty token, is never used.
- `{ kind: "unavailable", credentialDead }` becomes `not_resolvable` with that `credentialDead`, and no provider fetch runs.
- A port that throws reads as `unavailable` with `credentialDead: false`.
- GitHub `scopes` lists `GET /installation/repositories`, so it needs an `installation` token. A `bearer` token answers `not_linked`.
- Linear needs `account`: the workspace urlKey the token belongs to. A Linear URL on any other workspace answers `not_linked` with no fetch. Linear answers `issue(id: "ENG-1")` inside the token's own workspace, so without this check a foreign workspace's URL would show your workspace's issue.

The port's `fetch` is wrapped by `fetch.ts` on every call. Redirects to
another origin are returned, not followed, so a credential header never
leaves the origin it was sent to. Each call writes one line to the port's
`log` (host, status and duration only); a `log` that throws, or returns a
promise or thenable that rejects, is ignored.
Each product names itself with `userAgent`; the adapters hold no product
names.

## How each product backs the port

**Workspaces** backs it with its connection store and its own provider apps:

- GitHub: the org's connection mints a one-hour installation token from the
  deployment's GitHub App and answers `installation`. With no connection it
  mints from the App's home installation, if the deployment has one. A home
  installation that fails to mint answers `null`, so public repos still
  resolve anonymously. An org installation that answers 404 on mint answers
  `{ kind: "unavailable", credentialDead: true }`.
- GitLab: the org's sealed `{ baseUrl, token }`, opened per call, answered
  as `private-token` with `host` set to the base URL's hostname. A secret that
  will not open or parse answers `unavailable` with `credentialDead: true`.
- Linear: the org's OAuth credential. The port refreshes a lapsed access
  token (single-flight, the rotated pair persisted before use) and answers
  `bearer` with `account` set to the installed workspace urlKey. A refresh
  refused with 400 or 401 answers `credentialDead: true`; a network failure,
  429 or 5xx answers `credentialDead: false`.
- Workspaces keeps its insider rule (only organization members get the
  connection credential; guests get `null`), its resolve cache, and the
  `broken_at` stamp it writes when an answer carries `credentialDead: true`.

**The local Inbox** backs it with borrowed credentials:

- GitHub: `gh auth token --hostname H` for a host gh is signed in to,
  answered as `bearer`.
- GitLab: glab's stored token for a host glab is signed in to, answered as
  `private-token` or `bearer` according to how glab stored it.
- Linear: none in v1. A later typed personal key is answered as `linear-api-key`, with `account` set to its workspace urlKey (see below).
- The host gate is the port's job: hand out a credential only for a host
  the CLI is signed in to, and bind the port's `fetch` to that host's API
  origin, `apiOrigin(provider, host)` (for `github.com` that is
  `https://api.github.com`, for `x.ghe.com` it is `https://api.x.ghe.com`;
  `githubApiBase` gives the REST base, not the bind target). A planted `origin` must not be able to send a token anywhere
  else. The
  adapters check the host they asked for, but they cannot know which hosts
  the CLI is signed in to.

Linear personal API keys are sent without the `Bearer` prefix (Linear's
OAuth tokens take it), so they have their own kind: `linear-api-key` sends
the bare `Authorization: <key>`, and `bearer` always adds the prefix. Both
need `account`. GitHub and GitLab never send a `linear-api-key`.

## What is deliberately not in it

- The connect side of every adapter: OAuth redirect steps, PKCE, region
  tables, the GitHub App JWT and token mint, Linear's refresh and rotation,
  form probes, and anything that reads deployment env or an app origin.
- Credential storage and sealing, the resolve cache, the insider rule, HTTP
  routes, the MCP tool, and the live API contract. They stay in Workspaces.
- The other 30 Workspaces adapters (Bitbucket, Atlassian, Slack and the
  rest).
- The web client's text scanners (`findExternalRefUrls` and the
  sentence-punctuation rules) and its string form of the code-link matcher.
- Any write to a provider. Every call is a read.

## Development

The package lives in the Plannotator monorepo at `packages/references`.

```sh
bun install          # at the repo root
bun run typecheck    # in this folder: tsc over src (strict) and over src + test
bun test             # in this folder; the root `bun test` runs the same files
```

Tests fake providers at the port's `fetch` only, with low-entropy fixture
values. One test is a tripwire: no source file may read env (`process.env`,
`Bun.env`, `import.meta.env`, `Deno.env`), mint a JWT, name an auth-flow
step (`refresh_token`, `client_secret`, `grant_type`, `/login/oauth`,
`oauth`), call `require(` or a computed or package `import(`, call the
global fetch (a bare `fetch(`, or through `globalThis`, `self`, `window`
or `global`; `src/fetch.ts` included), or import anything
but relative modules and `@plannotator/core/diff-paths` (side-effect
imports included).

The only runtime dependency is `@plannotator/core`, for the git path quoting
in `diff-paths` that the pull request diff uses.
