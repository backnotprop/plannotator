# Runtime Frontend Shell Functionality Inventory

This inventory is the planning baseline for the single runtime frontend shell. It reuses the single-binary and daemon inventories, then adds the frontend-specific view of the world: what each current local runtime app does, which backend APIs it depends on, which session modes the new shell must understand, and which contracts the skeleton must test before any real UI migration begins.

## Stack Boundary

- [x] Implementation branch should be a third stacked branch, created from the current tip of `feat/plannotator-daemon-runtime`.
- [x] Suggested branch: `feat/runtime-frontend-shell`.
- [x] PR base should be `feat/plannotator-daemon-runtime` / PR #734, not `feat/single-server-runtime` and not `main`.
- [x] This branch should not replace the currently served `apps/hook/dist/index.html` or `apps/hook/dist/review.html`.
- [x] The new app should be independently buildable and testable before daemon production routing switches to it.

## Existing Local Runtime Frontends

| Frontend | Current entry | Current served HTML | Runtime role | New shell implication |
| --- | --- | --- | --- | --- |
| Plan/editor app | `apps/hook/index.tsx` -> `packages/editor/App.tsx` | `apps/hook/dist/index.html` | Plan review, annotate, annotate-last, annotate-folder, archive. | New shell needs stub session views for all these modes and must understand `/api/plan` bootstrap variants. |
| Review app | `apps/review/index.tsx` -> `packages/review-editor/App.tsx` | copied to `apps/hook/dist/review.html` | Local diff review, PR review, AI chat, agent jobs, code nav, PR actions. | New shell needs review stub and full review API inventory even though UI is not migrated yet. |
| Portal app | `apps/portal/index.tsx` | separately hosted/share portal | Shared plan viewing/editing, not daemon local runtime. | Out of scope for the skeleton except shared editor/theme code awareness. |
| Marketing app | `apps/marketing` | public site | Docs/blog/marketing. | Out of scope. |
| OpenCode plugin UI | no longer owns HTML after single-binary phase | binary/daemon served | Host integration and command injection. | Shell tests need OpenCode-origin fixtures but not OpenCode UI. |
| Pi extension UI | no longer owns HTML after single-binary phase | binary/daemon served | Host integration, phase state, event channel. | Shell tests need Pi-origin fixtures but not Pi UI. |
| Setup-goal UI | locally installed binary supports `plannotator setup-goal ...`; source is not present in this branch | unknown in this checkout | Interview/facts/plan gate workflow. | Shell includes setup-goal stub and fixtures, but plan should not change plugin protocol unless setup-goal mode appears in source. |

## Source Code Audit Baseline

This goal package was checked against the actual source, not only the PR review notes. Implementation should repeat this audit before completion and record changes here.

| Area | Source checked | Shell planning consequence |
| --- | --- | --- |
| Prior runtime inventory | `goals/single-bun-server-runtime/functionality-inventory.md` | The shell inherits the single binary boundary: OpenCode/Pi are clients; browser/server ownership stays in the `plannotator` binary. |
| Daemon inventory | `goals/plannotator-daemon-runtime/functionality-inventory.md` | The shell inherits one daemon process with multiple `/s/<id>` sessions and session-scoped APIs. |
| Project docs | `CLAUDE.md`, `AGENTS.md`, `docs/single-binary-runtime.md` | Docs already describe daemon-backed session URLs; shell docs should extend this, not contradict it. |
| Workspace/build scripts | root `package.json`, `apps/hook/package.json`, `apps/review/package.json`, `packages/ui/package.json` | New `apps/frontend` scripts should be additive and independently runnable. |
| Daemon protocol | `packages/shared/daemon-protocol.ts` | Current shared daemon types lack a browser bootstrap response; add one instead of inventing app-local protocol shapes. |
| Daemon router | `packages/server/daemon/server.ts` | Current browser HTML route injects API base and delegates `/s/:id/api/*`; add `/s/:id/api/session` before delegation. |
| Plan/archive server | `packages/server/index.ts` | Plan and archive bootstrap still use `/api/plan`, with different mode payloads; fixtures must represent both. |
| Annotate server | `packages/server/annotate.ts` | Annotate reuses `/api/plan` with `mode`, `filePath`, source metadata, gate, and HTML rendering fields. |
| Review server | `packages/server/review.ts` | Review bootstrap is `/api/diff`; PR, AI, agent, code-nav, tour, staging, draft, and platform actions are separate API groups. |
| Plan/editor frontend | `packages/editor/App.tsx`, `packages/ui/hooks/*`, `packages/ui/components/*` | Current plan app owns dense UI state; the skeleton should not migrate it, but must leave product module folders ready for those future product areas. |
| Review frontend | `packages/review-editor/App.tsx`, `packages/review-editor/hooks/*`, `packages/review-editor/dock/*` | Current review app owns diff state, dock panels, PR switching, AI, agents, code nav, and platform submission; the review stub should name these future product areas. |
| API-base compatibility | `packages/ui/utils/api.ts`, `packages/ui/utils/api.test.ts`, image helpers | Existing apps are transitioning away from root `/api`; the new shell must start with explicit `apiBase` clients and tests that catch root API calls. |

## Daemon Runtime Contract

Current daemon routes from `packages/server/daemon/server.ts`:

| Route | Current purpose | Shell use |
| --- | --- | --- |
| `GET /daemon/capabilities` | Versioned daemon capabilities. | Dashboard capability check and fixture parity. |
| `GET /daemon/status` | PID, endpoint, protocol, startedAt, active/total session count. | Dashboard header/status summary. |
| `GET /daemon/sessions` | Active session summaries. | Session index/dashboard route. |
| `POST /daemon/sessions` | Create plan/review/annotate/archive sessions. | Not needed by first skeleton UI except optional fixture/test actions. |
| `GET /daemon/sessions/:id` | One session summary. | Existing fallback; new shell should prefer session-scoped bootstrap. |
| `GET /daemon/sessions/:id/result` | Blocking result wait for CLI/plugin callers. | Not used by browser shell except to understand terminal statuses. |
| `POST /daemon/sessions/:id/cancel` | Cancel one session. | Possible stub action; API client can include it if simple. |
| `DELETE /daemon/sessions/:id` | Dispose one session. | Out of first UI scope unless dashboard includes remove action. |
| `POST /daemon/shutdown` | Stop daemon. | Out of first shell scope. |
| `GET /s/:id` | Serve current mode-specific HTML. | Future entry for one shell. |
| `/s/:id/api/*` | Route to owning session handler after stripping `/s/:id`. | New shell must always use this session-scoped base. |

Required new bootstrap contract for shell:

| Proposed route | Purpose | Required fields |
| --- | --- | --- |
| `GET /s/:id/api/session` | Session bootstrap for the single app shell. | `ok`, `session`, `apiBase`, `capabilities`, supported session views, maybe daemon protocol/version. |

## Session Modes And View Modules

| Session view | Current daemon mode/source | Current app | Required skeleton behavior |
| --- | --- | --- | --- |
| Plan review | `DaemonSessionMode` / `PluginSessionMode`: `plan` | `packages/editor/App.tsx` | Render plan stub from bootstrap; preserve project/origin/label/status/apiBase. |
| Code review / PR review | `review` | `packages/review-editor/App.tsx` | Render review stub from bootstrap; include PR/diff capability placeholders. |
| Annotate file/folder/last | `annotate` plus mode detail from `/api/plan` today | `packages/editor/App.tsx` | Render annotate stub; inventory must note submodes are not represented in `DaemonSessionMode` today. |
| Archive | `archive` | `packages/editor/App.tsx` | Render archive stub; understand archive has done/result semantics rather than approve/deny. |
| Setup goal | not in current shared daemon/plugin mode types | local binary support only | Render fixture-backed setup-goal stub; backend integration deferred until source contract exists. |

## Plan / Archive / Annotate App Responsibilities

Current app: `packages/editor/App.tsx`.

Core state and behavior to preserve later:

- Markdown/raw HTML content display.
- Plan review approve/deny flow.
- Annotate feedback/approve/exit flow.
- Archive browsing and Done flow.
- Annotation creation, selection, deletion, global comments, redline mode, image attachments.
- Plan version history, plan diff badge, clean/raw diff views, diff annotations.
- Linked docs, code-file popouts, file browser, Obsidian browser.
- Settings: identity, save plan, notes integrations, permission mode, file browser, hooks status.
- External annotations stream and polling fallback.
- Editor annotations from VS Code.
- Draft persistence.
- Agent switching for host integrations.
- Notes export/save integrations.
- Share/paste behavior.
- Completion overlay and submitted state.

Plan/archive endpoints from `packages/server/index.ts`:

| Endpoint | Methods | Current frontend callers / purpose |
| --- | --- | --- |
| `/api/plan` | GET | Plan bootstrap, archive bootstrap, server config, version info, repo info. |
| `/api/plan/version` | GET | `usePlanDiff` fetch selected version. |
| `/api/plan/versions` | GET | `usePlanDiff` list versions. |
| `/api/archive/plans` | GET | `useArchive` list archived decisions. |
| `/api/archive/plan` | GET | `useArchive` load one archived plan. |
| `/api/done` | POST | Archive Done. |
| `/api/doc` | GET | Linked docs, code file popout, HTML blocks, file browser document load. |
| `/api/doc/exists` | POST | Batch code-file validation for renderer links. |
| `/api/hooks/status` | GET | Settings Hooks tab. |
| `/api/config` | POST | `configStore` server write-back. |
| `/api/image` | GET | Image thumbnails and markdown/HTML images. |
| `/api/upload` | POST | Attachment uploads. |
| `/api/plan/vscode-diff` | POST | Open plan version diff in VS Code. |
| `/api/obsidian/vaults` | GET | Settings vault discovery. |
| `/api/reference/obsidian/files` | GET | Obsidian file tree. |
| `/api/reference/obsidian/doc` | GET | Obsidian doc read. |
| `/api/reference/files` | GET | Generic file browser tree. |
| `/api/agents` | GET | Agent switch options. |
| `/api/draft` | GET/POST/DELETE | Annotation draft load/save/delete. |
| `/api/save-notes` | POST | Notes app integrations and export modal. |
| `/api/approve` | POST | Plan approve with save/integration/agent switch payload. |
| `/api/deny` | POST | Plan denial with feedback/save payload. |
| `/favicon.svg` | GET | Favicon. |

Annotate endpoints from `packages/server/annotate.ts`:

| Endpoint | Methods | Current frontend callers / purpose |
| --- | --- | --- |
| `/api/plan` | GET | Annotate bootstrap; returns mode, filePath, sourceInfo, gate, rawHtml/renderAs. |
| `/api/config` | POST | Settings write-back. |
| `/api/image` | GET | Image resources. |
| `/api/doc` | GET | Linked files relative to annotate source/base. |
| `/api/doc/exists` | POST | Code-file validation. |
| `/api/obsidian/vaults` | GET | Vault discovery. |
| `/api/reference/obsidian/files` | GET | Obsidian file tree. |
| `/api/reference/obsidian/doc` | GET | Obsidian document read. |
| `/api/reference/files` | GET | Generic file tree. |
| `/api/upload` | POST | Attachment upload. |
| `/api/draft` | GET/POST/DELETE | Annotation draft load/save/delete. |
| `/api/exit` | POST | Close without feedback. |
| `/api/approve` | POST | Review-gate approve. |
| `/api/feedback` | POST | Send annotation feedback. |
| `/favicon.svg` | GET | Favicon. |

## Review App Responsibilities

Current app: `packages/review-editor/App.tsx`.

Core state and behavior to preserve later:

- Diff bootstrap and parsing.
- File tree, active file, all-files view, search.
- Code annotations and review submission.
- PR metadata display, stacked PR context, PR switch, PR diff scope.
- AI chat sessions, streaming turns, permission responses, abort.
- Agent jobs, SSE job logs, agent review actions.
- Code navigation resolve/file preview.
- Git add/stage actions.
- Tour result/checklist.
- Editor annotations and external annotations.
- Draft persistence.
- Dockview panel layout and panel-specific state.
- Platform PR actions and viewed marker.
- Review exit/feedback result handling.

Review endpoints from `packages/server/review.ts`:

| Endpoint | Methods | Current frontend callers / purpose |
| --- | --- | --- |
| `/api/diff` | GET | Review bootstrap; raw patch, gitRef, origin, gitContext, PR metadata, server config. |
| `/api/diff/switch` | POST | Switch local diff type/base/whitespace mode. |
| `/api/pr-diff-scope` | POST | Switch PR layer/full-stack scope. |
| `/api/pr-list` | GET | PR selector list. |
| `/api/pr-switch` | POST | In-place PR switch. |
| `/api/pr-context` | GET | PR context for UI/agents. |
| `/api/file-content` | GET | Expand diff context and lazy file diff content. |
| `/api/code-nav/resolve` | POST | Resolve definitions/references. |
| `/api/code-nav/file` | GET | Code nav preview file content. |
| `/api/git-add` | POST | Stage/unstage file. |
| `/api/config` | POST | Settings write-back. |
| `/api/image` | GET | Image resources. |
| `/api/upload` | POST | Attachment upload. |
| `/api/agents` | GET | Agent switch options. |
| `/api/draft` | GET/POST/DELETE | Code annotation draft. |
| `/api/exit` | POST | Close review session. |
| `/api/feedback` | POST | Send feedback/approval with annotations. |
| `/api/pr-action` | POST | PR platform action/comment/approval. |
| `/api/pr-viewed` | POST | Mark PR viewed. |
| `/api/tour/:jobId` | GET | Fetch Code Tour result. |
| `/api/tour/:jobId/checklist` | PUT | Persist tour checklist. |
| `/api/ai/capabilities` | GET | AI providers/models/capabilities. |
| `/api/ai/session` | POST | Create/fork AI session. |
| `/api/ai/query` | POST | Stream AI response via SSE. |
| `/api/ai/abort` | POST | Abort active AI query. |
| `/api/ai/permission` | POST | Respond to AI permission request. |
| `/api/ai/sessions` | GET | List AI sessions. |
| `/favicon.svg` | GET | Favicon. |

## Shared Runtime APIs

These endpoints are shared across plan/review/annotate session views and must be represented in shell test fixtures even if stubs only display status.

| API group | Endpoints | Source |
| --- | --- | --- |
| External annotations | `GET /api/external-annotations/stream`, `GET/POST/PATCH/DELETE /api/external-annotations` | `packages/server/external-annotations.ts` |
| Editor annotations | `GET /api/editor-annotations`, `POST/DELETE /api/editor-annotation` | `packages/server/editor-annotations.ts` |
| Agent jobs | `GET /api/agents/capabilities`, `GET /api/agents/jobs/stream`, `GET/POST/DELETE /api/agents/jobs`, `DELETE /api/agents/jobs/:id` | `packages/server/agent-jobs.ts` |
| Image/upload | `GET /api/image`, `POST /api/upload` | `packages/server/shared-handlers.ts` |
| Drafts | `GET/POST/DELETE /api/draft` | `packages/server/shared-handlers.ts` |
| Agents list | `GET /api/agents` | `packages/server/shared-handlers.ts` |
| Reference docs | `/api/doc`, `/api/doc/exists`, `/api/reference/*`, `/api/obsidian/vaults` | `packages/server/reference-handlers.ts` |
| Config | `POST /api/config` | plan/review/annotate servers |

## Current API Base Migration State

- Existing apps still call root `/api/...` in many places.
- The daemon currently injects `window.__PLANNOTATOR_API_BASE__` and monkey-patches `fetch`, `Request`, and `EventSource` root API calls.
- Image helpers already use `apiPath()` for daemon-safe `/api/image` resources.
- The new shell should not rely on monkey patching for its own code. It should use a typed API client with `apiBase` from bootstrap.
- The shell should include tests that fail if it accidentally calls root `/api/*` for session-owned resources.

## Required Shell Test Fixtures

The shell needs fixture data for:

- daemon capabilities
- daemon status
- empty session list
- multiple active sessions with mixed modes and origins
- one plan session bootstrap
- one review session bootstrap with PR-ish labels
- one annotate session bootstrap
- one archive session bootstrap
- one setup-goal session bootstrap fixture
- session-not-found error
- daemon/backend error
- malformed JSON/network failure
- unsupported session mode

Fixture data should use shared Plannotator types where available:

- `DaemonSessionSummary`
- `DaemonStatus`
- `DaemonCapabilities`
- `DaemonErrorResponse`
- `PluginSessionMode`
- `Origin`
- existing annotation/review/shared types when a fixture represents current payload shapes

## Verification Inventory

| Area | Required check |
| --- | --- |
| Route tree | Valid session id accepts; invalid session id rejects; generated route tree is ignored by lint/format. |
| Dashboard | Empty state, loaded multi-session list, backend error state. |
| Session route | Bootstrap success, missing session, malformed response, network failure. |
| Session-view registry | `plan`, `review`, `annotate`, `archive`, `setup-goal`, unsupported mode. |
| State stores | Session summaries keyed by id, selected session, per-session bootstrap cache, per-session errors, independent updates. |
| API client | Correct URL construction, no root `/api/*` for session calls, JSON parsing, daemon error normalization. |
| Browser behavior | Built or Vite-served shell renders dashboard, opens session route, shows correct stub session view, handles backend failure. |
| Tooling | Runtime app build, typecheck, OxLint, Oxfmt check, Vitest, Vitest Browser Mode. |

## Plan Closure Checklist

- [x] Plan is revised after this inventory, not before.
- [x] Revised plan includes this inventory as step 1 and implementation completion evidence.
- [x] Revised plan states the third stacked branch base explicitly.
- [x] Revised plan includes all endpoint groups above in the testing/fixture strategy.
- [x] Revised plan gates through Plannotator after revision.

## Implementation Evidence

Recorded after implementation on `feat/runtime-frontend-shell`.

### Daemon Bootstrap Contract

- `packages/shared/daemon-protocol.ts` now advertises `session-bootstrap` and exports `DaemonSessionBootstrapResponse`.
- `packages/shared/daemon-protocol.ts` now exports supported shell views: `plan`, `review`, `annotate`, `archive`, and `setup-goal`.
- `packages/server/daemon/server.ts` now serves `GET /s/:id/api/session` before delegating to mode-specific handlers.
- Missing-session bootstrap requests return a daemon JSON error with `session-not-found`, not a plain HTML/text 404.

### Frontend App

- `apps/frontend` is a Vite React TypeScript workspace app.
- Runtime libraries: TanStack Router, Zustand, Immer, React.
- Tooling: OxLint, Oxfmt, Vitest, Vitest Browser Mode with Playwright.
- Root scripts added: `dev:frontend`, `build:frontend`, `check:frontend`.
- Existing production-served HTML bundles remain untouched.

### Source Organization

- `src/routes` is thin TanStack Router wiring for `/` and `/s/$sessionId`.
- `src/daemon` owns the typed daemon API client and shell contract adapters.
- `src/sessions` owns session id validation, dashboard, state, and mode dispatch.
- `src/plan`, `src/review`, `src/annotate`, `src/archive`, and `src/setup-goal` own product stub views.
- `src/testing` owns daemon fixtures, fixture fetch, and browser render helpers.
- No generic `src/features` directory was introduced.

### Fixture Coverage

- Daemon status, daemon capabilities, empty sessions, mixed active sessions, and bootstrap fixtures are present.
- Bootstrap fixtures cover `plan`, `review`, `annotate`, `archive`, `setup-goal`, and unsupported mode handling.
- API group fixtures represent plan/archive/annotate, review, and shared runtime endpoint groups.
- Setup-goal backend endpoints are explicitly marked deferred because this checkout does not expose a setup-goal daemon contract.

### Verification Run

- `bun install`
- `bun run --cwd apps/frontend test`
- `bun run --cwd apps/frontend typecheck`
- `bun run --cwd apps/frontend lint`
- `bun run --cwd apps/frontend fmt:check`
- `bun run --cwd apps/frontend check`
- `bun run --cwd apps/frontend build`
- `bun run --cwd apps/frontend test:browser`
- `bun run build:frontend`
- `bun run check:frontend`
- `bun test packages/shared/daemon-protocol.test.ts packages/server/daemon/server.test.ts`
- `bun run typecheck`
- `bun test`

### Local Test Environment Note

- Playwright Chromium revision `1217` was installed through the local `playwright-core@1.59.1` CLI so Vitest Browser Mode can run in this workspace cache.
