# Initial View — Fact Sheet

## Project Registry (Daemon)

- The daemon persists a project registry to `~/.plannotator/projects.json`
- Each project entry stores `name`, `cwd` (absolute path), and `lastSeen` (ISO timestamp)
- When a session is created, the daemon auto-registers the project from the request's `cwd` and detected project name
- If a project with the same name already exists, its `lastSeen` and `cwd` are updated
- `GET /daemon/projects` returns all registered projects sorted by `lastSeen` descending
- (amended: originally said "detects the name from git if not provided") `POST /daemon/projects` adds a project manually (body: `{ name?, cwd }`) — daemon validates the path exists and falls back to the directory name if no name is provided
- `DELETE /daemon/projects/:name` removes a project from the registry
- `DaemonSessionSummary` exposes `cwd` so the frontend knows which directory a session belongs to

## Landing Page (`/`)

- The landing page is the `/` route — shown when no session is selected
- It displays project cards, one per registered project
- Each project card shows: project name, directory path, count of active sessions, and time since last activity
- Each project card has quick action buttons: "Code Review" and "Browse Archive"
- Projects are sorted by most recent activity (matching the API sort order)
- An "Add project" control lets the user register a new project by entering a directory path with an optional name override
- Projects can be removed from the registry via a remove action on each card
- When there are zero projects, the landing page shows an empty state prompting the user to add a project or explaining that projects appear automatically when agents create sessions

## Quick Actions

- "Code Review" immediately creates a review session using the project's `cwd` with default diff settings (merge-base, auto-detected default branch) and navigates to `/s/:newSessionId`
- "Browse Archive" immediately creates an archive session and navigates to `/s/:newSessionId`
- "Annotate File" is not included in this scope
- Session creation calls `POST /daemon/sessions` with the appropriate `PluginRequest`
- While the session is being created, the button shows a loading state
- If session creation fails, a toast notification is shown via sonner

## Sidebar

- The sidebar uses the offcanvas pattern: fully hidden by default, overlays the content when open
- (deferred: `Cmd+B` keyboard shortcut to toggle the sidebar — will add when we implement the full keyboard shortcut system)
- (deferred: collapsible project groups — projects are currently always expanded, will revisit when session count per project warrants it)
- Each project section header shows the project name and a `[+]` button
- The `[+]` button opens a dropdown with "Code Review" and "Browse Archive" — same behavior as the landing page quick actions
- Under each project header, active sessions are listed with a mode icon, session label, and status indicator (dot: active, checkmark: completed)
- Clicking a session navigates to `/s/:sessionId`
- An "Add project" button opens the same add-project flow as the landing page
- A theme toggle button switches between dark and light mode

## Session Route (`/s/:id`)

- The session route loads the session bootstrap from the daemon API
- The sidebar is available for switching between sessions
- The main content area is a placeholder for now — actual plan/review/annotate surfaces are follow-up work
- If the session is not found, a clear error state is shown

## Component Organization

- shadcn primitives (button, sidebar, tooltip, dropdown, etc.) live in `apps/frontend/src/components/ui/`
- Application components live in `apps/frontend/src/components/` organized by surface (`landing/`, `sidebar/`)
- Hooks live in `apps/frontend/src/hooks/` organized by domain (`sessions/`, `projects/`)
- Stores live in `apps/frontend/src/stores/` (`app-store.ts`, `project-store.ts`)
- Shared utilities live in `apps/frontend/src/shared/` (e.g., `session-meta.ts`)
- `cn()` utility is at `src/lib/utils.ts`

## Quality

- All code passes the existing `check` pipeline: strict TypeScript, oxlint (zero warnings), oxfmt, vitest
- Daemon API changes include unit tests for the project registry (read, write, auto-register, remove, validation)
- Error handling uses sonner toasts for all async actions (session creation, project removal)
- Single-file HTML build verified by post-build script
