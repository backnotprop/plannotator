# @plannotator/frontend

Production frontend SPA for the Plannotator daemon runtime. Serves all session types: plan review, code review, annotate, and setup-goal.

## Shape

- `src/routes` is only TanStack Router wiring.
- `src/daemon` owns the typed daemon API client and contracts.
- `src/sessions` owns session ids, session state, the dashboard, and mode dispatch.
- `src/plan`, `src/review`, `src/annotate`, and `src/setup-goal` own product views.
- `src/testing` owns contract fixtures and browser helpers.

The shell talks to session APIs through `/s/:sessionId/api`, never root `/api`.

The build is intentionally single-file HTML for daemon serving. Separate static asset
routes are deferred until the full UI migration needs code splitting or cacheable chunks.

## Commands

```bash
bun run --cwd apps/frontend dev
bun run --cwd apps/frontend build
bun run --cwd apps/frontend check
bun run --cwd apps/frontend test:browser
```

Or from the repo root:

```bash
bun run dev:frontend
bun run build:frontend
bun run check:frontend
```
