# Agent Simulator End-to-End Runner Plan

## Solution Approach

Build a standalone `apps/agent-simulator` OpenTUI app backed by a testable runner core. The runner will spawn the real Plannotator command, feed fixture-backed stdin/env/files for each supported agent path, observe stdout/stderr/session-ready behavior, verify the daemon state, and complete sessions through the real session APIs where possible.

Add a focused daemon-wide SSE stream so the frontend shell can visibly track session lifecycle and errors while the runner drives scenarios. The browser shell remains a debug/visibility surface, not the simulator itself.

## Current State

- The daemon already supports session create/list/status/result/cancel/shutdown through `packages/server/daemon/server.ts`.
- Session state already lives centrally in `DaemonSessionStore` at `packages/server/daemon/session-store.ts`.
- The daemon already serves the new React shell at `/` and `/s/:sessionId`, and forwards `/s/:sessionId/api/*` to the correct session.
- The frontend shell currently loads daemon data through route loaders and direct fetch calls. It does not receive live daemon events yet.
- The frontend session views are intentionally skeletons. They can be extended with debug JSON panels and small session API buttons without migrating the real UI.
- The process protocol paths already exist in `apps/hook/server/index.ts`: plugin commands, default hook mode, direct CLI review/annotate/archive, Codex, Copilot, and Gemini handling.

## Ordered Steps

### 1. Add Daemon Event Types

Touches:

- `packages/shared/daemon-protocol.ts`
- `packages/shared/daemon-protocol.test.ts`

Add shared daemon event types:

- `snapshot`
- `daemon-status`
- `session-created`
- `session-updated`
- `session-removed`
- `daemon-error`
- optional `heartbeat` or heartbeat comments for SSE keepalive

Each session event should include a `DaemonSessionSummary`. Snapshot should include daemon status plus active sessions so a frontend can recover after reconnecting.

Verification:

- Unit test validates event payload shapes and stable event type names.
- Existing daemon protocol tests continue to pass.

### 2. Emit Session Lifecycle Events From the Store

Touches:

- `packages/server/daemon/session-store.ts`
- `packages/server/daemon/session-store.test.ts`

Add a small subscription API to `DaemonSessionStore`, similar in spirit to the existing external annotations store:

- `onMutation(listener): unsubscribe`
- emit `session-created` in `create`
- emit `session-updated` in `complete`, `fail`, `cancel`, active expiry, and `cancelAll`
- emit `session-removed` in `delete` and terminal cleanup

Keep this local and synchronous. Do not introduce a general app-wide event bus.

Verification:

- Store tests prove create/update/remove events fire once with the expected session summary.
- Existing lifecycle tests still pass.

### 3. Serve a Daemon SSE Stream

Touches:

- `packages/server/daemon/server.ts`
- `packages/server/daemon/server.test.ts`
- `packages/server/daemon/runtime.ts` if cleanup/disposal hooks are needed

Add `GET /daemon/events`:

- disable Bun idle timeout for the stream
- send an initial snapshot event
- forward `DaemonSessionStore` mutation events to subscribers
- send heartbeat comments on an interval
- clean up subscribers on stream cancel

Also emit `daemon-error` events for visible daemon-side failures, especially create-session failures.

Verification:

- Router test opens `/daemon/events`, confirms idle timeout is disabled, reads the snapshot event, creates a session, and reads a `session-created` event.
- Test cancellation removes the subscriber.
- Existing daemon router tests still pass.

### 4. Add Frontend Event and Debug Infrastructure

Touches:

- `apps/frontend/src/daemon/contracts.ts`
- `apps/frontend/src/daemon/api/client.ts`
- new `apps/frontend/src/daemon/events/*`
- `apps/frontend/src/app/state/shell-store.ts` or a new focused debug/event store
- tests under `apps/frontend/src/**`

Add frontend support for:

- building the `/daemon/events` URL
- parsing daemon SSE event payloads
- keeping a bounded event log in Zustand/Immer
- falling back to polling `/daemon/status` and `/daemon/sessions?clean=1` if SSE fails

Do not put simulator controls in the browser. The browser should observe and inspect.

Verification:

- Unit tests for event parsing, store updates, bounded event history, and polling fallback.
- Browser-mode test proves the dashboard can render event JSON and fallback-polled JSON.

### 5. Add Debug Dashboard Panels to the Frontend Shell

Touches:

- `apps/frontend/src/sessions/SessionDashboard.tsx`
- `apps/frontend/src/sessions/SessionRouteView.tsx`
- new components under `apps/frontend/src/daemon/debug/` or `apps/frontend/src/sessions/debug/`
- `apps/frontend/src/styles.css`

Add lightweight debug panels that render:

- daemon status JSON
- active session list JSON
- selected session bootstrap JSON
- recent daemon events JSON
- session links
- per-mode API probe results

Use compact, practical UI: collapsible JSON blocks, status labels, timestamps, and clear error states. Keep this as a diagnostic surface, not a product UI.

Verification:

- Component tests with fixture fetches.
- Browser-mode test for dashboard rendering.
- `bun run --cwd apps/frontend check`

### 6. Add Minimal Session Action Buttons

Touches:

- `apps/frontend/src/daemon/api/client.ts`
- new `apps/frontend/src/sessions/debug/SessionActions.tsx`
- session view skeletons under `apps/frontend/src/{plan,review,annotate,archive}/`

Add small debug action buttons where useful:

- plan: approve, deny
- review: approve/LGTM, send feedback, exit
- annotate: approve, send feedback, exit
- archive: done/close

These buttons should call the real session-scoped APIs:

- `/s/:id/api/approve`
- `/s/:id/api/deny`
- `/s/:id/api/feedback`
- `/s/:id/api/exit`
- `/s/:id/api/done`

Use safe minimal payloads and render the raw JSON response or normalized error.

Verification:

- Unit tests prove each mode sends the correct method/path/payload.
- Browser-mode test proves clicking a debug action records a result.

### 7. Scaffold the OpenTUI Runner App

Touches:

- new `apps/agent-simulator/package.json`
- new `apps/agent-simulator/tsconfig.json`
- new `apps/agent-simulator/src/main.tsx`
- root `package.json`
- `bun.lock`

Create a standalone app using:

- `@opentui/core`
- `@opentui/react`
- `react`
- existing workspace packages where useful

Add scripts:

- root `dev:agent-simulator`
- root `check:agent-simulator`
- app-level `run`, `typecheck`, `test`, and optionally `lint`/`fmt` if practical

Keep the app simple:

- scenario list
- run selected scenario
- run all
- stdout/stderr panes
- daemon/session status pane
- final assertion summary

Verification:

- Typecheck the app.
- Basic renderer/component test if OpenTUI test utilities are practical; otherwise keep UI thin and test the runner core.

### 8. Build Scenario Fixtures and Request Models

Touches:

- `apps/agent-simulator/src/scenarios/*`
- tests under `apps/agent-simulator/src/scenarios/*.test.ts`

Define typed scenarios with:

- id/title/origin/action
- argv
- stdin payload
- env overrides
- temp file setup
- expected session mode
- expected stdout shape
- completion strategy

Cover:

- Claude Code plan hook
- OpenCode plugin plan/review/annotate/archive
- Pi plugin plan/review/annotate/archive
- Codex plan hook
- Copilot plan hook
- Gemini plan-file hook
- direct CLI review/annotate/archive

Fixture defaults:

- use temporary workspaces
- create local markdown files for annotate
- create local git repositories with small diffs for review
- use fixture plan files for Gemini/Copilot/Codex
- avoid network PR URLs by default

Verification:

- Tests assert argv/stdin/env/temp files for every scenario.
- Tests assert every scenario has an expected completion strategy or explicitly documents why it is create-only.

### 9. Implement the Process Runner Core

Touches:

- `apps/agent-simulator/src/process/run-plannotator.ts`
- `apps/agent-simulator/src/process/parse-streams.ts`
- tests under `apps/agent-simulator/src/process/*.test.ts`

Implement child process handling:

- spawn the repo source binary by default (`bin/plannotator.js`), overridable by env/flag
- write stdin exactly once
- stream stdout/stderr into structured log events
- parse `PLANNOTATOR_SESSION_READY`
- enforce scenario timeout
- terminate child on cancel/timeout with SIGTERM then SIGKILL
- preserve final stdout/stderr and exit code

For automated runs, isolate the daemon state with a temporary `HOME` or explicit state base where possible, and suppress real browser opening with a noop browser command. Interactive runs can target the current user daemon if explicitly requested.

Verification:

- Mock child process tests for stdout/stderr/session-ready parsing.
- Timeout/cancel tests.
- Test that partial stderr lines are not lost.

### 10. Implement Daemon Observation and Session Completion

Touches:

- `apps/agent-simulator/src/daemon/*`
- `apps/agent-simulator/src/completion/*`
- tests under those folders

The runner should:

- discover the daemon URL from session-ready output or daemon state
- verify the session exists in `/daemon/sessions`
- optionally subscribe to `/daemon/events`
- complete sessions through the real session-scoped API

Completion strategies:

- plan approve/deny through `/api/approve` or `/api/deny`
- review approve/feedback through `/api/feedback`
- annotate approve/feedback/exit through `/api/approve`, `/api/feedback`, or `/api/exit`
- archive close through `/api/done`

Verification:

- Tests with fixture fetches prove correct API calls.
- At least one real fixture-backed process-to-daemon scenario runs in automated tests and completes the child stdout path.

### 11. Wire the OpenTUI Interface

Touches:

- `apps/agent-simulator/src/ui/*`
- `apps/agent-simulator/src/main.tsx`

The TUI should show:

- scenario list
- command/argv/env summary
- stdin preview
- stdout stream
- stderr stream
- daemon events/session status
- final assertion summary
- clear failure reason

Keyboard controls should be minimal:

- arrow keys to choose scenario
- Enter to run
- `a` to run all
- `c` to cancel current run
- `q` or Ctrl-C to quit

Verification:

- Runner core tests carry most coverage.
- Manual smoke: `bun run --cwd apps/agent-simulator run`, run one plan scenario, confirm session appears in frontend shell.

### 12. Add End-to-End Test Coverage

Touches:

- `apps/agent-simulator/src/**/*.test.ts`
- possibly `packages/server/daemon/*.test.ts`
- root scripts

Required automated coverage:

- all scenario definitions are valid
- process runner handles stdin/stdout/stderr/session-ready
- daemon event stream emits snapshot and session lifecycle events
- frontend dashboard renders event/session JSON and action results
- at least one full process-to-daemon scenario starts a real Plannotator command, creates a daemon session, completes it through the real API, and verifies final stdout

Keep the real full-loop test isolated:

- temporary `HOME`
- temporary repo/workspace
- noop browser command
- short timeout
- cleanup daemon on completion

Verification:

- `bun run --cwd apps/agent-simulator test`
- `bun run --cwd apps/frontend check`
- `bun run --cwd apps/frontend test:browser`
- focused daemon tests
- `bun run typecheck`
- `bun test`

### 13. Document the Tool

Touches:

- `apps/agent-simulator/README.md`
- root `AGENTS.md` and `CLAUDE.md` if the app becomes part of the developer workflow

Document:

- what the runner proves
- what it does not prove
- how to run all scenarios
- how to run a single scenario
- how isolated daemon mode works
- how to open the daemon frontend while the runner is active

Verification:

- README references commands that exist.
- Project structure docs mention the new app.

## Risks and Open Questions

- **Setup-goal source ownership:** the local installed binary supports `setup-goal`, but this checkout has limited source visibility for setup-goal internals. Do not include setup-goal in the first runner scenario set unless source contracts are present.
- **Codex and Gemini fixture fidelity:** these paths depend on file layouts. The plan is to create minimal faithful temp layouts, then keep the fixture builders covered by tests.
- **Browser opener side effects:** automated scenarios must suppress browser opening with a noop browser command and isolated daemon state.
- **Daemon event scope:** keep daemon SSE focused on lifecycle/debug visibility. Do not turn it into a general logging bus.
- **Frontend debug buttons:** action buttons should be explicitly diagnostic and small. They are not the real migrated UI.

## Completion Criteria

- The OpenTUI runner can run fixture-backed scenarios and visibly report command/stdin/stdout/stderr/daemon/session state.
- The daemon exposes a tested SSE stream for session lifecycle visibility.
- The frontend shell shows live or fallback-polled daemon/session/debug JSON and has small diagnostic session action buttons.
- At least one automated full-loop scenario proves real process stdin/stdout through daemon session completion.
- The implementation passes the frontend, daemon, agent-simulator, typecheck, and full test commands listed above.
