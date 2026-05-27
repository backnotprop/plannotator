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

## ~~3. Live plan updates across deny/replan cycles~~ DONE

Implemented in `feat/session-persistence`. Sessions enter `awaiting-resubmission` status on deny. Agent resubmission is matched by `plan:project:slug` and the session reactivates in place. Frontend receives `session-revision` WebSocket event with updated content.

---

## ~~4. Session persistence after completion~~ DONE

Implemented in `feat/session-persistence`. Denied sessions stay alive (handler not disposed) in `awaiting-resubmission` state with no expiry. Sessions persist until daemon restart.

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

---

## GitLab custom domain detection

**Priority:** Medium
**Size:** Medium

The daemon's PR listing endpoint (`packages/server/daemon/server.ts:671`) determines GitHub vs GitLab by checking `host.toLowerCase().includes("gitlab")`. Self-hosted GitLab instances on custom domains (e.g. `code.company.com`) are misidentified as GitHub, so `gh` is invoked instead of `glab`, and PR listing fails silently.

Needs a more robust detection strategy — either try `glab auth status` first, examine the remote URL structure, or let the user configure platform per-project.

---

## PR stack splitting is order-dependent

**Priority:** Low
**Size:** Medium

The `buildStacks` function in `LandingPage.tsx` walks PR chains by following `baseBranch` links. The algorithm processes PRs in API return order, which means if a middle PR is encountered before its descendants, the chain can be split incorrectly. Multi-PR stacks (3+) may display as loose PRs depending on timing.

Fix: build chains from leaves upward (start with PRs whose head branch isn't anyone else's base), or use a proper topological sort.

---

## GitLab detailed PRs returns empty

**Priority:** Medium
**Size:** Medium

`packages/shared/pr-provider.ts:129` returns an empty array for GitLab in `fetchPRDetailedList()`. The git dashboard shows "No pull requests found" for GitLab repos even when they have open MRs. The `glab mr list --json` command supports the same fields we need — someone just needs to implement `fetchGlMRDetailedList` following the GitHub pattern.

---

## configStore Zustand migration

**Priority:** Medium
**Size:** Medium

The custom `configStore` in `packages/ui/config/configStore.ts` is a hand-rolled pub-sub singleton. It works but doesn't integrate with the Zustand stores used elsewhere in the frontend. Migrating it to Zustand would unify state management and enable selector-based subscriptions instead of the current broadcast-to-all-listeners pattern.

Scoped in `goals/performance/backlog/configstore-zustand-migration.md`.

---

## Global keyboard registry cleanup

**Priority:** Medium
**Size:** Large

10+ raw `window.addEventListener('keydown', ...)` handlers across both app surfaces bypass the keyboard shortcut registry that was built in PR #652. These should be consolidated into the registry for consistent handling, conflict detection, and the help modal.

Scoped in `goals/performance/backlog/global-keyboard-registry.md`.

---

## 14. Daemon starts on install

**Priority:** High — blocks the "CLI is a dumb pipe" architecture
**Size:** Medium

The daemon must be running from the moment Plannotator is installed. Every CLI command assumes the daemon exists and talks to it. No lazy startup on first session creation, no local file fallbacks. If the daemon isn't running, it's a bug in the install — not something the CLI works around.

Currently the daemon starts lazily when the first plan/review/annotate command runs. This means hooks that fire before any session (like `improve-context` on `EnterPlanMode`) have no daemon to talk to and silently lose functionality.

**Scope:**
- Install script (`scripts/install.sh`) runs `plannotator daemon start` after placing the binary
- Plugin activation ensures daemon is running as a safety net
- Daemon auto-restarts if it dies (or at minimum, any binary invocation re-starts it)
