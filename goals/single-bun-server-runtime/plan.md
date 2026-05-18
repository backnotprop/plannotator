# Single Plannotator Binary Runtime Plan

## Solution Approach

Make the released `plannotator` Bun binary the only code path that serves Plannotator browser sessions. OpenCode and Pi become binary clients: they keep agent-specific UX and feedback injection, but they stop importing, bundling, or mirroring Plannotator server/runtime code.

This is phase one of the daemon-first architecture. The client boundary should be transport-neutral so it can start as subprocess-backed binary calls and later switch to a long-running daemon transport without rewriting OpenCode and Pi again. The plan must document the final daemon endpoint as a multi-session service with session IDs, per-session routing, decision delivery, cleanup, and concurrency handling.

## Ordered Steps

1. Inventory the current functionality before changing implementation paths.

   Touches: new `goals/single-bun-server-runtime/functionality-inventory.md`, current files under `apps/opencode-plugin/`, `apps/pi-extension/`, `apps/hook/server/`, and `packages/server/`.

   Build a durable inventory that can be used as the migration checklist and final parity checklist. It should cover:

   - Claude/binary CLI modes: plan review hook mode, `review`, `annotate`, `annotate-last`/`last`, `archive`, `sessions`, Copilot/Codex/Gemini modes, `improve-context`, and setup-goal flows.
   - Bun server APIs: plan, review, annotate, archive, draft, image/upload, editor annotations, external annotations, AI/agent jobs, PR switching, code navigation, document/reference routes, config routes, and session registry behavior.
   - OpenCode behaviors: `submit_plan`, backing-file edits, plan denial line-number feedback, approval notes, agent switching, command interception, `/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`, `/plannotator-archive`, sharing settings, workflow modes, and prompt transforms.
   - Pi behaviors: plan mode, `plannotator_submit_plan`, non-UI auto-approve, phase config, tool gating, execution checklist progress, slash commands, event-channel actions/status, current-session fallback, message anchoring, PR review/local checkout behavior, and archive/annotation flows.
   - Package/build/runtime payloads: plugin `files` arrays, generated/vendored Pi files, copied HTML assets, current CI build steps, installer behavior, environment variables, and binary release assets.

   Verification: the inventory file exists before implementation starts and has a final checklist entry for every accepted fact plus every current user-facing Pi/OpenCode flow. Later steps must update the inventory only when they intentionally move ownership to the binary.

2. Define the binary integration contract.

   Touches: `apps/hook/server/index.ts`, `apps/hook/server/cli.ts`, `packages/shared/agents.ts`, new protocol/types near the CLI or shared package.

   Add a plugin-facing command surface owned by the binary, for example:

   - `plannotator plugin capabilities --json`
   - `plannotator plugin plan --origin opencode|pi --json`
   - `plannotator plugin review --origin opencode|pi --json ...`
   - `plannotator plugin annotate --origin opencode|pi --json ...`
   - `plannotator plugin archive --origin opencode|pi --json ...`

   The exact names can change during implementation, but the contract must be explicit, versioned, and machine-readable. The output should include enough structured data for plugins to preserve existing behavior: approved/denied/exit state, feedback, annotations where relevant, saved path, agent switch, permission mode, and clear errors. Keep the contract request/response shaped so a future daemon HTTP or IPC transport can implement the same calls.

   Verification: add CLI/protocol unit tests for capabilities output, incompatible/missing protocol handling, and JSON result shape. Run `bun test apps/hook/server/cli.test.ts` plus new protocol tests.

3. Add binary discovery, capability checking, and installer helpers for plugin clients.

   Touches: new `apps/opencode-plugin/binary-client.ts`, new `apps/pi-extension/binary-client.ts`, docs for `PLANNOTATOR_BIN`.

   Discovery order should be:

   - explicit `PLANNOTATOR_BIN`
   - PATH lookup
   - standard install locations such as `~/.local/bin/plannotator` and Windows `.local\\bin\\plannotator.exe`

   After discovery, run the binary capabilities command and enforce the required integration protocol version. If missing or incompatible, run the official installer for the platform rather than bundling a binary in the plugin package. Keep this behavior testable by allowing auto-install to be disabled in tests/CI via an environment flag.

   Verification: unit-test discovery order, PATH fallback, standard-location fallback, missing binary install trigger, disabled auto-install behavior, and incompatible capabilities. Use mocked process spawning; do not hit the network in tests.

4. Refactor OpenCode into a binary client.

   Touches: `apps/opencode-plugin/index.ts`, `apps/opencode-plugin/commands.ts`, `apps/opencode-plugin/package.json`, `apps/opencode-plugin/*.test.ts`, `apps/opencode-plugin/README.md`.

   Keep OpenCode-specific behavior:

   - `submit_plan` registration
   - backing-file line-range edits
   - workflow/prompt transforms
   - slash-command interception
   - OpenCode session feedback injection and agent switching

   Remove server/runtime behavior:

   - no `@plannotator/server` imports
   - no direct `startPlannotatorServer`, `startReviewServer`, or `startAnnotateServer`
   - no `plannotator.html` or `review-editor.html` loading
   - no plugin-side diff preparation or annotation file/URL conversion when the binary can own it

   `submit_plan` should write the backing file as it does today, call the binary integration command, then format/inject the result into OpenCode. Slash commands should pass raw arguments to the binary and inject the returned feedback.

   Verification: update OpenCode tests to mock the binary client instead of server functions. Add an absence test that fails if `apps/opencode-plugin` imports `@plannotator/server` or packages browser HTML assets. Run `bun test apps/opencode-plugin`.

5. Refactor Pi into a binary client.

   Touches: `apps/pi-extension/index.ts`, `apps/pi-extension/plannotator-events.ts`, `apps/pi-extension/plannotator-browser.ts` or replacement client module, `apps/pi-extension/package.json`, `apps/pi-extension/tsconfig.json`, `apps/pi-extension/*.test.ts`, `apps/pi-extension/README.md`.

   Keep Pi-specific behavior:

   - phase state and persisted plan/execution state
   - tool gating and markdown-only planning writes
   - slash commands and shortcuts
   - current-session fallback
   - `plannotator:request` / `plannotator:review-result` event-channel compatibility

   Remove Pi-owned server/runtime behavior:

   - delete or stop shipping `apps/pi-extension/server/`
   - remove `apps/pi-extension/server.ts`
   - stop copying `plannotator.html` and `review-editor.html`
   - remove PR/diff/file/URL conversion code that now belongs to the binary integration command
   - shrink `vendor.sh` to only any remaining Pi-local helpers, or remove it entirely if those helpers become local code

   For the Pi event channel, preserve the pending-review behavior by letting the extension generate or track a `reviewId`, spawn the binary request in the background, persist pending/completed status, and emit `plannotator:review-result` when the binary returns. This preserves callers without requiring the final multi-session daemon yet.

   Preserve the current non-UI fallback for plan submission: if Pi has no UI, auto-approve as it does today. Missing browser HTML should no longer be a separate failure mode because the binary owns browser assets.

   Verification: replace Pi server parity tests with binary-client tests and event-channel tests. Keep existing phase/tool-scope/config tests. Add absence tests for `apps/pi-extension/server/`, `server.ts`, browser HTML assets, and server imports.

6. Update package payloads, build scripts, CI, and release checks.

   Touches: root `package.json`, `apps/opencode-plugin/package.json`, `apps/pi-extension/package.json`, `.github/workflows/test.yml`, `.github/workflows/release.yml`, `scripts/install.sh`, `scripts/install.ps1`, `scripts/install.cmd`, `scripts/install.test.ts`.

   Remove build steps that copy browser HTML into OpenCode or Pi packages. Remove CI steps that generate Pi server/shared copies if the plugin no longer needs them. Keep the existing release binary build pipeline intact: the binary is still compiled from `apps/hook/server/index.ts`, with the hook and review UI built before compilation.

   Installer scripts should continue installing/updating the binary and plugin packages, but docs and tests need to reflect that OpenCode and Pi now depend on the installed binary at runtime rather than packaged server assets.

   Verification: run `bun run build:hook`, `bun run build:opencode`, `bun run build:pi`, `bun run typecheck`, and `bun test`. Add string/packaging tests that assert plugin packages do not list browser HTML or Pi server folders.

7. Document the daemon endpoint and the deferred multi-session work.

   Touches: `apps/hook/README.md`, `apps/opencode-plugin/README.md`, `apps/pi-extension/README.md`, possibly a new architecture note under `docs/` or `goals/`.

   Document that phase one creates a daemon-ready binary client boundary but does not finish the true multi-session daemon rewrite. The follow-on daemon design must include:

   - one long-running binary-owned service
   - session creation per plan/review/annotate/archive request
   - session-scoped browser URLs and API routing
   - decision delivery back to the requesting client
   - TTL/cleanup for abandoned sessions
   - concurrent requests from Claude Code, OpenCode, Pi, Codex, Gemini, and Copilot without state collisions

   Verification: docs mention `PLANNOTATOR_BIN`, auto-install behavior, one Bun runtime, and the daemon-next boundary. The plan should not imply the current `packages/server/sessions.ts` registry is already a real multi-session daemon.

8. Run a fact-by-fact and inventory-by-inventory closure pass.

   Touches: `goals/single-bun-server-runtime/facts.md`, `goals/single-bun-server-runtime/facts.meta.json`, `goals/single-bun-server-runtime/functionality-inventory.md`, implementation PR notes or completion notes.

   Before calling the goal complete, verify every accepted fact and every inventory item. For automated facts, record the command, test, or absence check that proves the fact. For facts intentionally marked manual, record the code/doc location that proves the architecture decision. For each OpenCode and Pi flow in the inventory, mark whether it is directly tested, covered by a mocked binary-client test, or requires a manual smoke check.

   Verification: the final completion notes include a fact verification table and an inventory parity table. Any uncovered item must be explicitly called out as a blocker or residual risk.

## Verification Matrix

- `bun test apps/hook/server/cli.test.ts`
- New binary protocol tests for the plugin command surface.
- `bun test apps/opencode-plugin`
- `bun test apps/pi-extension`
- `bun test scripts/install.test.ts`
- `bun run typecheck`
- `bun run build:hook`
- `bun run build:opencode`
- `bun run build:pi`
- `goals/single-bun-server-runtime/functionality-inventory.md` exists and is checked off against the final implementation.
- Every accepted fact in `goals/single-bun-server-runtime/facts.md` has an explicit automated or manual verification note.
- Absence checks:
  - `rg '@plannotator/server|startPlannotatorServer|startReviewServer|startAnnotateServer' apps/opencode-plugin` returns no runtime imports.
  - `test ! -d apps/pi-extension/server`
  - `test ! -f apps/pi-extension/server.ts`
  - plugin package `files` arrays do not include `plannotator.html`, `review-editor.html`, or Pi server folders.

## Risks And Open Questions

- The first implementation can remove Node server duplication without delivering the final multi-session daemon. That is acceptable only if the binary/client contract is transport-neutral and the daemon endpoint is explicitly documented.
- Auto-installing from plugin startup can surprise users or fail in locked-down environments. The implementation should produce clear UI/log errors and include an opt-out for tests and controlled environments.
- Pi currently does file/URL conversion and PR checkout work in the extension. Moving that to the binary changes where progress/errors are reported; commands need user-visible status messages before and after binary calls.
- OpenCode and Pi package builds must not accidentally rely on repo-local workspace packages that are unavailable after npm install.
- The release binary already embeds browser HTML at compile time, so build order still matters: review UI first, hook UI second, binary compile after both.
