# Session Lifecycle — Plan

## Approach

Six workstreams, ordered by dependency. Each builds on the previous. The daemon becomes the orchestrator for session presentation — it decides open vs notify based on frontend state. The CLI becomes a thin sender. Session content persists to disk so completed sessions survive refresh and restart.

---

## Step 1: Frontend visibility and focus reporting

The daemon needs to know: is a frontend connected, is the tab visible, and what session is the user on.

**Files:**
- `packages/shared/daemon-protocol.ts` — add client message types: `{ type: "visibility", visible: boolean }` and `{ type: "focus", sessionId: string | null }`
- `packages/server/daemon/event-hub.ts` — handle new message types, track per-connection state
- `apps/frontend/src/daemon/events/event-stream.ts` — send visibility changes via `document.visibilitychange` listener, send focus changes on route navigation

**Verification:**
- Unit test: event hub tracks visibility per connection
- Manual: daemon logs show visibility/focus changes as you switch tabs and navigate

---

## Step 2: Move browser opening from CLI to daemon

The daemon decides what to do when a session is created. The CLI stops calling `openBrowser()`.

**Files:**
- `packages/server/daemon/session-factory.ts` — after `context.store.create()`, call a new `presentSession()` function that checks frontend connections and decides: `openBrowser()`, `notify`, or `openBrowser()` (backgrounded tab)
- `packages/server/daemon/server.ts` — add `browserAction` field to the `POST /daemon/sessions` response
- `packages/shared/daemon-protocol.ts` — add `browserAction: "opened" | "notified"` to `DaemonSessionSummary`
- `apps/hook/server/index.ts` — remove `handleServerReady()`, `handleReviewServerReady()`, `handleAnnotateServerReady()` calls from `runDaemonSessionRequest()` (lines 712-718). Remove the `openBrowser()` call in the sessions command (line 878).
- `packages/server/daemon/event-hub.ts` — add `hasFrontendClient()` and `getFrontendVisibility()` methods

**Verification:**
- With no frontend open: CLI triggers plan → browser opens
- With frontend visible on landing: CLI triggers plan → toast appears, no new tab
- With frontend visible on active session: CLI triggers plan → toast appears
- With frontend tab backgrounded: CLI triggers plan → new tab opens, Chrome comes to front

---

## Step 3: Session notification toast

The frontend receives `session-created` events (already wired) and shows a toast when the daemon chose to notify instead of opening a browser.

**Files:**
- `packages/shared/daemon-protocol.ts` — add a `presentationAction` field to `session-created` events: `"opened" | "notified"`
- `apps/frontend/src/daemon/events/event-store.ts` — on `session-created` with `presentationAction: "notified"`, trigger a toast
- `apps/frontend/src/daemon/events/event-stream.ts` — check `document.hidden` before showing toast. If hidden, queue and show on `visibilitychange`
- Toast component — auto-dismiss 5-10s, shows mode icon + project name + "Open" button that navigates to `/s/:id`

**Verification:**
- Toast appears when a session is created while frontend is visible and active
- Toast includes session mode, project, and clickable action
- Toast auto-dismisses
- Queued toasts show when tab regains focus

---

## Step 4: Sidebar session persistence

Completed sessions stay in the sidebar with status badges instead of disappearing.

**Files:**
- `apps/frontend/src/daemon/events/event-store.ts` — remove the splice on terminal status (line 62-64). Instead, update the session in-place with the new status.
- `apps/frontend/src/components/sidebar/AppSidebar.tsx` — render completed sessions with visual distinction: muted text, status badge (checkmark for approved, x-circle for denied), grouped below active sessions or inline with a visual separator

**Verification:**
- Approve a plan → session stays in sidebar with approved badge
- Deny a plan → session stays with denied badge
- Active sessions are visually distinct from completed ones
- Clicking a completed session navigates to it and shows the banner + content

---

## Step 5: Session content caching (disk-backed)

Completed sessions serve read-only content from disk. Survives page refresh and daemon restart.

**Files:**
- `packages/server/daemon/session-store.ts` — before `releaseRoutingPayloads()` in `disposeRecord()`, snapshot the session content:
  - For plan sessions: plan markdown, annotations, version info
  - For review sessions: raw patch, git ref, diff metadata
  - For annotate sessions: markdown content, file path, source info
  - Write snapshot to `~/.plannotator/sessions/<id>.json`
- `packages/server/daemon/server.ts` — when a request hits `/s/:id/api/...` and the session handler is disposed, check for a snapshot on disk. Serve read-only responses from it.
- `packages/server/daemon/session-store.ts` — on daemon startup, scan `~/.plannotator/sessions/` to populate the session list with completed records (so they show in the sidebar)

**Verification:**
- Approve a plan → refresh the page → plan content still loads
- Restart daemon → navigate to `/s/:id` → plan content loads from disk
- Sidebar shows sessions from previous daemon runs

---

## Step 6: Legacy tab mode

Config toggle for users who prefer tab-per-session with auto-close.

**Files:**
- `packages/shared/config.ts` — add `legacyTabMode?: boolean` to `PlannotatorConfig`
- `packages/server/daemon/session-factory.ts` — in `presentSession()`, if `legacyTabMode` is enabled, always call `openBrowser()` regardless of frontend state
- `packages/plannotator-plan-review/App.tsx` and `packages/plannotator-code-review/App.tsx` — read legacy mode from daemon config (served via `/api/plan` or `/api/diff` response). When active, render `CompletionOverlay` instead of `CompletionBanner`, even in embedded mode.

**Verification:**
- Set `legacyTabMode: true` in `~/.plannotator/config.json`
- CLI triggers plan → new browser tab opens (even if frontend is connected elsewhere)
- Approve → full-screen overlay appears with auto-close countdown
- Tab closes (or shows "close manually" fallback)

---

## Step 7: Sidebar collapsed on direct session links

Direct `/s/:id` links start with the sidebar collapsed.

**Files:**
- `apps/frontend/src/app/Layout.tsx` — detect if the initial route is a session route. If so, initialize sidebar as collapsed.

**Verification:**
- Navigate to `localhost:PORT/s/:id` directly → sidebar is collapsed, session fills the screen
- Navigate to `localhost:PORT/` → sidebar is open as normal
- Opening sidebar manually works, persists for the rest of the session

---

## Risks

- **Disk I/O on every session completion**: Writing snapshots to disk adds latency. Mitigation: async write, don't block the completion response.
- **Snapshot format stability**: If the frontend evolves, old snapshots may not render correctly. Mitigation: include a version field in the snapshot format.
- **WebSocket race on session creation**: The daemon may try to notify before the frontend has processed a previous navigate. Mitigation: frontend deduplicates by session ID.
- **Review session snapshots are large**: A full git diff can be significant. Mitigation: only cache the metadata needed to re-render, not the full patch. Or accept the size for now and optimize later.
- **Legacy mode + auto-close in embedded app**: `window.close()` in the production frontend would close the entire app, not just a tab. Mitigation: legacy mode must ensure each session is in its own tab (daemon always calls `openBrowser`), so `window.close()` only closes that tab.
