# @plannotator/debug-frontend

Debug/development harness UI for the Plannotator daemon runtime. **Not production code** — this is a
testbed for exercising daemon sessions, verifying event streams, and testing session lifecycle actions.

## Shape

- `src/routes` is only TanStack Router wiring.
- `src/daemon` owns the typed daemon API client and contracts.
- `src/sessions` owns session ids, session state, the dashboard, and mode dispatch.
- `src/plan`, `src/review`, `src/annotate`, `src/archive`, and `src/setup-goal` own product views.
- `src/testing` owns contract fixtures and browser helpers.

The shell talks to session APIs through `/s/:sessionId/api`, never root `/api`.

The build is intentionally single-file HTML for daemon serving. Separate static asset
routes are deferred until the full UI migration needs code splitting or cacheable chunks.

## Commands

```bash
bun run --cwd apps/debug-frontend dev
bun run --cwd apps/debug-frontend build
bun run --cwd apps/debug-frontend check
bun run --cwd apps/debug-frontend test:browser
```

Or from the repo root:

```bash
bun run dev:debug-frontend
bun run build:debug-frontend
bun run check:debug-frontend
```
