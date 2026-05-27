# Initial View — Implementation Plan

## Approach

Two tracks in sequence: daemon changes first (project registry + cwd exposure), then frontend (landing page + sidebar + command palette). The daemon work is small and self-contained. The frontend work is the bulk.

---

## Step 1: Project Registry (Daemon)

**New file:** `packages/server/daemon/project-registry.ts`

Functions: `readProjectRegistry`, `writeProjectRegistry`, `registerProject` (upsert by name), `removeProject`, `listProjects` (sorted by lastSeen desc). Persists to `~/.plannotator/projects.json`. Follows the same read/write patterns as `state.ts` but in its own file — different concerns (mutable, not security-sensitive).

**Changes:**

| File | Change |
|------|--------|
| `packages/shared/daemon-protocol.ts` | Add `cwd?: string` to `DaemonSessionSummary`. Add `DaemonProjectEntry` and `DaemonProjectListResponse` types. Add `"project-registry"` to `PLANNOTATOR_DAEMON_FEATURES`. |
| `packages/server/daemon/session-store.ts` | Add `cwd?: string` to `DaemonSessionRecord` and `CreateDaemonSessionInput`. Include `cwd` in `summary()` output. |
| `packages/server/daemon/session-factory.ts` | Pass `cwd` to each `store.create()` call. Call `registerProject(project, cwd)` after project name detection (~line 491). |
| `packages/server/daemon/server.ts` | Add 3 routes: `GET /daemon/projects`, `POST /daemon/projects`, `DELETE /daemon/projects/:name`. All behind existing daemon auth guard. POST validates `cwd` path exists on disk and detects name from git if not provided. |

**Verification:** Unit tests for `project-registry.ts` — read/write/upsert/remove/list with a temp directory. Integration test: create a session, verify project appears in `GET /daemon/projects`. Typecheck passes.

---

## Step 2: Frontend Dependencies

Add Radix primitives needed by shadcn components:

```
@radix-ui/react-dialog
@radix-ui/react-dropdown-menu
@radix-ui/react-tooltip
@radix-ui/react-separator
@radix-ui/react-collapsible
cmdk
```

`@radix-ui/react-slot` is already installed.

**Verification:** `bun install` succeeds, typecheck passes.

---

## Step 3: shadcn Primitives

Vendor these into `apps/frontend/src/components/ui/`, adapted from diffkit's implementations to use Plannotator's token names:

- `button.tsx` — cards, dialog actions, sidebar items
- `card.tsx` — project cards on landing page
- `dialog.tsx` — add project modal
- `dropdown-menu.tsx` — [+] quick action dropdown
- `input.tsx` + `label.tsx` — add project form
- `sidebar.tsx` — full sidebar primitive (SidebarProvider, Sidebar, SidebarContent, SidebarGroup, SidebarMenu, etc.)
- `tooltip.tsx` — sidebar icon tooltips
- `command.tsx` — command palette base (wraps cmdk)
- `badge.tsx` — session count badges
- `separator.tsx` — section dividers
- `skeleton.tsx` — loading states

**Verification:** Each component imports cleanly, typecheck passes, oxlint clean. No runtime test yet — these are primitives.

---

## Step 4: Stores

**New store:** `src/features/projects/project-store.ts`

Zustand + Immer. State: `projects: DaemonProjectEntry[]`, `loading: boolean`. Actions: `setProjects`, `addProject` (calls `POST /daemon/projects` then refetches), `removeProject` (calls `DELETE` then refetches), `fetchProjects` (calls `GET /daemon/projects`). This store is API-backed, not localStorage.

**New store:** `src/features/projects/recently-done-store.ts`

Zustand + Immer + `persist` middleware (localStorage, key `plannotator-recently-done`). State: `entries: RecentlyDoneEntry[]`. Actions: `addEntry` (prepend, cap at 20), `clear`. Populated by watching the daemon event store for terminal session events.

**Extend:** `src/daemon/contracts.ts` — add `DaemonProjectEntry`, `ProjectListResponse`, and project-related API types.

**Extend:** `src/daemon/api/client.ts` — add `listProjects()`, `addProject(cwd, name?)`, `removeProject(name)` methods to `DaemonApiClient`.

**Verification:** Unit tests for both stores (create, read, remove, cap behavior). Typecheck passes.

---

## Step 5: Layout + Sidebar Shell

**Prototype reference:** `~/oss/diffkit/apps/goal-prototype/src/main.tsx` (lines 198–302) — the `AppSidebar` component, `SidebarProvider` setup with `collapsible="offcanvas"`, session grouping pattern, `Cmd+B` toggle, and `Cmd+1-9` positional jumps. Also reference the HANDOFF.md decisions: offcanvas mode (avoids double-sidebar with browser vertical tabs), internal sidebars independent from session navigation, session type grouping pattern.

**Port from prototype:**
- `SidebarProvider` wrapping pattern with `defaultOpen={false}` and `--sidebar-width` CSS variable
- `useSidebar()` hook usage for toggle
- Session grouping structure (`SidebarGroup` → `SidebarGroupLabel` → `SidebarMenu` → `SidebarMenuItem`)
- Attention dot badge pattern (`SidebarMenuBadge` with colored dot for active, checkmark for completed)
- Footer with theme toggle

**Adapt from prototype:** The prototype groups by session type (Plan Reviews, Code Reviews, etc.). We group by project instead, with sessions of any type listed under their project. The `SESSION_TYPE_META` icon mapping (Target, ListChecks, ScrollText, Code2) transfers directly — we use it per session item, not per group.

**Modify:** `src/app/layout/Layout.tsx` — wrap with `SidebarProvider`. Render `<AppSidebar />` + `<CommandPalette />` alongside `<Outlet />` in a flex container. Add `useEffect` for global `Cmd+B` and `Cmd+K` keyboard bindings.

**New:** `src/features/sidebar/AppSidebar.tsx` — offcanvas sidebar using the shadcn sidebar primitive. Structure:
- Header: Plannotator wordmark
- Content: project groups (from project store), each with sessions (from daemon event store matched by `session.project`), each with `[+]` dropdown
- Recently Done section (from recently-done store)
- Add Project trigger at bottom
- Footer: theme toggle

**New:** `src/features/sidebar/ProjectGroup.tsx` — collapsible group per project. Sessions listed with mode icon + label + status dot. `[+]` dropdown: Code Review, Browse Archive, Remove Project.

**New:** `src/features/sidebar/RecentlyDone.tsx` — renders last 5 recently completed sessions with mode icon, label, project, and time.

**Hook up:** `useDaemonEvents()` in `__root.tsx` or `Layout.tsx` so the WebSocket event stream runs for all routes. Project store fetches on mount.

**Verification:** Sidebar opens/closes with `Cmd+B`. Projects render from daemon API. Sessions appear under correct project. Typecheck + lint clean.

---

## Step 6: Landing Page

**Prototype reference:** Study the DiffKit prototype's visual patterns before building. Key references:
- `~/oss/diffkit/apps/goal-prototype/src/PlanEditor.tsx` — card styling patterns (`rounded-xl border border-border/50 bg-card shadow-xl`), content area layout (`max-w-3xl mx-auto`), action button styling (green approve, ghost secondary)
- `~/oss/diffkit/apps/goal-prototype/src/FactsReview.tsx` — card list layout with hover-revealed actions, `@media(hover:hover)` guard, touch target enlargement via `before:-inset-2`
- `~/oss/diffkit/apps/goal-prototype/src/main.tsx` — the content shell pattern (`isolate flex h-full flex-col bg-muted` → topbar → content card)
- `~/oss/diffkit/apps/goal-prototype/src/styles.css` — card shadow tokens (`--card-ring`, `--card-shadow`), grid pattern for potential empty state background
- HANDOFF.md design principles: no card-in-card nesting, `tabular-nums` on counters, no `transition: all`, body text capped at `max-w-3xl`, `prefers-reduced-motion` support

**Modify:** `src/routes/index.tsx` — loader fetches sessions and projects in parallel. Renders `<LandingPage />`.

**New:** `src/features/landing/LandingPage.tsx` — grid of project cards + add project card at the end. Empty state when no projects.

**New:** `src/features/landing/ProjectCard.tsx` — shows project name, path (truncated), active session count (derived by filtering sessions on `project`), last activity time, quick action buttons. Follow the prototype's card and action button patterns.

**New:** `src/features/landing/AddProjectDialog.tsx` — dialog with path input (required) + name input (optional). On submit calls the project store's `addProject`.

**Quick action wiring:**
- "Code Review" → `POST /daemon/sessions` with `{ request: { action: "review", origin: "plannotator-frontend", cwd: project.cwd } }` → on success, `router.navigate({ to: "/s/$sessionId", params: { sessionId } })`
- "Browse Archive" → same pattern with `action: "archive"`

**Verification:** Landing page renders project cards. Add project flow works end-to-end (dialog → daemon API → card appears). Code Review creates a session and navigates. Browse Archive creates a session and navigates. Loading and error states render correctly. Typecheck + lint + browser test.

---

## Step 7: Command Palette

**New:** `src/features/command-palette/CommandPalette.tsx` — shadcn Dialog wrapping `Command` from cmdk. Sections: Sessions (from event store), Projects (from project store), Actions (Add Project, Toggle Sidebar, Toggle Theme).

**New:** `src/features/command-palette/use-command-palette.ts` — manages open state, query, filtered items. Exposed via context or direct store.

**Wiring:** `Cmd+K` in Layout.tsx opens the palette. Enter on a session navigates to `/s/:id`. Enter on a project scrolls to / focuses that project card. Enter on an action executes it.

**Verification:** `Cmd+K` opens palette. Typing filters. Enter navigates or executes. Escape closes. Typecheck + lint clean.

---

## Step 8: Session Route Polish

**Modify:** `src/routes/s.$sessionId.tsx` — render a minimal session placeholder that shows session mode, project, label, and status. The sidebar is available for switching. Actual session surfaces (plan editor, code review, etc.) are follow-up work.

**Verification:** Navigating to `/s/:id` shows session metadata. Sidebar correctly highlights the active session. Back to `/` works.

---

## Step 9: Final Integration + Tests

- Run full `check` pipeline (typecheck + oxlint + oxfmt + vitest)
- Browser tests: landing page renders, sidebar toggles, add project flow, quick action creates session, command palette opens/closes
- Verify the daemon's existing test suite still passes with the project registry changes
- Verify single-file HTML build succeeds (`vite build` + verify script)

---

## Risks

- **Radix peer dependency conflicts** — Plannotator's existing packages may pin different React/Radix versions. Verify with `bun install` early.
- **shadcn sidebar primitive size** — the full sidebar.tsx from diffkit is large. May need trimming to only the parts we use.
- **Session creation from frontend** — the `origin` field on `PluginRequest` is currently validated as `"opencode"` or `"pi"` for plugin requests and detected from hooks for Claude Code. A frontend-initiated review needs a valid origin. May need to add `"frontend"` as an accepted origin or use a direct daemon session creation path that doesn't go through plugin validation.
- **`cwd` validation on POST /daemon/projects** — need to handle cases where the path doesn't exist or isn't a git repo gracefully.
