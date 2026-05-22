# Frontend Session Lifecycle — Backlog

Tracked issues and feature requests for the daemon frontend app.

---

## 1. ~~Completion overlay blocks the frontend~~ DONE

Fixed in `7d2a626a`. Embedded surfaces now show a `CompletionBanner` (inline bar below the header) instead of the full-screen overlay. Action buttons hide after submission. Standalone mode unchanged.

---

## 2. Tab mode config (open new tabs + auto-close)

**Priority:** Low — may not diverge from default UX at all
**Size:** Small (once #6 is done)

Some users will prefer each session opening in a new browser tab with auto-close after a decision. This is a config toggle, NOT a separate UI — the new frontend always renders.

**Config:** `legacyTabMode: true` (or similar) in `~/.plannotator/config.json`. When set:
- CLI always calls `openBrowser()` for each session (no WebSocket navigate/notify)
- Auto-close behavior uses existing `plannotator-auto-close` cookie mechanism
- Same frontend app, same surfaces, just one-session-per-tab

**Open question:** Once the core session lifecycle (#3, #4, #6) is designed, this might just be a single boolean that skips the "smart open" logic. Deferring until we see how much the UX actually diverges.

---

## 3. Live plan updates across deny/replan cycles

**Priority:** High — most-requested feature
**Size:** Large

When the agent resubmits a plan after denial, the existing session should reactivate in-place rather than spawning a new session.

**Desired behavior:**
- User denies plan, sends feedback, agent replans
- Agent calls ExitPlanMode again — daemon matches it to the existing session
- Session status flips from "completed" back to "active"
- Frontend receives a push notification via WebSocket
- Plan diff system shows what changed between versions
- The plan→deny→replan→approve cycle happens in one persistent session

**Open questions:**
- How does the daemon match a new plan submission to an existing session? By project + plan slug? By a correlation ID from the agent?
- Does the session status reset to "active" on resubmission, or show "updated"?
- How does this interact with the version history system already in `~/.plannotator/history/`?

---

## 4. Session persistence after completion

**Priority:** High — current behavior is broken
**Size:** Medium, tied to #3

**Current bug:** When a session is approved/denied, the daemon disposes the session handler. The session disappears from the sidebar even though the route still resolves. API calls fail, so the plan content is gone.

**Required behavior:**
- Completed sessions stay in the sidebar with a status badge (approved/denied)
- Session content remains viewable (read-only) after a decision
- Sessions do NOT disappear — they move to a "completed" visual state
- If the plan comes back (#3), the session reactivates from this state

**Implementation options:**
- Cache the last plan content before disposal so completed sessions can serve read-only responses
- Or make sessions truly persistent (longer-term, tied to #3)

---

## 5. ~~No browser opens on session creation~~ DONE

Fixed in `99d1aec6`. The daemon now serves the production frontend HTML at `/s/:id`. The CLI's existing `openBrowser()` call opens the daemon URL, which renders the full app. No separate Vite server needed in production.

---

## 6. Smart session opening (daemon-driven)

**Priority:** High — core UX for the new app model
**Size:** Medium

Move browser-opening logic from CLI to daemon. The daemon decides what to do based on frontend connection state.

### Three states

| Frontend state | Daemon action |
|---|---|
| No frontend connected | Call `openBrowser("/s/:id")` — new tab, bootstraps the app |
| Frontend connected, on landing page or idle | Send WebSocket navigate event — same tab switches to the session |
| Frontend connected, user is in an active session | Send WebSocket notify event — toast appears, user clicks when ready |

### Notification rules

- **Toast:** Auto-dismissing (5-10s) with a "Go to plan" button
- **Only show when tab is focused:** Check `document.visibilityState`. If tab is backgrounded, queue the notification and show on return to tab
- **Sidebar badge:** Always update, regardless of tab focus. User sees the count when they look

### What needs building

1. **Daemon tracks frontend connections** — WebSocket hub already knows subscribers. Add a `hasFrontendClient()` check.
2. **Frontend reports active session** — Send `{ type: "focus", sessionId }` on navigation changes. Daemon stores this.
3. **Browser opening moves to daemon** — `POST /daemon/sessions` response includes `{ browserAction: "opened" | "navigated" | "notified" }`. CLI removes its `openBrowser()` call.
4. **New WebSocket event types:**
   - `session-navigate` → frontend does `router.navigate("/s/:id")`
   - `session-notify` → frontend shows auto-dismissing toast with action button
5. **Visibility-gated toasts** — Frontend checks `document.hidden` before showing. Queues if backgrounded.

### What we can't do

- Focus an existing browser tab from the server (OS limitation)
- Prevent `open` command from creating a new tab (but we avoid this by not calling `open` when frontend is connected)
- Know if user is looking at the browser vs another app (but `document.visibilityState` covers tab-level focus)

---

## Sidebar design (open question)

The sidebar session hierarchy needs rethinking. Currently grouped by mode (plan, review, annotate). Might make more sense grouped by project. Completed sessions should be visually distinct but present — not removed.

**Current issues:**
- Sessions disappear from sidebar after completion (broken)
- Mode-based grouping may get chaotic with many sessions
- No visual distinction between active and completed sessions

**Needs design exploration before implementation.** Tied to #3 and #4.

---

## Migrate AddProjectDialog to Radix Dialog primitive

**Priority:** Low — cosmetic consistency
**Size:** Small

The `AddProjectDialog` hand-rolls its own modal with `fixed inset-0 z-50`, manual backdrop click, and manual Escape handling. Once the shadcn Dialog component exists (created for the unified settings dialog), this should be migrated to use it. The search/typeahead content stays the same — just swap the outer modal wrapper. Eliminates having two different modal implementations in the app.
