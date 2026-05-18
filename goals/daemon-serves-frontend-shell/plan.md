# Plan: Daemon Serves The Frontend Shell

## Solution Approach

Serve the new `apps/frontend` React shell from the daemon HTTP server itself, while leaving the existing per-mode backend handlers intact. The shell becomes the browser surface for daemon routes such as `/` and `/s/<sessionId>`, and existing APIs continue to flow through `/daemon/*` and `/s/<sessionId>/api/*`.

Use a single-file frontend build for this phase. That matches the current packaged HTML model, avoids a new asset server in the daemon, and keeps direct refreshes of `/s/<sessionId>` reliable. Static asset routing can be revisited later when the real UI migration needs chunking or cacheable assets.

## Current State

- `apps/frontend` already has the shell skeleton, TanStack Router route `/s/$sessionId`, Zustand/Immer session state, daemon API client, fixtures, unit tests, and browser-mode rendering tests.
- `packages/server/daemon/server.ts` currently serves `record.htmlContent` at `/s/<id>` and keeps `/s/<id>/api/*` routed to the owning session handler.
- `packages/server/daemon/session-factory.ts` currently copies old plan/review HTML into each daemon session record.
- `apps/hook/server/html-assets.ts` currently imports the old plan and review HTML from `apps/hook/dist`.
- `apps/frontend` currently builds Vite-style split assets: `dist/index.html` references `dist/assets/*.js` and `dist/assets/*.css`.

## Ordered Steps

1. Make the frontend build daemon-ready.
   - Update `apps/frontend/vite.config.ts` to use `vite-plugin-singlefile`, mirroring the single-file settings already used by `apps/hook/vite.config.ts`.
   - Add `vite-plugin-singlefile` to `apps/frontend/package.json` dev dependencies.
   - Add a small build-artifact verification script under `apps/frontend/scripts/` that fails if `dist/index.html` references `/assets/` JavaScript or CSS.
   - Wire the frontend `build` script to run Vite and then the artifact verification.

2. Isolate the daemon shell HTML asset.
   - Add a dedicated hook-server asset module for the frontend shell, for example `apps/hook/server/daemon-shell-html.ts`, importing `../../frontend/dist/index.html` as text.
   - Keep old plan/review HTML imports isolated so direct non-daemon paths do not require the frontend shell asset unless the daemon is actually starting.
   - Add `getDaemonShellHtmlContent()` in `apps/hook/server/index.ts` and use it only for daemon startup.

3. Make the daemon server own the shell.
   - Add `shellHtmlContent` to `StartDaemonRuntimeOptions` and `DaemonServerOptions`.
   - Pass `shellHtmlContent` from `startDaemonRuntime()` into `createDaemonFetchHandler()`.
   - Serve the shell from the daemon root `/` so the existing frontend dashboard route can list sessions.
   - Serve the shell from `/s/<sessionId>` and other non-API session paths, including missing-session paths. The frontend then calls `/s/<sessionId>/api/session` and renders the error state from the JSON response.
   - Keep `/daemon/*`, `/favicon.svg`, `/s/<sessionId>/api/session`, and `/s/<sessionId>/api/*` behavior unchanged.
   - Continue injecting `window.__PLANNOTATOR_API_BASE__` for session pages so old shared UI helpers remain compatible during migration.

4. Stop treating per-session HTML as the daemon browser surface.
   - Update `packages/server/daemon/session-factory.ts` so records no longer need to store old plan/review HTML for daemon page serving.
   - Continue passing the old plan HTML into `createPlannotatorSession()` and `createAnnotateSession()`, and the old review HTML into `createReviewSession()`, so direct non-daemon handlers and any internal SPA fallbacks stay unchanged.
   - Keep `DaemonSessionRecord.htmlContent` as an optional fallback for tests or transitional callers, but production daemon startup should serve `shellHtmlContent` first.

5. Update build ordering.
   - Update root and hook build scripts so `apps/frontend` builds before any hook/server compile path imports the daemon shell HTML.
   - Ensure release build paths that currently run `bun run build:review` and `bun run build:hook` also get the frontend shell through the hook build chain.
   - Keep `build:frontend` and `check:frontend` available as explicit local commands.

6. Strengthen tests around the new contract.
   - Update `packages/server/daemon/server.test.ts` to prove:
     - `GET /` serves the shell.
     - `GET /s/<id>` serves the shell rather than old per-mode HTML.
     - `GET /s/<missing>` serves shell HTML, while `GET /s/<missing>/api/session` returns the structured daemon 404.
     - `GET /s/<id>/api/session` still returns the bootstrap payload.
     - `GET /s/<id>/api/*` still delegates to the existing session handler.
   - Update `packages/server/daemon/session-factory.test.ts` only where needed to reflect that page HTML is daemon-owned, while API handlers still expose plan/review/annotate/archive data correctly.
   - Keep and run the frontend unit and browser-mode tests that verify the router, API client, store, supported session views, and error states.

7. Update shell documentation.
   - Update `apps/frontend/README.md` to say the daemon serves the shell at `/` and `/s/<sessionId>`.
   - Note that the frontend is intentionally single-file for this phase and that static asset serving is deferred.

## Verification

Run these checks before considering the implementation complete:

```bash
bun install
bun run --cwd apps/frontend check
bun run --cwd apps/frontend test:browser
bun run build:frontend
bun run build:hook
bun run check:frontend
bun test packages/server/daemon/server.test.ts packages/server/daemon/session-factory.test.ts packages/shared/daemon-protocol.test.ts
bun run typecheck
bun test
```

Also inspect the built frontend artifact after `bun run build:frontend`:

```bash
find apps/frontend/dist -maxdepth 2 -type f -print
rg '/assets/' apps/frontend/dist/index.html
```

The first command should show the shell artifact, and the second command should find no external asset references.

## Risks And Notes

- The daemon should not serve the shell for root `/api/*`; root session APIs must continue returning 404 so callers use `/s/<id>/api/*`.
- Importing `apps/frontend/dist/index.html` from a shared `html-assets.ts` module would make unrelated direct paths require the frontend build. Keep the daemon shell import isolated.
- Serving the shell at `/s/<missing>` is intentional: the frontend has the better missing-session UI, and `/s/<missing>/api/session` remains the source of truth.
- Static asset serving is not rejected forever. It is deferred because this phase values a reliable daemon integration over introducing cache, base-path, and asset-route behavior before the real UI migration requires it.
