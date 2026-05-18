# Long-Running Plannotator Daemon Runtime Plan

## Solution Approach

Implement this as a stacked PR on top of the current single-binary-runtime work. Create the implementation branch from `feat/single-server-runtime` and open the PR with base `feat/single-server-runtime` / PR #733, not `main`.

The daemon becomes the single authoritative Plannotator process for daemon-backed sessions. CLI and plugin commands become daemon clients: they still do bootstrap/help/version/lifecycle work locally, but plan/review/annotate/archive sessions are created inside the daemon and routed through one shared endpoint. The implementation should preserve current command behavior while changing the runtime ownership underneath.

The main technical shape is:

- one daemon process with one HTTP endpoint
- a daemon state file/lock under `~/.plannotator/` for discovery and single-daemon ownership
- daemon management routes for capabilities, status, sessions, result waiting, cancellation, and shutdown
- session-scoped browser URLs such as `/s/<sessionId>/...`
- session-scoped API routing such as `/s/<sessionId>/api/...`
- extracted plan/review/annotate session handlers that can run inside either the daemon router or compatibility wrappers
- a UI API-base helper so existing browser apps stop hardcoding root `/api/...`
- explicit remote-mode handling for fixed/forwardable daemon endpoints

## Stacked PR Requirements

This daemon runtime work must be a stacked PR. The implementation branch is `feat/plannotator-daemon-runtime`, created from the current phase-one branch `feat/single-server-runtime`. The daemon PR must target `feat/single-server-runtime` / PR #733 as its base, not `main`.

Do not mix unrelated phase-one fixes into the daemon branch. If phase one changes after this branch is created, update the stack by rebasing or merging `feat/single-server-runtime` into `feat/plannotator-daemon-runtime`, then keep the daemon PR base pointed at `feat/single-server-runtime`.

## Ordered Steps

1. Create the stacked work branch and protect the phase-one PR boundary.

   Touches: git only.

   Start from the current branch:

   ```bash
   git switch feat/single-server-runtime
   git pull --ff-only
   git switch -c feat/plannotator-daemon-runtime
   ```

   The later PR should target `feat/single-server-runtime`, so review can happen as a stack: phase one first, daemon runtime second.

   Verification: `git rev-list --left-right --count HEAD...origin/feat/single-server-runtime` is `0 0` before new daemon commits, and the PR base is not `main`.

2. Define daemon protocol and daemon process ownership primitives.

   Touches: new `packages/shared/daemon-protocol.ts`, new `packages/server/daemon/state.ts`, new `packages/server/daemon/state.test.ts`, `packages/shared/package.json`, `packages/server/package.json`.

   Add versioned daemon protocol types for:

   - daemon capabilities
   - daemon status
   - session create requests
   - session summaries
   - blocking result waits
   - async session creation responses
   - cancellation and shutdown responses
   - clear error codes for stale, unhealthy, incompatible, locked, and unreachable daemon states

   Add daemon state handling under `~/.plannotator/daemon.json` plus a lock file. The state should include PID, port, hostname/bind mode, protocol version, binary/version identity, startedAt, and remote-mode settings. Treat stale or dead PIDs as recoverable. Treat incompatible live daemons as actionable errors unless a safe stop/restart path is explicit. Management-route hardening is intentionally simple for this goal: reject browser-simple mutation requests with JSON content-type checks instead of adding bearer-token auth.

   Verification: unit tests cover state read/write, stale PID cleanup, malformed state cleanup, lock acquisition failure, compatible daemon detection, and incompatible daemon detection.

3. Extract session handlers from request-scoped server wrappers.

   Touches: `packages/server/index.ts`, `packages/server/review.ts`, `packages/server/annotate.ts`, likely new `packages/server/daemon/session.ts` and `packages/server/daemon/session-store.ts`.

   Today `startPlannotatorServer()`, `startReviewServer()`, and `startAnnotateServer()` each create session state and call `Bun.serve()` directly. Split those files so each surface can create a session object without binding a port:

   - `createPlanSession(options)`
   - `createReviewSession(options)`
   - `createAnnotateSession(options)`

   Each session object should expose:

   - `id`
   - `mode`
   - `project`
   - `label`
   - `createdAt` / `lastAccessedAt`
   - `htmlContent`
   - `handleRequest(req, url)` for the existing API routes after path stripping
   - `waitForResult()`
   - `cancel(reason)`
   - `dispose()`

   Keep compatibility wrappers for `startPlannotatorServer`, `startReviewServer`, and `startAnnotateServer` while the CLI is being migrated. Those wrappers can create one session and serve it with the same router used by the daemon. This keeps tests and direct imports from breaking during the refactor.

   The daemon runtime owns cleanup for everything attached to a session. Review agent jobs, AI sessions, PR worktrees, external annotation streams, and draft cleanup need explicit session-level disposal paths because the daemon process itself will keep running after any individual browser session ends.

   Verification: existing plan/review/annotate server tests still pass; new unit tests can instantiate two sessions of the same mode and confirm separate result promises and cleanup callbacks.

4. Add session-scoped browser/API routing and UI API-base support.

   Touches: new `packages/ui/utils/api.ts`, high-risk resource URL call sites, and server HTML response injection in the new daemon router.

   The current apps hardcode root paths like `/api/plan`, `/api/diff`, `/api/upload`, `/api/external-annotations/stream`, and `/api/image`. A daemon cannot safely support concurrent sessions with root API routes. Add a shared browser helper that resolves API URLs from a runtime base:

   - default base: `/api` for existing dev/standalone compatibility
   - daemon session base: `/s/<sessionId>/api`

   The daemon should inject the API base before the app bundle runs, for example by defining a small `window.__PLANNOTATOR_API_BASE__` script in the HTML response. Fetch and EventSource calls can be bridged by daemon injection while the UI gradually moves to helpers; non-fetch resource URLs such as images should use the helper immediately so daemon sessions do not depend on root `/api` fallback routes.

   Update plan-agent instructions and external annotation copy text so agents receive the session-scoped API base, not just `window.location.origin`.

   Verification: unit tests for the API-base helper; daemon route tests proving root `/api/*` requests are not routed by spoofable headers; image helper tests proving local image URLs resolve through `/s/<id>/api/image`; browser smoke for plan and review should show all API calls going to `/s/<id>/api/...`.

5. Implement the daemon HTTP server and session store.

   Touches: new `packages/server/daemon/server.ts`, new `packages/server/daemon/client.ts`, new daemon exports in `packages/server/package.json`.

   Implement one `Bun.serve()` process using existing remote helpers:

   - local mode binds loopback and uses a persisted random port unless `PLANNOTATOR_PORT` is set
   - remote mode binds `0.0.0.0` and uses `PLANNOTATOR_PORT` or default `19432`
   - status reports whether the daemon was started in remote mode and which endpoint clients should use

   Add daemon routes:

   - `GET /daemon/capabilities`
   - `GET /daemon/status`
   - `GET /daemon/sessions`
   - `POST /daemon/sessions`
   - `GET /daemon/sessions/:id`
   - `GET /daemon/sessions/:id/result` with blocking/long-poll behavior
   - `POST /daemon/sessions/:id/cancel`
   - `DELETE /daemon/sessions/:id`
   - `POST /daemon/shutdown`
   - `GET /s/:id` and `GET /s/:id/*` for the session HTML
   - `/s/:id/api/*` routed to that session's `handleRequest`

   Management mutation routes require `Content-Type: application/json` so ordinary browser simple POSTs cannot drive shutdown/cancel/session creation. This goal intentionally does not add bearer-token auth; session browser routes use opaque session IDs as bearer-style URLs, matching the current "URL grants access" model.

   Add TTL cleanup for abandoned sessions. TTL should dispose session resources and resolve/cancel waiters with a stable cancellation result.

   Verification: route tests create concurrent plan/review/annotate sessions and prove API calls route to the right session; management mutation routes reject non-JSON simple POSTs; cancellation resolves waiters; TTL cleanup removes sessions; active session count updates in status.

6. Move CLI and plugin command surfaces onto the daemon client.

   Touches: `apps/hook/server/index.ts`, `apps/hook/server/cli.ts`, new or updated `apps/hook/server/daemon-client.ts`, `packages/shared/plugin-protocol.ts`, OpenCode/Pi binary-client tests if response shape changes.

   Refactor the monolithic CLI into smaller command handlers that create daemon session requests. `--help`, `--version`, `daemon start`, `daemon status`, and `daemon stop` can run directly. Daemon-backed commands should connect to the daemon:

   - default Claude/Gemini/Codex/Copilot plan hooks
   - `plannotator review`
   - `plannotator annotate`
   - `plannotator last` / `annotate-last`
   - `plannotator archive`
   - `plannotator sessions`
   - `plannotator plugin plan/review/annotate/archive`

   Preserve existing stdout/stderr contracts. Blocking callers like Claude Code hook decisions should create a session and wait for the result. OpenCode and Pi plugin calls can continue using the current `plannotator plugin ...` JSON shape, but under the hood those commands should create daemon sessions and wait or long-poll through the daemon client rather than starting request-scoped servers.

   For asynchronous OpenCode/Pi behavior, make sure the daemon API supports session creation and later result retrieval even if the current plugin command wrappers still wait in a background subprocess. This preserves current behavior while enabling a later dumb-client transport swap.

   Verification: CLI tests for daemon start/status/stop, plugin capabilities reporting `multiSessionDaemon: true`, plugin command JSON compatibility, and hook stdout compatibility.

7. Preserve remote-mode behavior deliberately.

   Touches: `packages/server/remote.ts`, daemon state/client files, `packages/server/browser.ts` only if needed, docs.

   Remote mode must not be accidental. Plan and implement these rules:

   - daemon startup records whether it is remote or local
   - remote daemon uses `PLANNOTATOR_PORT` or default `19432`
   - local daemon may use a persisted random port
   - clients compare their desired remote/port settings to the running daemon's status
   - incompatible remote/local or port mismatches produce a clear stop/restart instruction instead of silently starting another daemon
   - session URLs returned to callers use the shared daemon endpoint and session path
   - browser-open fallback and VS Code IPC still receive session-scoped URLs
   - remote share-link generation still works for plan/review/annotate content

   Verification: extend `packages/server/remote.test.ts` or add daemon remote tests for local random port, remote fixed port, explicit port override, invalid port fallback, config mismatch errors, and reachable session URL formatting.

8. Update session discovery from file registry to daemon authority.

   Touches: `packages/server/sessions.ts`, daemon status/session routes, `apps/hook/server/index.ts`, `apps/hook/server/cli.ts`.

   The current `packages/server/sessions.ts` registry stores one JSON file per request-scoped process PID. Under the daemon, sessions should be listed from the daemon's in-memory registry. Keep `plannotator sessions --open [N]` but have it query the daemon. `--clean` should trigger TTL/stale cleanup rather than scanning per-process session files.

   Decide whether to keep a compatibility file for external tools. If kept, it should represent the daemon process and/or active sessions from daemon state, not one file per short-lived server.

   Verification: `plannotator sessions` lists multiple live daemon sessions; `sessions --open 1` opens the session-scoped URL; stale compatibility files do not create fake sessions.

9. Preserve OpenCode/Pi compatibility without broad dumb-client cleanup.

   Touches: `apps/opencode-plugin/binary-client.ts`, `apps/pi-extension/binary-client.ts`, `apps/opencode-plugin/commands.ts`, `apps/pi-extension/plannotator-browser.ts`, maybe shared protocol types.

   Do not take on Pi `vendor.sh` removal or broad prompt-formatting cleanup in this goal. The narrow compatibility work is:

   - plugin binary clients still call the same `plannotator plugin ...` commands
   - returned JSON remains parseable by existing clients
   - session metadata includes daemon session ID and URL when useful
   - OpenCode/Pi asynchronous host behavior remains intact

   Clarify the OpenCode SDK boundary: before phase one, the OpenCode plugin could pass a live OpenCode SDK client directly into an in-process Plannotator server. A daemon is a separate process, so it cannot hold or call that live SDK object. If a daemon session needs OpenCode-specific data for `/api/agents` or agent switching UI, the OpenCode plugin should pass a serializable snapshot such as `{ id, name, description }[]` with the session request. The daemon stores that snapshot on the session and serves it through `/api/agents`.

   Verification: existing OpenCode and Pi tests pass; add tests proving plugin clients still parse daemon-backed responses and do not require public command changes.

10. Add a daemon migration inventory and final fact-by-fact closure pass.

   Touches: new `goals/plannotator-daemon-runtime/functionality-inventory.md`, `goals/plannotator-daemon-runtime/facts.md`, `goals/plannotator-daemon-runtime/facts.meta.json`, completion notes.

   Reuse the phase-one migration discipline. Before implementation, create an inventory that covers:

   - every accepted daemon fact
   - current CLI entrypoints and stdout/stderr contracts
   - plugin protocol commands and response shapes
   - plan/review/annotate/archive API surfaces
   - session discovery and `plannotator sessions`
   - remote-mode port/browser/share behavior
   - OpenCode and Pi compatibility flows
   - cleanup responsibilities for PR worktrees, agent jobs, AI sessions, SSE streams, drafts, and abandoned waiters
   - packaging/build/CI/release expectations

   At completion, update the inventory with proof for each item. Every accepted fact should have a concrete automated or manual verification note. Any uncovered item must be called out as a residual risk or blocker before the goal is marked done.

   Verification: `functionality-inventory.md` exists before implementation starts, is checked off at completion, and includes command output or code-search evidence for every automated fact.

11. Document the daemon runtime and update operational guidance.

   Touches: `docs/single-binary-runtime.md`, `apps/hook/README.md`, `apps/opencode-plugin/README.md`, `apps/pi-extension/README.md`.

   Document:

   - single normal daemon per user/machine environment
   - lifecycle commands
   - auto-start and reuse behavior
   - local vs remote binding/port rules
   - stale/unhealthy daemon recovery
   - session URLs and session IDs
   - blocking vs async caller behavior
   - out-of-scope client simplification

   Verification: docs mention `PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT`, daemon status/stop/start, and stacked/follow-on relationship to the single-binary-runtime PR.

## Verification Matrix

- `bun test packages/server/remote.test.ts`
- new daemon protocol/state/client/server tests
- new session extraction tests for plan/review/annotate
- UI API-base helper tests
- focused grep/lint test for hardcoded root `/api/` calls in runtime UI code
- `bun test apps/hook/server/cli.test.ts`
- `bun test apps/opencode-plugin`
- `bun test apps/pi-extension`
- `bun test tests/parity`
- `bun run typecheck`
- `bun run build:review`
- `bun run build:hook`
- `bun run build:opencode`
- `bun run build:pi`
- `goals/plannotator-daemon-runtime/functionality-inventory.md` exists and is checked off at completion.
- Every accepted fact in `goals/plannotator-daemon-runtime/facts.md` has an explicit verification note.
- Manual or automated smoke: two concurrent plan sessions, one review session plus one annotate session, remote-mode fixed-port session URL, `plannotator daemon status`, `plannotator sessions --open 1`, and stale daemon recovery.

## Risks And Open Questions

- UI API scoping is the biggest blast radius because root `/api/...` paths are spread across editor, review-editor, and shared UI packages. The API-base helper should be introduced early and verified with grep/tests before daemon routing is trusted.
- Remote mode changes from "fixed port per request-scoped server" to "fixed port for the daemon." This is the right direction, but it means a daemon started with the wrong remote/port environment must be detected clearly.
- The daemon runtime is responsible for session cleanup. The risk is not whether cleanup belongs to the daemon; it does. The risk is finding every process-lifetime assumption in the current request-scoped code and moving it to session disposal.
- A single daemon per user/machine environment is straightforward locally, but shared machines, containers, and SSH sessions can blur "machine." The state directory and env-derived endpoint rules should define this explicitly.
- OpenCode's live SDK client cannot be stored inside the daemon because the daemon is a separate process. For daemon sessions that need OpenCode agent data, pass serializable snapshots from the plugin request rather than trying to share the SDK object.
