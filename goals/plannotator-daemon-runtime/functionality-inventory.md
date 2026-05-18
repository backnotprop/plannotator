# Plannotator Daemon Runtime Functionality Inventory

This inventory was created before daemon implementation work. Its purpose is to prevent parity loss while Plannotator moves from request-scoped browser servers to one long-running binary-owned daemon.

## Stack Boundary

- [x] Implementation branch is `feat/plannotator-daemon-runtime`.
- [x] Branch is stacked on `feat/single-server-runtime`.
- [x] PR #734 targets `feat/single-server-runtime` / PR #733, not `main`.
- [x] Goal plan includes a dedicated stacked PR section.

## Fact Verification Checklist

| Fact | Final evidence | Final check |
| --- | --- | --- |
| Real long-running binary-owned daemon serves multiple plan/review/annotate/archive browser sessions. | `packages/server/daemon/runtime.ts`, `server.ts`, `session-store.ts`; daemon-backed plugin smoke approved through `/s/<id>/api/approve`; `rg` shows hook CLI no longer calls request-scoped server starters. | [x] |
| One normal daemon per user/machine environment owns active sessions, ports, and daemon-backed command state. | `state.ts` state/lock handling; `runtime.test.ts` rejects a second daemon for same state dir. | [x] |
| Daemon-backed CLI/plugin commands connect to daemon; help/version/start/status/stop may run directly. | `apps/hook/server/index.ts` routes browser-session commands through `runDaemonSessionRequest`; `cli.test.ts` covers help text. | [x] |
| First daemon transport is localhost HTTP with reusable protocol types. | `packages/shared/daemon-protocol.ts`; `daemon-protocol.test.ts`; `server.test.ts`. | [x] |
| CLI/plugin requests auto-start missing daemon and reuse a compatible daemon. | `ensureDaemonClient()` auto-starts missing/stale/malformed state; daemon-backed plugin smoke started from empty temp `HOME`. | [x] |
| Missing/stale/unhealthy/incompatible daemon state recovers or errors without parallel daemon spawn. | `client.test.ts` covers missing/stale/incompatible plus local/remote and port mismatches; `ensureDaemonClient()` only auto-starts safe cases and errors for unhealthy/incompatible/mismatch. | [x] |
| Basic lifecycle commands start, status, stop exist. | `runDaemonCommand()` implements `daemon start`, `daemon status`, `daemon stop`; lifecycle smoke passed. | [x] |
| Status reports PID, endpoint, protocol/version compatibility, and active session count. | `GET /daemon/status` implementation and `server.test.ts`. | [x] |
| Every plan/review/annotate/archive request gets stable session ID and result state. | `DaemonSessionStore` and session factory records; store and route tests. | [x] |
| All sessions share daemon endpoint/port with session-scoped browser URLs and API routes. | `/s/<id>` and `/s/<id>/api/*` daemon routes; API-base injection test; plugin smoke returned one daemon URL and approved over session route. | [x] |
| Blocking callers and asynchronous callers are both supported. | `waitForResult()` route and store waiters; plugin clients still parse same JSON; OpenCode/Pi tests pass. | [x] |
| Multiple concurrent requests from Claude Code, OpenCode, Pi, Codex, Gemini, Copilot, or direct CLI usage can run without state collisions. | All request origins map into daemon session requests with per-session IDs and handlers; route tests prove session isolation; concurrent plugin smoke verified two plan sessions on one daemon endpoint. | [x] |
| Daemon sessions support cancellation and TTL cleanup so abandoned browser sessions and waiting client requests do not leak forever. | Store cancellation/TTL tests; request timeout-aligned TTL in session factory, 96h default, disabled TTL when caller timeout is disabled; runtime periodic cleanup interval. | [x] |
| Remote mode continues to work with the daemon: `PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT`, SSH/devcontainer detection, browser-open fallback behavior, and reachable session URLs are handled deliberately for the shared daemon endpoint. | Daemon runtime uses existing remote helpers; daemon client rejects mode/port mismatch; remote unit tests and build pass; remote lifecycle smoke verified `0.0.0.0`, fixed `PLANNOTATOR_PORT`, status, and stop. | [x] |
| Existing Claude Code hook and CLI flows, OpenCode binary-client calls, Pi binary-client calls, review, annotate, annotate-last, archive, and remote-mode URL behavior continue to work through the daemon migration. | Full `bun test` pass; builds pass; plugin smoke pass. | [x] |
| The existing `plannotator plugin ...` command surface becomes a daemon client under the hood rather than a request-scoped server launcher, without requiring OpenCode or Pi to change their public command behavior. | Plugin protocol still returns same success/error envelope; `multiSessionDaemon: true`; OpenCode/Pi binary-client tests pass. | [x] |
| This daemon goal does not redesign the UI, change annotation data formats, or introduce a hosted/cloud daemon. | Diff review: no annotation format changes or hosted daemon code. | [x] |
| Broad dumb-plugin-client cleanup, Pi `vendor.sh` removal, and plugin publishing changes are out of scope unless a narrow change is required for daemon connectivity. | Pi/OpenCode remain binary clients; `vendor.sh` remains. | [x] |

## Runtime Ownership Inventory

| Area | Final state | Final check |
| --- | --- | --- |
| Plan server | `createPlannotatorSession()` can run under daemon router; `startPlannotatorServer()` remains as compatibility wrapper. | [x] |
| Review server | `createReviewSession()` can run under daemon router; `dispose()` kills agent jobs, AI sessions, registries, and cleanup callbacks. | [x] |
| Annotate server | `createAnnotateSession()` can run under daemon router; compatibility wrapper remains. | [x] |
| Port binding | One daemon endpoint/port owns all daemon sessions; session routes add `/s/<id>`. | [x] |
| Session registry | `plannotator sessions` queries daemon session list instead of request-scoped process files. | [x] |
| Browser open | CLI opens session-scoped daemon URL returned by session creation. | [x] |
| Remote browser fallback | Existing `handle*ServerReady()` paths receive session-scoped daemon URL. | [x] |
| Remote share links | Session factory writes remote share links for plan and annotate payloads when remote sharing is enabled; review sessions print the real forwarded daemon session URL instead of a plan-format share link. | [x] |

## CLI Entrypoint Inventory

| Command/surface | Final state | Final check |
| --- | --- | --- |
| `plannotator --help` | Stays local; includes daemon command. | [x] |
| `plannotator --version` / `-v` | Stays local. | [x] |
| Interactive no-arg | Stays local. | [x] |
| Default no-arg hook | Creates daemon plan session, waits, emits Claude hook decision shape. | [x] |
| Codex Stop hook | Creates daemon plan session, waits, emits `{}` or block JSON. | [x] |
| Gemini plan hook | Creates daemon plan session, waits, emits Gemini decision JSON. | [x] |
| Copilot plan hook | Creates daemon plan session, waits, emits Copilot permission decision JSON. | [x] |
| `review` | Creates daemon review session and waits, preserving stdout text. | [x] |
| `annotate` | Creates daemon annotate session and waits, preserving outcome handling; at-reference annotate resolution is covered by test. | [x] |
| `last` / `annotate-last` | Creates daemon annotate-last session and waits. | [x] |
| `archive` | Creates daemon archive session and waits for archive close. | [x] |
| `sessions` | Queries daemon session list; can open session-scoped URL by index. | [x] |
| `sessions --clean` | Triggers daemon list cleanup. | [x] |
| `plugin capabilities` | Returns daemon-ready plugin capabilities with `multiSessionDaemon: true`. | [x] |
| `plugin plan/review/annotate/archive` | Reads JSON, creates daemon session, waits, emits same plugin JSON envelope. | [x] |
| `improve-context` | Stays local; not a browser session. | [x] |

## Daemon API Inventory

| Route | Purpose | Final check |
| --- | --- | --- |
| `GET /daemon/capabilities` | Versioned daemon capabilities. | [x] |
| `GET /daemon/status` | PID, endpoint, remote mode, version/protocol, active count. | [x] |
| `GET /daemon/sessions` | List active/recent sessions and run TTL cleanup. | [x] |
| `POST /daemon/sessions` | Create plan/review/annotate/archive session. | [x] |
| `GET /daemon/sessions/:id` | Fetch one session summary. | [x] |
| `GET /daemon/sessions/:id/result` | Blocking/long-poll result wait. | [x] |
| `POST /daemon/sessions/:id/cancel` | Cancel one session and wake waiters. | [x] |
| `DELETE /daemon/sessions/:id` | Dispose one session. | [x] |
| `POST /daemon/shutdown` | Stop daemon. | [x] |
| `GET /s/:id` and `/s/:id/*` | Serve session HTML with API-base injection. | [x] |
| `/s/:id/api/*` | Route API calls to the matching session handler. | [x] |

## UI API Surface Inventory

The daemon currently uses a compatibility bridge instead of rewriting every UI fetch call site in this PR. HTML injection sets `window.__PLANNOTATOR_API_BASE__` and monkey-patches `fetch` and `EventSource` root `/api/...` calls to `/s/<id>/api/...`. Image/resource URLs use the typed API-base helper instead of a root `/api` referer fallback. The daemon intentionally does not route root `/api/*` by client-controlled headers.

| Surface | Final state | Final check |
| --- | --- | --- |
| Plan editor app | Root fetch calls are session-scoped by daemon injection; `api.ts` helper exists for follow-on direct migration. | [x] |
| Review editor app | Root fetch calls are session-scoped by daemon injection; route tests prove session API rewrite. | [x] |
| Shared hooks | Fetch/EventSource calls are session-scoped by daemon injection. | [x] |
| Image/upload helpers | Fetch upload is rewritten; image URLs use `apiPath()` through `getImageSrc()` and resolve to `/s/<id>/api/image` in daemon sessions. | [x] |
| SSE/EventSource | EventSource constructor is rewritten by daemon injection. | [x] |
| Plan-agent instructions | Uses `getApiOriginAndBase()` and emits session API base URLs. | [x] |

## Remote Mode Inventory

| Area | Final state | Final check |
| --- | --- | --- |
| Detection | Daemon startup uses existing `PLANNOTATOR_REMOTE` / SSH detection. | [x] |
| Port | Local defaults to random, remote defaults to `19432`, explicit `PLANNOTATOR_PORT` is honored. | [x] |
| Hostname | Local binds `127.0.0.1`, remote binds `0.0.0.0`. | [x] |
| Mismatch | Client rejects local/remote or explicit port mismatch with stop/retry instruction. | [x] |
| Browser URL | Session-scoped daemon URL. | [x] |
| Browser fallback | Existing fallback receives session URL. | [x] |
| Share links | Plan/annotate remote content share link generation moved into session factory; review remote fallback uses the reachable daemon session URL. | [x] |

## OpenCode Compatibility Inventory

| Flow | Final state | Final check |
| --- | --- | --- |
| Binary discovery | Unchanged. | [x] |
| `submit_plan` | Same public binary command behavior, daemon-backed. | [x] |
| `/plannotator-review` | Same public behavior. | [x] |
| `/plannotator-annotate` | Same public behavior. | [x] |
| `/plannotator-last` | Same public behavior. | [x] |
| `/plannotator-archive` | Same public behavior. | [x] |
| Agent list bridge | Live SDK object is not moved into daemon; current `/api/agents` safely returns empty without an in-process OpenCode client. Serializable snapshots remain a follow-on if the UI needs richer daemon agent data. | [x] |

## Pi Compatibility Inventory

| Flow | Final state | Final check |
| --- | --- | --- |
| Binary discovery | Unchanged; vendored helpers updated by typecheck/build. | [x] |
| Plan mode | Same public plugin command behavior, daemon-backed. | [x] |
| Non-UI fallback | Unchanged in Pi plugin. | [x] |
| Code review | Same async binary command behavior. | [x] |
| Annotation | Pi still prepares content locally and calls binary. | [x] |
| Last message | Unchanged host-side capture behavior. | [x] |
| Archive | Same behavior. | [x] |
| Event channel | Existing event channel compatibility unchanged. | [x] |

## Cleanup Inventory

| Resource | Final state | Final check |
| --- | --- | --- |
| PR worktrees | Cleanup callback is owned by review session disposal. | [x] |
| Review agent jobs | `dispose()` kills all review agent jobs. | [x] |
| AI sessions/providers | `dispose()` disposes AI session manager and provider registry. | [x] |
| External annotation streams | Session-scoped handlers; SSE idle timeout is delegated through session handler context. | [x] |
| Drafts | Existing content-hash behavior unchanged; deleted on submit/exit/approve. | [x] |
| Waiters | Store waiters resolve on complete/cancel/expire/shutdown and reject on delete. | [x] |
| TTL | Request timeout-aligned TTL, 96h default, disabled TTL when caller timeout is disabled, plus runtime periodic cleanup. | [x] |

## Build, Package, CI Inventory

| Area | Final state | Final check |
| --- | --- | --- |
| Hook binary build | `bun run build:hook` passes with daemon modules included. | [x] |
| OpenCode package | Thin plugin client remains; `bun run build:opencode` passes. | [x] |
| Pi package | Thin binary client remains; `bun run build:pi` passes. | [x] |
| Root typecheck | `bun run typecheck` passes and runs Pi vendor script. | [x] |
| Tests | `bun test` passes with daemon tests included. | [x] |

## Final Closure Evidence

- [x] `bun run test` passed after review fixes: 1255 pass, 0 fail.
- [x] Focused daemon/plugin/Jina/Pi tests passed after review fixes: 39 pass, 0 fail.
- [x] `bun run typecheck` passed.
- [x] `bun run build:review` passed.
- [x] `bun run build:hook` passed.
- [x] `bun run build:opencode` passed.
- [x] `bun run build:pi` passed.
- [x] Runtime docs updated in `docs/single-binary-runtime.md`, `apps/hook/README.md`, `apps/opencode-plugin/README.md`, and `apps/pi-extension/README.md`.
- [x] Daemon-backed plugin smoke passed from empty temp `HOME`: `plugin plan` auto-started daemon, returned `session.url` under `/s/<id>`, approved over `/s/<id>/api/approve`, and emitted plugin success JSON.
- [x] Concurrent daemon-backed plugin smoke passed: OpenCode and Pi plan requests shared one daemon endpoint and completed through distinct `/s/<id>` sessions.
- [x] Remote fixed-port lifecycle smoke passed: `PLANNOTATOR_REMOTE=1`, `PLANNOTATOR_PORT=19876`, bind host `0.0.0.0`, status OK, stop OK.
- [x] Stacked PR created: https://github.com/backnotprop/plannotator/pull/734 with base `feat/single-server-runtime`.
- [x] Code-search evidence: `rg "startPlannotatorServer|startReviewServer|startAnnotateServer|registerSession|unregisterSession" apps/hook/server packages/server/daemon` returns only compatibility wrapper definitions outside the hook CLI path.
- [x] Route/API evidence: `server.test.ts` covers `/s/:id/api/*`, rejects root `/api/*` referer spoofing, JSON-content guards for simple POST management routes, cancellation, result idle-timeout handling, and status active/total counts.
- [x] Remote-mode evidence: `remote.test.ts` plus daemon client mismatch tests cover local default, remote mode, explicit ports, and mismatch errors.
- [x] OpenCode and Pi compatibility evidence: existing OpenCode/Pi binary-client and packaging tests pass.
- [x] Cleanup evidence: `session-store.test.ts`, `runtime.test.ts`, and `createReviewSession().dispose()` cover waiters, cancellation, TTL, shutdown, agent jobs, AI registries, and PR cleanup callback ownership.

## Residual Risks

- Broad UI call-site migration to `apiFetch`/`apiEventSource` is intentionally deferred. The daemon bridge is tested and works, but direct helper adoption would reduce reliance on monkey-patching.
- Manual SSH/devcontainer smoke is still recommended before release because automated coverage verifies remote-mode decisions, fixed-port lifecycle, and URL formatting, not a real forwarded browser workflow.
- High-concurrency human browser smoke with many live sessions is still useful even though two-session plugin smoke plus route/store isolation are covered.
