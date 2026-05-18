# Runtime Frontend Shell Plan

## Solution Approach

Create a third stacked PR for a new local runtime frontend shell on top of the latest daemon runtime branch. In this plan, "runtime shell" means the new frontend app that will eventually become the one Plannotator UI served by the daemon. The concrete app path should be `apps/frontend`.

This shell is a fresh Vite React TypeScript app using TanStack Router, Zustand, Immer, OxLint, Oxfmt, and Vitest Browser Mode with the Playwright provider. It is a production-grade skeleton only: no plan/review UI migration yet, but it must model the real daemon/session architecture and the real Plannotator API surface so later migration work is clean.

Use a static Vite SPA for this skeleton rather than TanStack Start SSR. The local runtime already has a Bun daemon that owns session state, file access, VCS access, SSE, and browser APIs; adding a second server-side rendering runtime would increase moving parts before there is a clear user-facing SSR benefit. TanStack Router is still the right router: it gives typed `/s/$sessionId` routing and loaders inside the single frontend.

The runtime shell should be developed from the full inventory in `goals/runtime-frontend-shell/functionality-inventory.md`. That inventory is the checklist for current app responsibilities, daemon routes, session modes, API fixtures, and verification coverage.

Architecture decision: use route-driven navigation plus product-module ownership. `src/routes` exists because TanStack Router needs route files and typed params. It should stay thin. The actual Plannotator domains live in top-level modules: `sessions`, `plan`, `review`, `annotate`, `archive`, and `setup-goal`. The daemon protocol/client lives in `daemon` because it is infrastructure shared by those modules. `shared` is allowed, but only for generic primitives that truly have no product owner. This avoids both common failure modes: huge route files and a vague `features/` bucket where every future concern can be dumped.

References:

- TanStack Router Vite setup: https://tanstack.com/router/latest/docs/installation/with-vite
- Zustand Immer middleware: https://zustand.docs.pmnd.rs/reference/middlewares/immer
- Vitest Browser Mode with Playwright provider: https://vitest.dev/config/browser/playwright
- Oxlint usage: https://oxc.rs/docs/guide/usage/linter.html
- Oxfmt usage: https://oxc.rs/docs/guide/usage/formatter.html

## Stacked PR Boundary

This work should be a third stacked branch created from the current tip of the daemon branch:

```bash
git fetch origin
git switch feat/plannotator-daemon-runtime
git pull --ff-only
git switch -c feat/runtime-frontend-shell
```

The PR base should be `feat/plannotator-daemon-runtime` / PR #734. It should not target `main` or `feat/single-server-runtime`. If the local daemon branch is behind the branch under review, update it first; this shell branch must stack on the latest daemon-runtime code, not on an older local checkpoint.

Do not replace the existing production-served HTML bundles in this goal. The current daemon continues serving `apps/hook/dist/index.html` and `apps/hook/dist/review.html` while the new runtime app is built and tested independently.

## Ordered Steps

1. Treat the runtime functionality inventory as the implementation contract.

   Touches:
   - `goals/runtime-frontend-shell/functionality-inventory.md`

   Implementation notes:
   - Keep the inventory open during implementation.
   - Start by re-reading the source audit baseline in the inventory and update it if the daemon branch has moved.
   - Add final evidence to the inventory before calling the goal complete.
   - Any endpoint group from the inventory that the skeleton does not fixture or test must be marked as deferred with a reason.
   - The inventory must remain clear that there is one daemon process and many Plannotator sessions inside it.

   Verification:
   - Inventory exists before implementation starts.
   - Inventory includes stack boundary, existing local frontend responsibilities, daemon routes, plan/archive/annotate APIs, review APIs, shared APIs, fixture requirements, and verification checklist.

2. Add a small daemon session bootstrap contract for the shell.

   Touches:
   - `packages/shared/daemon-protocol.ts`
   - `packages/shared/daemon-protocol.test.ts`
   - `packages/server/daemon/server.ts`
   - `packages/server/daemon/server.test.ts`

   Implementation notes:
   - Add a shared type such as `DaemonSessionBootstrapResponse`.
   - Add `GET /s/:sessionId/api/session` in the daemon router before session API delegation.
   - Return a stable bootstrap payload:
     - `ok: true`
     - `session: DaemonSessionSummary`
     - `apiBase: "/s/<id>/api"`
     - daemon protocol/capabilities needed by the shell
     - supported shell session views
   - Keep `/daemon/sessions`, `/daemon/sessions/:id`, `/daemon/status`, and all mode-specific APIs intact.
   - Do not add unrelated daemon auth/control-plane changes in this frontend-shell goal.

   Verification:
   - Unit test bootstrap success for an active session.
   - Unit test bootstrap error for missing session.
   - Unit test `/s/:id/api/session` is handled by the daemon and not forwarded to the mode handler.
   - Existing daemon route tests still pass.

3. Add the new `apps/frontend` workspace app.

   Touches:
   - `apps/frontend/package.json`
   - `apps/frontend/index.html`
   - `apps/frontend/tsconfig.json`
   - `apps/frontend/vite.config.ts`
   - `apps/frontend/vitest.config.ts`
   - `apps/frontend/src/main.tsx`
   - root `package.json`

   Implementation notes:
   - Dependencies: React, React DOM, Vite, TypeScript, Tailwind, `@tanstack/react-router`, `zustand`, `immer`.
   - Dev dependencies: `@tanstack/router-plugin`, `vitest`, `@vitest/browser-playwright`, `oxlint`, `oxfmt`, existing Vite/Tailwind tooling.
   - Configure TanStack Router's Vite plugin before React.
   - Configure generated route tree path and ignore it for lint/format.
   - Add root scripts such as `dev:frontend`, `build:frontend`, and optionally `check:frontend`.
   - Do not wire this app into daemon production HTML serving yet.

   Verification:
   - `bun run --cwd apps/frontend build`
   - `bun run build:frontend`
   - `bun run --cwd apps/frontend typecheck`

4. Establish a product-module source tree with thin TanStack route files.

   Touches:
   - `apps/frontend/src/app/*`
   - `apps/frontend/src/routes/*`
   - `apps/frontend/src/daemon/*`
   - `apps/frontend/src/sessions/*`
   - `apps/frontend/src/plan/*`
   - `apps/frontend/src/review/*`
   - `apps/frontend/src/annotate/*`
   - `apps/frontend/src/archive/*`
   - `apps/frontend/src/setup-goal/*`
   - `apps/frontend/src/shared/*`
   - `apps/frontend/src/testing/*`

   Target structure:
   - `src/app/` for app bootstrap, providers, shell layout, global error boundaries.
   - `src/routes/` for TanStack route files only. Route files should wire params/loaders to session-view components.
   - `src/daemon/` for daemon control-plane clients, bootstrap contracts, and protocol adapters.
   - `src/sessions/` for session id validation, summaries, selected-session state, dashboard components, and session-view registry.
   - `src/plan/`
   - `src/review/`
   - `src/annotate/`
   - `src/archive/`
   - `src/setup-goal/`
   - `src/shared/` only for genuinely generic UI primitives, app utilities, and shell-only composition types that are not owned by a product module.
   - `src/testing/` for fixture servers, fake fetch implementations, and browser-test helpers.

   Implementation notes:
   - Route files stay thin.
   - Product modules own their components, session-mode adapters, fixtures, and tests.
   - Keep `src/shared/` small. Do not use it as a dumping ground for code that belongs to `plan`, `review`, `annotate`, `archive`, `setup-goal`, `sessions`, or `daemon`.
   - This is the practical domain-driven shape for this app: TanStack Router owns URL/type structure, while top-level product modules own Plannotator behavior.
   - The setup-goal module starts as a stub/fixture because this branch does not currently contain setup-goal CLI source.

   Verification:
   - Tree review against facts and inventory.
   - No single large catch-all app file.

5. Build a typed daemon API client and fixture contract.

   Touches:
   - `apps/frontend/src/daemon/api/client.ts`
   - `apps/frontend/src/daemon/api/errors.ts`
   - `apps/frontend/src/daemon/contracts.ts`
   - `apps/frontend/src/testing/fixtures/*`

   Implementation notes:
   - Use shared types from `@plannotator/shared/daemon-protocol`.
   - Include typed functions for daemon status, session list, session bootstrap, and optional session cancel.
   - Accept injectable `fetch`.
   - Normalize protocol errors, network errors, non-JSON responses, and malformed payloads into explicit frontend states.
   - Build fixture data for every session mode and every API group listed in the inventory.
   - The shell's own client should never depend on daemon HTML monkey-patching or root `/api/*`.

   Verification:
   - API client tests for success, daemon error, missing session, malformed JSON, and network failure.
   - URL construction tests prove session calls use `/s/:id/api/...`.
   - Fixture tests prove every inventory endpoint group has at least a representative contract fixture or an explicit deferred marker.

6. Add TanStack Router routes and loaders.

   Touches:
   - `apps/frontend/src/routes/__root.tsx`
   - `apps/frontend/src/routes/index.tsx`
   - `apps/frontend/src/routes/s.$sessionId.tsx`
   - generated `apps/frontend/src/routeTree.gen.ts`

   Implementation notes:
   - `/` is the session index/dashboard.
   - `/s/$sessionId` is the canonical session entry.
   - Use explicit route names and validated params. If available in the installed Router version, use `params.parse` for session id validation.
   - Route loaders call the daemon API client.
   - Session route renders from bootstrap data through the session-view registry.
   - Avoid ambiguous dynamic route patterns.

   Verification:
   - Route tests for valid session id, invalid session id, dashboard loader, session loader success, session missing, backend failure.
   - Generated route tree is ignored by Oxfmt/OxLint and not manually edited.

7. Add Zustand/Immer stores for shell and session state.

   Touches:
   - `apps/frontend/src/app/state/shell-store.ts`
   - `apps/frontend/src/sessions/state/session-store.ts`
   - optional session-view state modules if needed

   Implementation notes:
   - Keep stores small and domain-specific.
   - Session state should be keyed by session id.
   - Track summaries, selected session, bootstrap cache, per-session load/error state, and shell UI state.
   - Use Zustand's Immer middleware for nested updates where it improves clarity.
   - Do not migrate current plan/review annotation state yet.
   - Use real Plannotator-shaped types; do not invent parallel shapes when shared types exist.

   Verification:
   - Store tests for loading/success/failure transitions.
   - Store tests for per-session isolation.
   - Immer tests prove nested updates do not mutate prior state.

8. Implement minimal production-grade stub session views.

   Touches:
   - `apps/frontend/src/sessions/session-view-registry.ts`
   - `apps/frontend/src/plan/*`
   - `apps/frontend/src/review/*`
   - `apps/frontend/src/annotate/*`
   - `apps/frontend/src/archive/*`
   - `apps/frontend/src/setup-goal/*`

   Implementation notes:
   - "Session view" means the mode-specific product view mounted for one Plannotator session.
   - Each stub receives real bootstrap data.
   - Each stub displays session id, mode, project, label, origin, status, and apiBase.
   - Plan/review/annotate/archive session views should name the major API groups they will eventually consume, based on the inventory.
   - Setup-goal session view should be present but marked as fixture-backed until backend source exists.
   - Unsupported mode renders a deliberate unsupported-session state.
   - Do not import or mount `packages/editor/App.tsx` or `packages/review-editor/App.tsx`.

   Verification:
   - Session-view registry tests for every supported mode.
   - Browser tests verify each fixture mode renders the expected stub.
   - Unsupported mode test.

9. Configure OxLint and Oxfmt for the new app only.

   Touches:
   - `apps/frontend/package.json`
   - `apps/frontend/oxlint.json` or supported OxLint config
   - `apps/frontend/.oxfmtignore` or supported formatter ignore config

   Implementation notes:
   - Scripts:
     - `lint`
     - `lint:fix`
     - `fmt`
     - `fmt:check`
     - `check`
   - Scope commands to `apps/frontend`.
   - Ignore generated TanStack route tree.
   - Keep rules conservative and correctness-focused first.
   - Do not reformat the repo.

   Verification:
   - `bun run --cwd apps/frontend lint`
   - `bun run --cwd apps/frontend fmt:check`
   - Git diff shows no unrelated formatting churn.

10. Add high-signal tests with Vitest and Vitest Browser Mode.

    Touches:
    - `apps/frontend/vitest.config.ts`
    - `apps/frontend/src/**/*.test.ts`
    - `apps/frontend/src/**/*.browser.test.tsx`
    - `apps/frontend/src/testing/*`

    Implementation notes:
    - Use normal Vitest for pure/domain/client/store integration tests.
    - Use Vitest Browser Mode with `@vitest/browser-playwright` for browser-level shell behavior.
    - Browser tests should exercise user-visible behavior: dashboard, session links, loading, errors, and rendered stubs.
    - Vitest Browser Mode isolates per test file, not every test; reset store and fixtures explicitly.
    - Prefer fixture-backed daemon-compatible responses over broad network mocking that hides URL mistakes.

    Required test coverage:
    - route loader success and failure
    - session id validation
    - dashboard empty and populated states
    - session opening
    - bootstrap success
    - bootstrap not found
    - daemon/backend error state
    - mode-to-session-view rendering
    - setup-goal fixture rendering
    - session state isolation
    - Zustand/Immer nested updates
    - typed API client URL construction and error normalization

    Verification:
    - `bun run --cwd apps/frontend test`
    - `bun run --cwd apps/frontend test:browser`
    - `bun run --cwd apps/frontend check`

11. Document the shell architecture and migration path.

    Touches:
    - `apps/frontend/README.md`
    - optional `docs/runtime-frontend-shell.md`
    - `goals/runtime-frontend-shell/functionality-inventory.md`

    Implementation notes:
    - Document app commands.
    - Document route structure.
    - Document daemon bootstrap contract.
    - Document current stub-only state.
    - Document how plan/review/annotate/archive/setup-goal will migrate later.
    - Document why TanStack Start SSR is not used for the local daemon runtime.
    - Record final inventory evidence.

    Verification:
    - Documentation review against facts and inventory.
    - Inventory has final evidence or explicit deferral for every item.

## Final Verification

Focused checks:

```bash
bun test packages/shared/daemon-protocol.test.ts packages/server/daemon/server.test.ts
bun run --cwd apps/frontend check
bun run --cwd apps/frontend build
bun run --cwd apps/frontend test
bun run --cwd apps/frontend test:browser
```

Broader checks if dependencies, root scripts, or shared protocol changes touch workspace behavior:

```bash
bun run typecheck
bun test
```

## Risks And Open Questions

- Setup-goal source is not present in this branch even though the installed local binary supports it. The shell should include a setup-goal stub and fixture, but backend protocol changes should wait until source ownership is clear.
- TanStack Router generates `routeTree.gen.ts`; generated route output must be ignored by OxLint/Oxfmt and never hand-edited.
- Existing apps still rely on root `/api/*` calls plus daemon injection. The new shell should use explicit typed API clients from the beginning.
- Vitest Browser Mode with Playwright is a good fit for shell behavior, but its isolation model is per test file; reset state deliberately.
- Future binary embedding may require a single-file app build or daemon static-asset serving. This goal should not solve that final serving switch unless the skeleton needs a build option to prove feasibility.
