# Goal: Initial View

Build the production frontend's home experience — a landing page showing registered projects with quick actions (Code Review, Browse Archive), an offcanvas sidebar for session navigation, and a command palette for keyboard-first access. Includes a daemon-side project registry that auto-catalogs workspaces from agent sessions and exposes them via API.

## Shared Understanding

See [facts.md](./facts.md) for the complete fact sheet covering the project registry, landing page, sidebar, quick actions, recently done tracking, component organization, and quality requirements.

## Execution Plan

See [plan.md](./plan.md) for the 9-step implementation plan covering daemon changes, frontend dependencies, shadcn primitives, stores, layout, landing page, command palette, session route, and integration tests.

## Done Condition

- `GET /daemon/projects` returns registered projects; sessions auto-register their project on creation
- The `/` route renders project cards with working Code Review and Browse Archive quick actions
- The offcanvas sidebar shows projects with grouped sessions, recently done, and add project
- `Cmd+B` toggles the sidebar, `Cmd+K` opens the command palette
- The full `check` pipeline passes (typecheck, oxlint, oxfmt, vitest)
- Single-file HTML build succeeds
