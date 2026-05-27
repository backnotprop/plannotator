# Session Lifecycle — Facts

## Smart Session Opening

- When a CLI command creates a session, the daemon (not the CLI) decides how to present it to the user.
- If no frontend WebSocket client is connected, the daemon calls `openBrowser()` with the session URL. A new tab opens.
- If a frontend is connected and the tab is visible, the daemon sends a WebSocket notify event. The frontend shows an auto-dismissing toast (5-10 seconds) with the session mode, project name, and a button to go to it. The frontend never auto-navigates — the user always chooses when to switch.
- If a frontend is connected but the tab is not visible (user is in another app), the daemon calls `openBrowser()`. This forces the browser to the foreground with a new tab.
- The frontend reports tab visibility to the daemon over WebSocket using `document.visibilityState`. The daemon tracks this per connection.
- The frontend reports which session is currently active (or null for landing page) over WebSocket when navigation changes. The daemon tracks this per connection.
- If multiple frontend tabs are connected, navigate/notify events are broadcast to all of them.
- The CLI no longer calls `openBrowser()` itself. The `POST /daemon/sessions` response includes a field indicating what the daemon did (`opened`, `navigated`, `notified`).

## First-Open Experience

- Direct session links (`/s/:id`) render with the sidebar collapsed by default.
- The session surface fills the screen. The sidebar is discoverable but not in the way.
- The landing page (`/`) shows the sidebar open as normal.

## Notification Behavior

- Toasts only appear when the frontend tab is focused and the user is in an active session.
- Toasts auto-dismiss after 5-10 seconds.
- Each toast shows the session mode (plan, review, annotate, etc.), the project name, and a clickable action to navigate to it.
- The sidebar always reflects new sessions immediately via WebSocket, regardless of tab visibility or toast state.

## Session Completion

- When a user approves or denies a session, the `CompletionBanner` appears inline (already implemented).
- Action buttons in the header hide after submission (already implemented).
- The session content remains visible and scrollable after a decision. No auto-navigate, no redirect.
- The session stays in the sidebar with a visual status indicator (approved/denied badge). It does NOT disappear.
- Completed sessions in the sidebar are visually distinct from active sessions.

## Session Persistence (Disk-Backed)

- When a session completes, the daemon preserves the session content to disk before disposing the handler.
  - Note: plan history already saves to `~/.plannotator/history/`. This system should be leveraged or modified if needed.
- Completed sessions serve read-only content from disk. The plan/diff/annotation data is available even after the handler is disposed.
- Completed sessions survive page refresh. Navigating to `/s/:id` for a completed session loads the read-only content from disk.
- Completed sessions survive daemon restart. The daemon reads session records and content from disk on startup.

## Mode Parity

- All session modes (plan, review, annotate, archive, goal-setup) follow the same opening, notification, sidebar, and completion flow.
- No mode-specific UX for how sessions appear, are notified, or complete. The only difference is the surface content inside the session.

## Legacy Tab Mode

- A config value in `~/.plannotator/config.json` enables legacy tab mode.
- When legacy mode is enabled, the daemon always calls `openBrowser()` for each new session, regardless of frontend connection state. No navigate/notify events.
- The frontend still renders (it's always the new UI), but each session opens in its own tab.
- The `CompletionOverlay` with auto-close fires in legacy mode (not the inline `CompletionBanner`).
- The existing `plannotator-auto-close` cookie controls the close timing (off, immediate, 3s, 5s).
- Legacy mode is opt-in. The default experience is the smart single-app model.

## Out of Scope

- Session reactivation (agent resubmits plan → session comes back to life). Follow-up goal.
- Historical session browsing (sessions from weeks ago). Follow-up goal — disk persistence here is the foundation.
- Sidebar hierarchy redesign (project-based vs mode-based grouping). Separate design exploration.
- In-app notification permissions or OS-level push notifications.
- First-run tutorial or "what's new" overlay.
