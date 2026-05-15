# Plan: Interactive Goal Setup UI

## Solution Approach

Build a structured goal setup mode alongside the existing markdown plan/annotate surfaces. Keep the current markdown `Viewer` intact for plans, archives, diffs, and normal annotation, and add a new goal setup surface that reuses the Plannotator shell while rendering Q&A and fact review from typed data instead of parsed markdown.

Use two reviewed interactions:

- Interview: the agent writes a question bundle, launches the UI, waits for structured answers, then uses those answers to draft facts.
- Facts acceptance: the agent writes structured facts with automated-verification recommendations, launches the UI, waits for accepted facts, then writes final `facts.md` and continues planning.

## Ordered Steps

1. Update the setup-goal skill instructions.
   - Touches `apps/skills/plannotator-setup-goal/SKILL.md` and `apps/skills/plannotator-setup-goal/agents/openai.yaml` if the default prompt needs a clearer description.
   - Replace "ask questions one at a time" with instructions to prepare a complete question bundle, run the Plannotator goal setup UI as a monitored bash process, wait patiently for output, and use accepted facts plus automated-verification selections when writing `plan.md`.
   - Verification: inspect the skill text and run a focused text test if one is added for skill expectations.

2. Add shared goal setup data types and serializers.
   - Add a new shared module such as `packages/shared/goal-setup.ts`.
   - Define `GoalSetupQuestion`, `GoalSetupQuestionOption`, `GoalSetupInterviewBundle`, `GoalSetupInterviewResult`, `GoalSetupFact`, `GoalSetupFactsBundle`, and `GoalSetupFactsResult`.
   - Include stable ids, prompts, answer mode, recommended answer text, option lists, selected option ids, custom answer text, accepted fact state, recommended automated-verification flag, final automated-verification flag, and comments.
   - Include merge helpers that preserve accepted facts across iterative fact review passes and filter accepted facts out by default.
   - Verification: add `packages/shared/goal-setup.test.ts` for parsing, validation, answer modes, accepted-fact filtering, and serialization.

3. Add Bun server support for goal setup sessions.
   - Add `packages/server/goal-setup.ts` or extend a small shared server helper if duplication with `annotate.ts` becomes obvious.
   - Serve a new API shape, likely `GET /api/goal-setup`, `POST /api/goal-setup/submit`, and `POST /api/exit`.
   - Register active sessions through `packages/server/sessions.ts` and use existing browser-opening helpers.
   - Emit structured JSON to stdout for Claude Code CLI usage so the skill can consume the result without scraping prose.
   - Verification: add server tests for response shape and decision resolution.

4. Mirror the goal setup server in Pi.
   - Add or mirror the same endpoint behavior under `apps/pi-extension/server/`.
   - Wire Pi command handling in `apps/pi-extension/index.ts`.
   - Preserve runtime parity for mode names, request/response fields, and approval/exit behavior.
   - Verification: run Pi typecheck path through `bun run typecheck`; add focused Pi server tests if practical.

5. Add CLI and command entry points.
   - Extend `apps/hook/server/index.ts` and `apps/hook/server/cli.ts` with a goal setup subcommand.
   - Prefer explicit stages, for example `plannotator setup-goal interview <bundle.json> --json` and `plannotator setup-goal facts <bundle.json> --json`.
   - Add Claude slash command docs only if a user-facing command is needed; the skill may call the binary directly.
   - Add OpenCode support in `apps/opencode-plugin/commands.ts` if the setup-goal flow should work from OpenCode sessions.
   - Verification: update CLI tests for help text, missing-file errors, and JSON output paths.

6. Add the goal setup UI surface.
   - Add `packages/ui/components/goal-setup/GoalSetupSurface.tsx` plus focused child components for interview and facts.
   - Add package exports for `@plannotator/ui/components/goal-setup/*`.
   - In `packages/editor/App.tsx`, detect `mode: "goal-setup"` or equivalent API data and render the new surface instead of `Viewer`.
   - Keep `AppHeader`, `ThemeProvider`, `OverlayScrollArea`, and shell layout behavior consistent with the plan editor.
   - Verification: run `bun run --cwd packages/ui typecheck` and `bun run build:review && bun run build:hook`.

7. Build the interview UI.
   - Show all questions vertically for fast scanning and answering.
   - Provide quick next-question navigation and a keyboard shortcut.
   - Support text answers, single-select options, multi-select options, option-plus-custom answers, and clearable recommended placeholders.
   - Use `motion` for expansion or secondary details only where it reduces friction; honor reduced-motion preferences.
   - Use `lucide-react` icons for recognizable controls.
   - Verification: local dev mock should serve a demo interview bundle; manually answer all modes and confirm submitted JSON.

8. Build the facts acceptance UI.
   - Render facts as a simple vertical list with right-side quick actions.
   - Support accept, edit, remove, comment, and automated-verification toggle per fact.
   - Reuse `CommentPopover` patterns where possible instead of inventing another comment UI.
   - Hide accepted facts in later iterative passes by default, with a way to reveal accepted facts if needed.
   - Keep final `facts.md` flat and readable while preserving structured metadata in a predictable companion artifact or embedded format.
   - Verification: manually review a facts bundle, accept some facts, reopen an updated bundle, and confirm accepted facts are filtered out.

9. Add shared UI primitives carefully.
   - Add or promote primitives under a composable shared location such as `packages/ui/components/core/`.
   - Reuse existing `ActionMenu`, `ToolbarButtons`, `Popover`, `CommentPopover`, `ConfirmDialog`, and header/gate behavior when suitable.
   - Add `motion`, `lucide-react`, and any required Radix primitive dependencies to the package that owns the components, likely `packages/ui/package.json`.
   - Avoid running shadcn generators unless the repo is first configured for that workflow; prefer hand-adapted primitives using existing Plannotator tokens.
   - Verification: inspect imports for duplicate button/popover/header implementations and run typecheck.

10. Add local development fixtures.
    - Extend `apps/hook/dev-mock-api.ts` with a demo goal setup mode or add a separate dev flag that returns interview and facts fixture data.
    - Make it possible to test the UI with `bun run dev:hook` before wiring every agent runtime.
    - Verification: open the dev server, exercise interview and facts flows, and capture any layout issues.

11. Add the optional facts-diff phase after the core flow works.
    - Use stable fact ids and saved fact metadata to compare current and previous fact bundles.
    - Prefer a small facts-only diff UI before touching the full plan diff engine.
    - Keep this phase explicitly optional so it does not block the core Q&A and facts acceptance experience.
    - Verification: fixture two fact bundle versions and confirm changed/new/removed facts are distinguishable.

## Verification

- `bun test packages/shared/goal-setup.test.ts`
- `bun test apps/hook/server/cli.test.ts`
- `bun test` for the touched shared/server tests
- `bun run typecheck`
- `bun run build:review && bun run build:hook`
- Manual browser check with `bun run dev:hook`: interview bundle, answer options, custom answers, next-question navigation, facts quick actions, accepted-fact filtering, and automated-verification toggles.
- Manual runtime check with the built `plannotator setup-goal interview ... --json` and `plannotator setup-goal facts ... --json` commands.

## Risks And Open Questions

- The exact CLI file format should stay simple enough for agents to write reliably; JSON is preferred over ad hoc markdown parsing.
- OpenCode and Pi can run browser sessions differently from Claude Code, so command delivery should be tested in each runtime before release.
- Motion Primitives examples may not map cleanly into this repo because there is no existing shadcn config; adapt the patterns rather than forcing the generator.
- Facts-diff support could grow into a larger versioning feature; keep it behind the core flow.
- Refactoring shared shell/header/gate primitives could touch broad UI code, so keep extraction narrow and covered by build/typecheck/manual verification.
