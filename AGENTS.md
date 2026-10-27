# Plannotator agent guidance

Plannotator is a plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. It also provides code review for git diffs and annotation of arbitrary Markdown files.

This file is a map. The full guidance lives in focused guides under [`docs/agent-guides/`](docs/agent-guides/). Read the hard rules below, then the guide for the code or behavior you are changing. `CLAUDE.md` is a symlink to this file; `packages/ui/AGENTS.md` adds guidance scoped to `packages/ui/`.

## Hard rules (read before touching anything)

- **Reusing the document UI in the commercial Workspaces app?** Read [`packages/ui/README.md`](packages/ui/README.md) FIRST: an earlier from-scratch rebuild of this UI broke the app and was reverted. Do not rebuild the UI or recreate `packages/document-ui`; add a seam to `@plannotator/ui` (`configurePlannotatorUI()`), keep Plannotator's app unchanged, and never delete working code until a human confirms parity in the browser.
- **Two server runtimes change together.** An endpoint change goes into both the Bun server (`packages/server/`) and the Pi server (`apps/pi-extension/server/`); shared logic lives in `packages/shared/`. Only the Inbox is Bun-only. See [Server Runtimes](docs/agent-guides/project-and-development.md#server-runtimes).
- **Build order: review, then hook, then opencode.** `bun run --cwd apps/review build && bun run build:hook && bun run build:opencode`; building out of order copies stale HTML. See [Build](docs/agent-guides/project-and-development.md#build).
- **Tailwind `@source`.** A new directory with `.tsx` files that use Tailwind classes needs a matching `@source` entry in the app's `index.css`.
- **Testing Rules** (full list in [Testing Rules](docs/agent-guides/project-and-development.md#testing-rules)):
  - Tests and dev scripts never touch the real `~/.plannotator`, the real Inbox or user config: sandbox under a temp `PLANNOTATOR_DATA_DIR`, and mutate globals only inside tests with a restore.
  - Tests never open a browser: set `NO_BROWSER` from `tests/helpers/no-browser.ts`, never `PLANNOTATOR_BROWSER=none` (or another sentinel).
  - Tests never run the real GitHub CLI, and never signal an Inbox except through `tests/helpers/inbox-process.ts`.
  - Every test guards a behavior that can regress: no copy snapshots of prose, no round-trip prop tests, no implementation echo.
- **No new Inbox keyboard shortcuts without the owner's approval** (see the Inbox shortcuts note in [Keyboard Shortcuts](docs/agent-guides/guides-and-shared-ui.md#keyboard-shortcuts)). Shortcuts elsewhere go through the shortcut registry.
- **Git:** never rebase or force-push a shared branch; merge main instead.
- **Releases:** follow [`.agents/skills/release/SKILL.md`](.agents/skills/release/SKILL.md).

## Topic guides

- [`project-and-development.md`](docs/agent-guides/project-and-development.md): repository map, server runtimes, installation, development, Testing Rules, build, marketing site.
- [`environment.md`](docs/agent-guides/environment.md): every environment variable and config-only setting.
- [`plan-review.md`](docs/agent-guides/plan-review.md): plan review flow, Guides in VS Code, Pi plan review and the Pi `plannotator` tool.
- [`claude-code-mod.md`](docs/agent-guides/claude-code-mod.md): the Claude Code hooks module (non-blocking flows, the `plannotator` tool, its Ask this session client and Inbox wake, version skew).
- [`opencode-t3-and-codex.md`](docs/agent-guides/opencode-t3-and-codex.md): OpenCode 2 tool, T3 Code, Codex Stop hook.
- [`code-review.md`](docs/agent-guides/code-review.md): code review flow and UI, Ask AI provider defaults, "Ask this session" (the session bridge and pull bridge).
- [`annotate.md`](docs/agent-guides/annotate.md): annotate flow, bundles, drafts, strict gates, live app annotation.
- [`inbox.md`](docs/agent-guides/inbox.md): index to the Plannotator Inbox guides (`inbox-*.md`).
- [`server-and-storage.md`](docs/agent-guides/server-and-storage.md): archive, Server API tables and guards, plan history, feedback archive, plan diff.
- [`guides-and-shared-ui.md`](docs/agent-guides/guides-and-shared-ui.md): portable Guided Reviews, data types, parser, annotation system, question blocks, WebMCP, shortcuts, sharing, settings, syntax highlighting.

## Where new docs go

Keep this file a map: add no feature detail here. Put a new section in the guide for its area (the list above): an env var in `environment.md`, an endpoint in the matching Server API table in `server-and-storage.md`, Inbox behavior in the matching `inbox-*.md` (and a line in `inbox.md` for a new Inbox guide), a shared UI or format change in `guides-and-shared-ui.md`. A new guide gets one line in the list above. `tests/agents-md-size.test.ts` fails when this file grows past its budget or links to a guide that does not exist.
