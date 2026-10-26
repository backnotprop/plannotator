## Plannotator

A plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. Also provides code review for git diffs and annotation of arbitrary markdown files.

> **Reusing the document UI (theme / markdown / editor / settings / comments / layout) in the commercial Workspaces app? Read `packages/ui/README.md` FIRST.** It explains the published `@plannotator/ui` + `@plannotator/core` packages and the host-override seams a host plugs its own backend into via `configurePlannotatorUI()`. A prior from-scratch reimplementation of this UI broke the app and was reverted — do **not** rebuild it or recreate `packages/document-ui`. Add a seam to `@plannotator/ui` instead, keep Plannotator's app unchanged, and never delete working code until a human confirms parity in the browser.

## Project Structure

```
plannotator/
├── apps/
│   ├── hook/                     # Claude Code plugin (no commands/ — core skills installed to ~/.claude/skills act as slash commands)
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json      # PermissionRequest hook config, the SessionStart `compact` reminder hook + "modules" (the Claude Code mod)
│   │   ├── hooks/mod/            # The Claude Code mod: non-blocking plan review/annotate/review/last + Ask this session (see "Claude Code mod")
│   │   ├── tests/                # `claude plugin test` harness tests (scripts/test-claude-code-mod.sh; bun skips them)
│   │   ├── server/index.ts       # Entry point (plan + review + annotate + archive subcommands)
│   │   └── dist/                 # Built single-file apps (index.html, review.html)
│   ├── opencode-plugin/          # OpenCode plugin
│   │   ├── commands/             # Slash command stubs (review, annotate, last — plugin intercepts execution)
│   │   ├── index.ts              # OpenCode 1 entry with submit_plan tool + review/annotate event handlers
│   │   ├── server.ts             # OpenCode 2 adapter (stable @opencode/plugin types; older-host capability fallbacks)
│   │   ├── plannotator-tool.ts   # OpenCode 2 `plannotator` tool + per-session launch record (list/close); see "OpenCode 2: the plannotator tool"
│   │   ├── plannotator.html      # Built plan review app
│   │   └── review-editor.html    # Built code review app
│   ├── amp-plugin/               # Amp plugin
│   │   ├── plannotator.ts        # Native Amp command-palette integration
│   │   └── README.md             # Install and local development notes
│   ├── droid-plugin/             # Droid plugin
│   │   ├── .factory-plugin/plugin.json
│   │   ├── commands/             # Slash command entrypoints
│   │   └── lib/                  # Shared command wrapper helpers
│   ├── marketing/                # Marketing site, docs, and blog (plannotator.ai)
│   │   └── astro.config.mjs      # Astro 5 static site with content collections
│   ├── vibe/                     # Mistral Vibe integration source (consumed by scripts/install.sh; auto-detected via $VIBE_HOME, default ~/.vibe)
│   │   ├── hooks/hooks.toml      # Reference copy of the managed pre_tool hook block install.sh writes into $VIBE_HOME/hooks.toml (macOS/Linux only)
│   │   └── skills/               # Vibe-specific skills (review, annotate, last) with PLANNOTATOR_ORIGIN=mistral-vibe baked in; not installed on Windows
│   ├── kiro-cli/                 # Kiro CLI integration source (consumed by scripts/install.sh; auto-detected via ~/.kiro)
│   │   ├── agents/plannotator.json   # Example Kiro custom agent
│   │   └── skills/               # Kiro-specific skill packages (review, annotate); setup-goal + visual-explainer install from apps/skills/extra
│   ├── paste-service/            # Paste service for short URL sharing
│   │   ├── core/                 # Platform-agnostic logic (handler, storage interface, cors)
│   │   ├── stores/               # Storage backends (fs, kv, s3)
│   │   └── targets/              # Deployment entries (bun.ts, cloudflare.ts)
│   ├── inbox/                    # The Plannotator Inbox window's Vite single-file build (packages/inbox); build:hook copies it to apps/hook/dist/inbox.html, and the phone's surface (build:surface) to apps/hook/dist/surface.html
│   ├── review/                   # Standalone review server (for development)
│   │   ├── diagram-engine/       # Code review's diagram engine, built as separate files the review server serves on demand (see "Diagrams in code review, loaded on demand")
│   │   ├── index.html
│   │   ├── index.tsx
│   │   └── vite.config.ts
│   ├── guides-show/               # guides.show — portable Guided Review viewer (multi-file CDN build) + Cloudflare Worker (viewer/, worker/, share/, build/); the Worker is the only host target, self-hosting = deploying it under your own account
│   ├── relay/                     # The Inbox relay (mobile steps R1, R2, R3): a Cloudflare Worker + one Durable Object per mailbox (src/index.ts, src/mailbox.ts), holding only ciphertext and hashes: pushes, and the phone's reads and answers while it is away; src/apns-h2.ts is a standalone HTTP/2 client for APNs over connect(); src/fcm.ts sends Android pushes through FCM HTTP v1 with plain fetch. Private, own version line, owner-deployed (never from CI; README.md has the deploy); its proof (test/) runs `wrangler dev` in the relay workflow and is skipped by the root `bun test`
│   ├── telemetry/                 # Usage counts for experimental features: a Cloudflare Worker + D1 of daily totals (src/handler.ts; POST /v1/counts, the token-guarded GET /v1/totals, a retention cron). Private, own version line, owner-deployed (never from CI; README.md has the deploy); its proof (test/) runs `wrangler dev` and is skipped by the root `bun test`
│   ├── vscode-extension/         # VS Code extension — opens plans in editor tabs, and the Guides view (Guided Reviews in VS Code; see "Guides in VS Code")
│   │   ├── bin/                   # Router scripts (open-in-vscode, xdg-open)
│   │   ├── src/                   # extension.ts, cookie-proxy.ts, ipc-server.ts, panel-manager.ts, editor-annotations.ts, vscode-theme.ts, guides-loader.ts (loads dist/guides.cjs on first use)
│   │   ├── src/guides/            # Guides: no-vscode modules (acp/, mcp/, sources/, generation.ts, store.ts, dashboard.ts, reader-model.ts, core/adapter.ts) + vscode/ (controller, tree, reader UI, webview host) + webview/ (one browser bundle)
│   │   ├── tests/                 # fake-acp-agent.ts (scripted ACP agent for tests), screenshots/ (headless serve-web driver, manual)
│   │   └── package.json           # Extension manifest (publisher: backnotprop)
│   └── skills/                    # Agent skills (agentskills.io format)
│       ├── core/                  # CORE skills (single-sourced) — installed to ~/.claude/skills and ~/.agents/skills (Codex)
│       │   ├── plannotator/           # Knowledge layer: model-invocable CLI reference (subcommands, flags, exit codes) an agent loads on generic "use Plannotator" intent; freshness-guarded against apps/hook/server/cli.ts by plannotator-skill-reference.test.ts. Unreleased subcommands (`HIDDEN_SUBCOMMANDS` in cli.ts: today `t3` and `t3-hook`, the opt-in T3 Code connection, and `card`, the Board's card call from a shell; `inbox` was the last to launch) still run and keep `<sub> --help`, but stay out of `plannotator --help`, "Did you mean" suggestions and this skill (the test requires their absence); un-hide by deleting from that set, adding the top-level usage lines and documenting it here
│       │   ├── plannotator-review/    # Lightweight: opens review UI
│       │   ├── plannotator-annotate/  # Lightweight: opens annotate UI
│       │   └── plannotator-last/      # Lightweight: annotates last message
│       └── extra/                 # EXTRA skills — NOT default-installed (except Kiro); add via `npx skills add backnotprop/plannotator/apps/skills/extra --global`
│           ├── plannotator-compound/        # Research analysis agent (map-reduce over denied plans)
│           ├── plannotator-setup-goal/      # Goal package scaffolder for /goal workflows
│           └── plannotator-visual-explainer/ # Visual HTML generator (plans, diagrams, PR explainers) with Plannotator theming
├── packages/
│   ├── server/                   # Shared server implementation
│   │   ├── index.ts              # startPlannotatorServer(), handleServerReady()
│   │   ├── review.ts             # startReviewServer(), handleReviewServerReady()
│   │   ├── annotate.ts           # startAnnotateServer(), handleAnnotateServerReady()
│   │   ├── inbox.ts              # startInboxServer(), handleInboxServerReady(): the Plannotator Inbox (Bun-only, loopback-only; see "Plannotator Inbox")
│   │   ├── inbox-mcp.ts          # The Inbox's MCP tools (send_message, read_thread, resolve_message, wait_for_reply, get_guide_brief, submit_guide)
│   │   ├── inbox-tailscale.ts    # "Over your tailnet": `plannotator inbox --tailscale`, the owner-only tailnet listener and its serve mapping (see "Plannotator Inbox")
│   │   ├── storage.ts            # Re-exports from @plannotator/shared/storage
│   │   ├── share-url.ts          # Server-side share URL generation for remote sessions
│   │   ├── remote.ts             # isRemoteSession(), getServerPort()
│   │   ├── browser.ts            # openBrowser()
│   │   ├── draft.ts              # Re-exports from @plannotator/shared/draft
│   │   ├── integrations.ts       # Obsidian, Bear integrations
│   │   ├── ide.ts                # VS Code diff integration (openEditorDiff)
│   │   ├── editor-annotations.ts  # VS Code editor annotation endpoints
│   │   └── project.ts            # Project name detection for tags
│   ├── ui/                       # Shared React components + theme
│   │   ├── theme.css             # Single source of truth for color tokens + Tailwind bridge
│   │   ├── components/           # Viewer, Toolbar, Settings, etc.
│   │   │   ├── icons/            # Shared SVG icon components (themeIcons, etc.)
│   │   │   ├── diagram/          # The diagram engine's viewer (DiagramViewer, DiagramCanvas, DiagramOverlay, DiagramComposer, DiagramSourcePane, DiagramPopout + hooks); DiagramBlock.tsx is the fence side
│   │   │   ├── file-tree/        # Virtualized file tree for large path lists (model.ts index, store.ts, FileTree.tsx); not wired into any screen yet (see "File tree" in guides-and-shared-ui.md)
│   │   │   ├── plan-diff/        # PlanDiffBadge, PlanDiffViewer, clean/raw diff views
│   │   │   └── sidebar/          # SidebarContainer, SidebarTabs, VersionBrowser, ArchiveBrowser
│   │   ├── shortcuts/            # Keyboard shortcut registry (see Keyboard Shortcuts section below)
│   │   │   ├── core.ts           # Engine: parser, formatter, dispatcher, validator
│   │   │   ├── runtime.ts        # Engine: useShortcutScope, useDoubleTapShortcuts hooks
│   │   │   ├── index.ts          # Barrel — re-exports engine + scopes from both subfolders
│   │   │   ├── plan-review/      # Scopes for plan-editor surfaces (annotationMode, annotationPanel, annotationToolbar, commentPopover, documentView, goalSetup, htmlAnnotate, imageAnnotator, inputMethod, sidebar, viewer, vimSelection)
│   │   │   └── code-review/      # Scopes for review-editor surfaces (ai, allFilesDiff, annotationToolbar, fileTree, prComments, suggestionModal, tourDialog)
│   │   ├── shortcuts.test.ts     # Registry unit tests (parser, dispatcher, validator)
│   │   ├── utils/                # parser.ts, sharing.ts, storage.ts, planSave.ts, agentSwitch.ts, planDiffEngine.ts, planAgentInstructions.ts, annotateAgentInstructions.ts
│   │   ├── hooks/                # useAnnotationHighlighter.ts, useSharing.ts, usePlanDiff.ts, useSidebar.ts, useLinkedDoc.ts, useAnnotationDraft.ts, useCodeAnnotationDraft.ts, useArchive.ts
│   │   └── types.ts
│   ├── ai/                       # Provider-agnostic AI backbone (providers, sessions, endpoints)
│   ├── core/                     # @plannotator/core — browser-safe, zero-dep universal slice (pure utils + types) shared by ui + shared; published so @plannotator/ui can be installed standalone. `shared` re-exports the moved modules via one-line shims so Plannotator is unchanged.
│   ├── shared/                   # Node/git/server logic + cross-runtime types (re-exports browser-safe modules from @plannotator/core)
│   │   ├── storage.ts            # Plan saving, version history, archive listing (node:fs only)
│   │   ├── draft.ts              # Annotation draft persistence (node:fs only)
│   │   ├── project.ts            # Pure string helpers (sanitizeTag, extractRepoName, extractDirName)
│   │   └── inbox/                # The Inbox store (store.ts, append-only JSONL; thread routing), the per-thread list sections (list.ts), layout + line reader (schema.ts), registry (registry.ts: inbox/inbox.json)
│   ├── inbox/                    # The Plannotator Inbox window (App, sidebar, list, thread, empty state, Settings), composed from ui, and surface/ (what a phone hosts); built by apps/inbox
│   ├── t3-code/                  # @plannotator/t3-code — the opt-in T3 Code connection (Ask this session through a Claude Bash hook); loaded by the CLI only for `t3` / `t3-hook` (see "T3 Code")
│   ├── guide-viewer/             # @plannotator/guide-viewer — the Guided Review chain (GuideView → GuideSectionCard → GuideFileCard → GuideViewportManager) behind a narrow GuideHost context; used by review-editor (ReviewGuideHost + AllFilesCodeView) and by the guides.show viewer (readOnly). Also home of diffParser, DiffFile, and the two markdown renderers.
│   ├── editor/                   # Plan review app
│   │   ├── App.tsx               # Main plan review app
│   │   └── shortcuts.ts          # planReviewSurface + annotateSurface — composes plan-review scopes into per-surface registries
│   └── review-editor/            # Code review UI
│       ├── App.tsx               # Main review app
│       ├── shortcuts.ts          # codeReviewSurface — composes code-review scopes into the review registry
│       ├── components/           # DiffViewer, FileTree, ReviewSidebar
│       ├── dock/                 # Dockview center panel infrastructure
│       ├── demoData.ts           # Demo diff for standalone mode
│       └── index.css             # Review-specific styles
├── .claude-plugin/marketplace.json  # For marketplace install
└── legacy/                       # Old pre-monorepo code (reference only)
```

## Server Runtimes

There are two separate server implementations with the same API surface:

- **Bun server** (`packages/server/`) — used by both Claude Code (`apps/hook/`) and OpenCode (`apps/opencode-plugin/`). These plugins import directly from `@plannotator/server`.
- **Pi server** (`apps/pi-extension/server/`) — a standalone Node.js server for the Pi extension. It mirrors the Bun server's API but uses `node:http` primitives instead of Bun's `Request`/`Response` APIs.

When adding or modifying server endpoints, both implementations must be updated. Runtime-agnostic logic (store, validation, types) lives in `packages/shared/` and is imported by both.

**Exception: the Plannotator Inbox.** The Inbox server (`packages/server/inbox.ts`, `plannotator inbox`) is Bun-only and lives in the compiled binary. Pi and OpenCode are its clients, never its hosts, so it has no `node:http` mirror; its routes change in one place. See "Plannotator Inbox".

## Installation

**Via plugin marketplace** (when repo is public):

```
/plugin marketplace add backnotprop/plannotator
```

**Local testing:**

```bash
claude --plugin-dir ./apps/hook
```

## Requirements

- Bun runtime
- Claude Code with plugin/hooks support, or OpenCode
- Cross-platform: macOS (`open`), Linux (`xdg-open`), Windows (`start`)

## Development

```bash
bun install

# Run any app
bun run dev:hook       # Hook server (plan review)
bun run dev:review     # Review editor (code review)
bun run dev:portal     # Portal editor
bun run dev:marketing  # Marketing site
bun run dev:vscode     # VS Code extension (watch mode)
```

**Local `plannotator` command:** run `bun link` once in the checkout to make the global `plannotator` command use this repo's source (`apps/hook/server/index.ts`) instead of an installed release binary. Commands like `plannotator review` then reflect local changes immediately. Rebuild the bundled HTML when changing UI code (see Build below).

## Testing Rules

A test must guard a behavior that can actually regress. Before writing one, name the failure it catches; if you can't, don't write it.

- **Pin copy only on purpose, never as a snapshot.** Locking a short user-facing string is legitimate when it is a deliberate decision — an action label ("Approve"), a command name, a legally/UX-critical phrase the maintainer wants frozen so agents can't drift it. Mark it as such in a comment. What is banned is incidentally snapshotting explanatory prose (intro dialogs, setting descriptions, empty-state copy) with `toBe` just because it was on screen when the test was written — that couples wording edits to test churn while guarding nothing. If such a string carries data that must stay truthful (a server-computed size, a language list, a version), assert those facts with `toContain` on the data, not the sentence around them.
- **No round-trip prop tests.** Asserting that a hardcoded string passed as a prop appears in the DOM verifies nothing — any string round-trips. If the only thing worth checking is "this prop renders somewhere," use a sentinel string and one assertion, and say so in a comment.
- **Assert behavior, not implementation echo.** A test that restates what the code obviously does (calls X with Y, sets state to Z) without exercising an observable outcome is noise; it breaks on refactors and catches nothing.
- **Bun runs every test file in one process.** Never mutate `process.env`, `~/.plannotator`, or any global at module scope; mutate inside tests with restore in `finally`/`afterEach`, and sandbox all server/data-dir interaction under a temp `PLANNOTATOR_DATA_DIR`. Never read or write the real user config.
- **Tests and dev scripts never reach the real Inbox or data dir.** Bun reads only the `bunfig.toml` of the folder `bun test` runs from, so the preload sandbox is mirrored into every folder people run tests from (`tests/package-bunfig.test.ts`), and the Inbox test helpers sandbox on import as well (`tests/setup/sandbox-data-dir.ts` does what the preload does: `PLANNOTATOR_DATA_DIR` becomes a fresh temp folder unless it already is a scratch folder, inside the OS temp dir or `/tmp` or the `PLANNOTATOR_TEST_SANDBOX` the preload marks). Only scratch folders count because a relocated data dir (`PLANNOTATOR_DATA_DIR=/custom` in the person's shell) is just as real as `~/.plannotator`; `tests/helpers/real-data-dir.ts` also works out the default like the product does, for both `$HOME` and the account's own home, `$XDG_DATA_HOME` included. Dev scripts that start an Inbox (`scripts/dast/target.ts`, `scripts/inbox-sim.ts`, `tests/helpers/inbox-dom-server.ts`) accept only a scratch data dir, and point `PLANNOTATOR_DATA_DIR` at it (the Inbox reads `config.json` through the env even when given `dataDir`). Signal an Inbox only through `tests/helpers/inbox-process.ts` (or `signalInbox` / `stopInbox` in `tests/helpers/inbox-world.ts`, `stopScratchInbox` in the e2e specs), never `process.kill` on a pid read from a registry; write `apps/hook/dist` stubs only with `tests/helpers/hook-dist-stub.ts`, which removes exactly the stubs it wrote and never the folder. `tests/never-touch-the-real-inbox.test.ts` scans every test and script (`tests/helpers/real-inbox-scan.ts`, comments stripped) for a signal in Inbox code (`process.kill`, a `kill`/`pkill` spawn or shell string, `kill` taken off `process`; a test's own non-Inbox child may carry an `inbox-guard: own child` comment), a path from the home dir to `.plannotator` (any line, a multi-line `join`, a variable from `homedir()`, the literal `~/.plannotator` used as a path), and a `startInboxServer` call without `dataDir` (or, in a script, without pointing `PLANNOTATOR_DATA_DIR` at it). The proof (`provenInbox`) also requires the test's folder to be a scratch folder and the Inbox's working directory inside it whenever it can be read.
- **Tests and dev scripts never open a browser, and never with a sentinel.** Set `NO_BROWSER` from `tests/helpers/no-browser.ts` (an absolute path to a program that exits at once: `/usr/bin/true`, `/bin/true` or `true` on PATH; `whoami.exe` on Windows), never `PLANNOTATOR_BROWSER=none` (or `true`, `false`, `0`, `1`, `:`). A current build opens nothing for those values, but a binary from before that change (the version matrix, an older installed `plannotator` a test may reach) reads them as unset (#756) and opens the system default, i.e. real tabs on the developer's screen; and a mistake in the "none" handling itself would do the same. The bun test preload sets `NO_BROWSER` for every test and every child that inherits the env; a spec or helper that builds a child env from scratch sets it itself. `tests/no-browser-sentinel.test.ts` scans tests, scripts, `package.json` files and the workflows for a sentinel value (`tests/helpers/no-browser-scan.ts`); a line that tests the sentinel handling (in process, or in a child whose PATH holds only stand-in openers, as `packages/server/browser-intent-launch.test.ts` does) may carry a `no-browser-guard: sentinel under test` comment.
- **Tests never run the real GitHub CLI.** The first bun test preload (`tests/setup/gh-tripwire.ts`, in every bunfig) puts a tripwire `gh` first on PATH that logs the call and exits 1 without running gh, points `GH_CONFIG_DIR` at an empty scratch folder, sets `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` to a fake token (with no token in its environment or config gh reads the system keyring, so an empty config alone does not stop it) and unsets `GITHUB_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`; its global `afterEach` fails the test during which the tripwire ran (code under test usually reads a failing gh as "not signed in", so the exit code alone would pass). Emptying `process.env.PATH` is no guard: Bun resolves `Bun.spawn` / `Bun.spawnSync` (and node's sync spawns, built on it) called without `env` on the PATH, and hands the child the environment, the process started with, so the preload makes those, and `Bun.which`, default to the current `process.env` (Bun Shell `$` still looks commands up on the startup PATH). Two gaps the log does not catch, where only the config and fake-token scrub protect the run: a test that sets `process.env.PATH` to a fixed value drops the tripwire, and on Windows the tripwire is `gh.cmd`, which a spawn that bypasses the shell may skip for a real `gh.exe` later on PATH. A test that needs gh injects a fake: the review servers' `setPRCommandRuntimeForTests` (`packages/server/pr.ts`, `apps/pi-extension/server/pr.ts`) with `tests/helpers/fake-pr-runtime.ts`, or a fake `gh` first on the PATH of the process it spawns. `tests/gh-tripwire.test.ts` proves the tripwire.

## Build

```bash
bun run build:hook       # Single-file HTML for hook server
bun run build:review     # Code review editor
bun run build:opencode   # OpenCode plugin (copies HTML from hook + review)
bun run build:portal     # Static build for share.plannotator.ai
bun run build:marketing  # Static build for plannotator.ai
bun run build:vscode     # VS Code extension bundle
bun run package:vscode   # Package .vsix for marketplace
bun run build            # Build hook + opencode (main targets)
```

**Important: Tailwind `@source` paths.** When creating new directories that contain `.tsx` files with Tailwind classes, add a matching `@source` entry to the app's `index.css`. Tailwind only generates CSS for classes it finds in scanned files — missing paths means classes appear in the DOM but have no effect.

**Important: Build order matters.** The hook build (`build:hook`) copies pre-built HTML from `apps/review/dist/`. If you change UI code in `packages/ui/`, `packages/editor/`, or `packages/review-editor/`, you **must** rebuild the review app first, then the hook:

```bash
bun run --cwd apps/review build && bun run build:hook   # For review UI changes
bun run build:hook                                       # For plan UI changes only
bun run build:hook && bun run build:opencode             # For OpenCode plugin
```

Running only `build:hook` after review-editor changes will copy stale HTML files. When testing locally with a compiled binary, the full sequence is:

```bash
bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
  --define "__CLI_VERSION__=\"0.0.0-dev\"" --outfile ~/.local/bin/plannotator
```

These are the flags `.github/workflows/release.yml` compiles with; without the `__CLI_VERSION__` define `plannotator --version` falls back to `plannotator dev` and the binary cannot be told apart from any other local build. On macOS build with bun >= 1.3.14 (what CI pins): 1.3.12 loses the linker signature and the compiled binary is SIGKILLed on launch with no error (#541).

Running only `build:opencode` will copy stale HTML files.

## Marketing Site

`apps/marketing/` is the plannotator.ai website — landing page, documentation, and blog. Built with Astro 5 (static output, zero client JS except a theme toggle island). Docs are markdown files in `src/content/docs/`, blog posts in `src/content/blog/`, both using Astro content collections. Tailwind CSS v4 via `@tailwindcss/vite`. Deploys to S3/CloudFront via GitHub Actions on push to main.

The `/docs/reference/keyboard-shortcuts` page is auto-generated from the shortcut registry at build time — see the Keyboard Shortcuts section above. Editing the markdown body has no effect; update the scope files instead.

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
