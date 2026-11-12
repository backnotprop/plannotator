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
│   │   ├── commands/             # Slash command stubs (review, annotate, last, inbox — plugin intercepts execution)
│   │   ├── index.ts              # OpenCode 1 entry with submit_plan tool + review/annotate event handlers
│   │   ├── server.ts             # OpenCode 2 adapter (stable @opencode/plugin types; older-host capability fallbacks)
│   │   ├── plannotator-tool.ts   # OpenCode 2 `plannotator` tool + per-session launch record (list/close); see "OpenCode 2: the plannotator tool"
│   │   ├── plannotator.html      # Built plan review app
│   │   └── review-editor.html    # Built code review app
│   ├── amp-plugin/               # Amp plugin
│   │   ├── plannotator.ts        # Native Amp command-palette integration
│   │   └── README.md             # Install and local development notes
│   ├── cline-plugin/             # Cline plugin (@plannotator/cline): the Inbox tool and the reply wake (inbox.ts), built to dist/index.js
│   ├── droid-plugin/             # Droid plugin
│   │   ├── .factory-plugin/plugin.json
│   │   ├── commands/             # Slash command entrypoints
│   │   └── lib/                  # Shared command wrapper helpers
│   ├── dsh-plugin/               # DeepSeek Harness plugin (@plannotator/dsh): plan review, the Inbox, and the plannotator tool and /plannotator-* commands
│   │   ├── index.ts              # Cordis plugin entry (`name` + `apply`), delegating to plugin.ts
│   │   ├── plugin.ts             # Prepends a `user-questions/request` listener; starts the Inbox connection in an inject([agents, tools]) child
│   │   ├── inbox.ts              # plannotator_inbox tool and the reply wake (followup / steer), over the shared agent-link.ts (relative imports)
│   │   ├── tool.ts               # The plannotator tool (off by default) and the /plannotator-review, -annotate, -last commands
│   │   ├── reviews.ts            # Non-blocking CLI children for those; each decision goes back with agent.followup
│   │   ├── plan-review.ts        # Answers exit_plan_mode's plan-review question via `plannotator dsh-plan`; anything else, or any failure, goes to DSH's own card
│   │   ├── cli.ts                # Finds the plannotator binary; runs the `dsh-plan` round trip (abort kills the child)
│   │   └── cordis.patch.yml      # The bundle patch row DSH's plugin manager applies on install
│   ├── marketing/                # Marketing site, docs, and blog (plannotator.ai)
│   │   └── astro.config.mjs      # Astro 5 static site with content collections
│   ├── vibe/                     # Mistral Vibe integration source (consumed by scripts/install.sh; auto-detected via $VIBE_HOME, default ~/.vibe)
│   │   ├── hooks/hooks.toml      # Reference copy of the managed pre_tool hook block install.sh writes into $VIBE_HOME/hooks.toml (macOS/Linux only)
│   │   └── skills/               # Vibe-specific skills (review, annotate, last) with PLANNOTATOR_ORIGIN=mistral-vibe baked in; not installed on Windows
│   ├── qwen-code/                # Qwen Code integration source (see "Qwen Code plan review" in plan-review.md)
│   │   ├── extension/            # The `plannotator` Qwen extension: hooks/hooks.json (PermissionRequest on exit_plan_mode, PreToolUse on enter_plan_mode); no skills
│   │   └── skills/               # Qwen-specific review, annotate, last (run with is_background; copied to $QWEN_HOME/skills, where they win over the ~/.agents/skills copies)
│   ├── kiro-cli/                 # Kiro CLI integration source (consumed by scripts/install.sh; auto-detected via ~/.kiro)
│   │   ├── agents/plannotator.json   # Example Kiro custom agent
│   │   └── skills/               # Kiro-specific skill packages (review, annotate); setup-goal + visual-explainer install from apps/skills/extra
│   ├── feedback-service/         # Product feedback: a Cloudflare Worker + D1 with one route, POST /feedback, that only inserts (no read route; the owner reads in the dashboard or with `bun run db:read`). Owner-deployed (never from CI; live at plannotator-feedback.plannotator.workers.dev, D1 `plannotator-feedback`); its tests (test/) run in the root `bun test` against an in-memory store
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
│   ├── vscode-extension/         # VS Code extension — opens plans in editor tabs, and the Guides view (Guided Reviews in VS Code; see "Guides in VS Code")
│   │   ├── bin/                   # Router scripts (open-in-vscode, xdg-open)
│   │   ├── src/                   # extension.ts, cookie-proxy.ts, ipc-server.ts, panel-manager.ts, editor-annotations.ts, vscode-theme.ts, guides-loader.ts (loads dist/guides.cjs on first use)
│   │   ├── src/guides/            # Guides: no-vscode modules (acp/, mcp/, sources/, generation.ts, store.ts, dashboard.ts, reader-model.ts, core/adapter.ts) + vscode/ (controller, tree, reader UI, webview host) + webview/ (one browser bundle)
│   │   ├── tests/                 # fake-acp-agent.ts (scripted ACP agent for tests), screenshots/ (headless serve-web driver, manual)
│   │   └── package.json           # Extension manifest (publisher: backnotprop)
│   └── skills/                    # Agent skills (agentskills.io format)
│       ├── core/                  # CORE skills (single-sourced) — installed to ~/.claude/skills and ~/.agents/skills (Codex)
│       │   ├── plannotator/           # Knowledge layer: model-invocable CLI reference (subcommands, flags, exit codes) an agent loads on generic "use Plannotator" intent; freshness-guarded against apps/hook/server/cli.ts by plannotator-skill-reference.test.ts. Unreleased subcommands (`HIDDEN_SUBCOMMANDS` in cli.ts: today `t3-hook`, the opt-in T3 Code connection's hook helper, `shape`, and `system`, System's drawing commands; `t3` was the last to launch) still run and keep `<sub> --help`, but stay out of `plannotator --help`, "Did you mean" suggestions and this skill (the test requires their absence); un-hide by deleting from that set, adding the top-level usage lines and documenting it here
│       │   ├── plannotator-review/    # Lightweight: opens review UI
│       │   ├── plannotator-annotate/  # Lightweight: opens annotate UI
│       │   ├── plannotator-last/      # Lightweight: annotates last message
│       │   └── plannotator-inbox/     # Lightweight: opens the Inbox (plannotator inbox --open), says its address and briefs the agent on the Inbox; also the Kiro and Vibe copy
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
│   │   ├── inbox-mcp.ts          # The Inbox's MCP tools (send_message, read_thread, resolve_message, get_guide_brief, submit_guide)
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
│   ├── references/               # @plannotator/references — published, Apache-2.0: the read side of reference integrations (URL grammars, registry, GitHub/GitLab/Linear read adapters) behind one credential port; never reads env or runs auth. Cut from Workspaces: see its PROVENANCE.md
│   ├── system/                   # @plannotator/system: System, a living drawing of a codebase. Format 1 and its loader, `check` (every cited path exists), and the gate (which changes may make a drawing stale). No UI and no Inbox wiring yet; `plannotator system` (apps/hook/server/system-command.ts) is its command; its tests keep Plannotator's own drawing as a fixture in `test/fixtures/plannotator/`; see its README.md
│   ├── acp-client/               # @plannotator/acp-client — the ACP client (client, agent table, spawn plan, ensure-launch, own-tool permission policy, same-program check, which); used by Guides in VS Code
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

**Exception: the Shapes server.** The standalone Shape page's server (`packages/server/shape.ts`, started by `plannotator shape open`) is Bun-only for the same reason: it lives in the compiled binary, and Pi users reach it through the same `plannotator shape open`. It mounts the shared Shape routes (`packages/shared/shape/routes.ts`), which Pi also has (`apps/pi-extension/server/serverShape.ts`, not mounted), so a change to those routes still goes into both; only the server around them is in one place. See "Shape" in `guides-and-shared-ui.md`.

## Installation

**Via plugin marketplace** (when repo is public):

```
/plugin marketplace add backnotprop/plannotator
```

**Local testing:**

```bash
claude --plugin-dir ./apps/hook
```

**The installers' binary download** (`scripts/install.sh` `download_release_binary`, `install.ps1` `Invoke-ResumableDownload`, `install.cmd` `:DownloadBinary`; keep the three in step) continues where a dropped or stalled connection stopped, instead of starting the ~200 MB binary again from zero. Each attempt asks the github.com URL again (it redirects to a signed URL that expires within the hour, so a redirected URL is never reused) and, after the first, asks only for the rest of the file (`curl -C -`, an HTTP Range request on PowerShell). curl's own `--retry` is not used for the binary: it throws away the bytes of the attempt it retries. Bounds: at most 30 attempts, at most 4 in a row that add no bytes, 2 s apart, 6 hours in all; a stall (below 1 byte/s for 60 s, or 60 s without data on PowerShell) ends an attempt and the next continues. A server that answers a Range with the whole file gets the file again from zero; after an HTTP/2 error (curl 92) the attempts go over HTTP/1.1. The SHA-256 check (the release's `.sha256`, or `PLANNOTATOR_EXPECTED_SHA256` from the updater) still covers the whole file before the atomic swap, and a failed download removes its partial file. `install.ps1` uses `HttpWebRequest` (what `Invoke-WebRequest` uses on Windows PowerShell 5.1, so the same proxy and TLS settings) and, if that gives up, runs its earlier `Invoke-WebRequest` download (4 attempts, no progress bar) as a last resort. The `.sha256` keeps its own short download (120 s, curl's `--retry 3`). Tests: `scripts/install-download.test.ts` (a local server that redirects, cuts, stalls, ignores the Range or sends the wrong bytes; install.sh with the real curl, install.ps1 under pwsh, and on Windows under Windows PowerShell 5.1, install.cmd under cmd.exe) and the `#2788` block of `scripts/install.test.ts`.

## Requirements

- Bun runtime (>= 1.4.4 to compile binaries; `scripts/require-bun.ts` checks it)
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

**Plan page load benchmark:** after a build, `bun run bench:plan-load` (`scripts/bench-plan-load.mjs`, run with Bun for its `packed-app.ts` import) serves `apps/hook/dist/index.html` as the CLI does (the page, and its packed chunks under `/assets/`) with a sample Pi `/api/plan` response, loads it in an isolated headless Chrome (fresh profile, 1280x900, external hosts blocked, cache cleared before each run), and reports the time until the plan and the Approve button are usable, plus navigation timings, script and long-task time, bytes (the document and the total with its chunks) and heap. `--runs N`, `--json`, `--gzip`, `--html <path>` to compare another build, `--chrome <path>` or `CHROME_PATH`. It is a dev script: CI and `bun test` never run it.

## Testing Rules

A test must guard a behavior that can actually regress. Before writing one, name the failure it catches; if you can't, don't write it.

- **Pin copy only on purpose, never as a snapshot.** Locking a short user-facing string is legitimate when it is a deliberate decision — an action label ("Approve"), a command name, a legally/UX-critical phrase the maintainer wants frozen so agents can't drift it. Mark it as such in a comment. What is banned is incidentally snapshotting explanatory prose (intro dialogs, setting descriptions, empty-state copy) with `toBe` just because it was on screen when the test was written — that couples wording edits to test churn while guarding nothing. If such a string carries data that must stay truthful (a server-computed size, a language list, a version), assert those facts with `toContain` on the data, not the sentence around them.
- **No round-trip prop tests.** Asserting that a hardcoded string passed as a prop appears in the DOM verifies nothing — any string round-trips. If the only thing worth checking is "this prop renders somewhere," use a sentinel string and one assertion, and say so in a comment.
- **Assert behavior, not implementation echo.** A test that restates what the code obviously does (calls X with Y, sets state to Z) without exercising an observable outcome is noise; it breaks on refactors and catches nothing.
- **Run test files with `bun run test:sandbox <file…> [-- runner flags]`** (`scripts/test-sandbox.ts`), not an env built by hand: the runner starts with a scratch HOME, data dir and TMPDIR, no browser, port 59812 refused; e2e specs go to Playwright, DOM files get `DOM_TESTS=1`.
- **Bun runs every test file in one process.** Never mutate `process.env`, `~/.plannotator`, or any global at module scope; mutate inside tests with restore in `finally`/`afterEach`, and sandbox all server/data-dir interaction under a temp `PLANNOTATOR_DATA_DIR`. Never read or write the real user config.
- **Tests and dev scripts never reach the real Inbox or data dir.** Bun reads only the `bunfig.toml` of the folder `bun test` runs from, so the preload sandbox is mirrored into every folder people run tests from (`tests/package-bunfig.test.ts`), and the Inbox test helpers sandbox on import as well (`tests/setup/sandbox-data-dir.ts` does what the preload does: `PLANNOTATOR_DATA_DIR` becomes a fresh temp folder unless it already is a scratch folder, inside the OS temp dir or `/tmp` or the `PLANNOTATOR_TEST_SANDBOX` the preload marks). Only scratch folders count because a relocated data dir (`PLANNOTATOR_DATA_DIR=/custom` in the person's shell) is just as real as `~/.plannotator`; `tests/helpers/real-data-dir.ts` also works out the default like the product does, for both `$HOME` and the account's own home, `$XDG_DATA_HOME` included. Dev scripts that start an Inbox (`scripts/dast/target.ts`, `scripts/inbox-sim.ts`, `tests/helpers/inbox-dom-server.ts`) accept only a scratch data dir, and point `PLANNOTATOR_DATA_DIR` at it (the Inbox reads `config.json` through the env even when given `dataDir`). Signal an Inbox only through `tests/helpers/inbox-process.ts` (or `signalInbox` / `stopInbox` in `tests/helpers/inbox-world.ts`, `stopScratchInbox` in the e2e specs), never `process.kill` on a pid read from a registry; write `apps/hook/dist` stubs only with `tests/helpers/hook-dist-stub.ts`, which removes exactly the stubs it wrote and never the folder. `tests/never-touch-the-real-inbox.test.ts` scans every test and script (`tests/helpers/real-inbox-scan.ts`, comments stripped) for a signal in Inbox code (`process.kill`, a `kill`/`pkill` spawn or shell string, `kill` taken off `process`; a test's own non-Inbox child may carry an `inbox-guard: own child` comment), a path from the home dir to `.plannotator` (any line, a multi-line `join`, a variable from `homedir()`, the literal `~/.plannotator` used as a path), and a `startInboxServer` call without `dataDir` (or, in a script, without pointing `PLANNOTATOR_DATA_DIR` at it). The proof (`provenInbox`) also requires the test's folder to be a scratch folder and the Inbox's working directory inside it whenever it can be read. A spawned Inbox or binary needs a scratch `HOME` in its env, because with none `os.homedir()` falls back to the account's home. Under `PLANNOTATOR_TEST_SANDBOX` the Inbox, `inbox mcp` and the review server refuse a missing or real one, or a scratch one set after start while `os.homedir()` is still real (`packages/server/test-home-guard.ts`), `SimAgent.connect` refuses it with or without the flag, and the bun preload points both `HOME` and `os.homedir()` at a scratch folder.
- **Tests never read the real skill folders.** Under `PLANNOTATOR_TEST_SANDBOX`, `resolveGlobalSkillRoots` (`packages/server/review-skill-loader.ts`, vendored to Pi) keeps only skill folders inside a temp folder, so seed skills under a scratch HOME or scratch `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `XDG_CONFIG_HOME`. A composer fetches the list when it mounts, so a server a test starts with its own env needs that variable or a scratch HOME; without either, the real folders are read.
- **jj tests get their own config folder.** jj writes a `<config dir>/jj/repos/<id>/` entry for every repo it opens, and its config dir is `$XDG_CONFIG_HOME` (else `$HOME/.config`); `JJ_CONFIG` does not move it. A test file that runs jj calls `useScratchJjConfig()` from `tests/helpers/jj-scratch-config.ts` and passes its `env()` to its own jj spawns. The helper points `XDG_CONFIG_HOME` at a temp folder for the file, so the review runtimes' jj children inherit it. `tests/jj-scratch-config.test.ts` checks where jj puts the repo config, and fails on a test file that spawns jj without the helper.
- **Tests and dev scripts never open a browser, and never with a sentinel.** Set `NO_BROWSER` from `tests/helpers/no-browser.ts` (an absolute path to a program that exits at once: `/usr/bin/true`, `/bin/true` or `true` on PATH; `whoami.exe` on Windows), never `PLANNOTATOR_BROWSER=none` (or `true`, `false`, `0`, `1`, `:`). A current build opens nothing for those values, but a binary from before that change (the version matrix, an older installed `plannotator` a test may reach) reads them as unset (#756) and opens the system default, i.e. real tabs on the developer's screen; and a mistake in the "none" handling itself would do the same. The bun test preload sets `NO_BROWSER` for every test and every child that inherits the env; a spec or helper that builds a child env from scratch sets it itself. `tests/no-browser-sentinel.test.ts` scans tests, scripts, `package.json` files and the workflows for a sentinel value (`tests/helpers/no-browser-scan.ts`); a line that tests the sentinel handling (in process, or in a child whose PATH holds only stand-in openers, as `packages/server/browser-intent-launch.test.ts` does) may carry a `no-browser-guard: sentinel under test` comment.
- **Tests never run the real GitHub CLI.** The first bun test preload (`tests/setup/gh-tripwire.ts`, in every bunfig) puts a tripwire `gh` first on PATH that logs the call and exits 1 without running gh, points `GH_CONFIG_DIR` at an empty scratch folder, sets `GH_TOKEN` and `GH_ENTERPRISE_TOKEN` to a fake token (with no token in its environment or config gh reads the system keyring, so an empty config alone does not stop it) and unsets `GITHUB_TOKEN` and `GITHUB_ENTERPRISE_TOKEN`; its global `afterEach` fails the test during which the tripwire ran (code under test usually reads a failing gh as "not signed in", so the exit code alone would pass). Emptying `process.env.PATH` is no guard: Bun resolves `Bun.spawn` / `Bun.spawnSync` (and node's sync spawns, built on it) called without `env` on the PATH, and hands the child the environment, the process started with, so the preload makes those, and `Bun.which`, default to the current `process.env` (Bun Shell `$` still looks commands up on the startup PATH). Two gaps the log does not catch, where only the config and fake-token scrub protect the run: a test that sets `process.env.PATH` to a fixed value drops the tripwire, and on Windows the tripwire is `gh.cmd`, which a spawn that bypasses the shell may skip for a real `gh.exe` later on PATH. A test that needs gh injects a fake: the review servers' `setPRCommandRuntimeForTests` (`packages/server/pr.ts`, `apps/pi-extension/server/pr.ts`) with `tests/helpers/fake-pr-runtime.ts`, or a fake `gh` first on the PATH of the process it spawns. `tests/gh-tripwire.test.ts` proves the tripwire.
- **A new browser spec needs no edit to `tests/e2e/playwright.config.ts`.** Every `tests/e2e/*.spec.ts` runs in its `chromium` project; a spec named `*-webkit.spec.ts` runs in its `webkit` project only. Describe the spec in its own header comment, never in the config. The config lists only the exceptions: `OWN_CONFIG` holds a spec that another config runs (the thread parity harness), and the `webkit` project also runs `toolstrip-rtl.spec.ts`.
- **Tests never run a real agent CLI.** The servers look agent CLIs up on their PATH. For example, the Inbox's Codex wake (`packages/server/inbox-codex-wake.ts`) runs `codex --version` and `codex queue` when the person answers a Codex session that sent with a wake. When no `codex` is on PATH, on macOS it falls back to the absolute paths of the ChatGPT and Codex apps' own CLIs. `PLANNOTATOR_TEST_SANDBOX` in an Inbox's environment gives it an empty agent PATH and skips those app CLIs. The bun preload sets it for every bun test. A scratch Inbox you start by hand or from a dev script needs it too, with a scratch `HOME`, because the flag refuses a real one: every window runs `cswap list --json`, and a temp `PLANNOTATOR_DATA_DIR` alone keeps the real PATH. In e2e, three things guard:
  - The Playwright configs' global setup (`tests/e2e/agent-cli-stubs.ts`, which `tests/e2e/global-setup.ts` runs for `playwright.config.ts` and `inbox-thread-parity.config.ts` names itself) puts recording stubs first on the runner's PATH, for every agent CLI a server can look up or spawn. A spec that passes `process.env.PATH` on finds a stub, never the real CLI, and never reaches the app fallback. Any stub call fails the run, except `cswap list --json`: every Inbox window makes that call, and the stub answers it as not installed.
  - A spec that builds its own PATH gives that Inbox `PLANNOTATOR_TEST_SANDBOX` and a scratch `HOME` (`inbox-tour.spec.ts`, `inbox-tailscale.spec.ts`, `inbox-phones.spec.ts`, `inbox-decision-mode.spec.ts`).
  - Three specs need the agents they set up under HOME found, so they cannot use the sandbox: `inbox-first-run.spec.ts`, `inbox-agents.spec.ts` and `inbox.spec.ts` (its Settings → Agents). The sandbox's agent home would hide those agents. Their PATH holds only their own folder or fakes and `/usr/bin:/bin`. The app fallback is still open there, but no Codex session in those specs sends with a wake. `inbox-accounts.spec.ts` and `inbox-accounts-peek.spec.ts` need their fake `cswap` found, so they cannot use the sandbox either: their PATH is that fake's folder alone.

  `tests/agent-cli-stubs.test.ts` checks three things. The stub list must cover the registries: `AGENT_SPECS`, `MARKER_ENGINES`, uninstall's commands, the agent terminal's `BUILT_IN_AGENTS`, and every literal `which` / `onPath` name. Every e2e PATH literal must keep `process.env.PATH` or set the sandbox. A CLI test in `apps/hook/server` that starts the Inbox must not hand its child `PATH: process.env.PATH`.

  In bun tests, a child env built from scratch does not inherit the preload's sandbox. A test that starts an Inbox that way calls `stubbedAgentClis()` from `tests/helpers/agent-cli-guard.ts` once per file, below its cleanup hooks, and spreads its `env` in place of `PATH: process.env.PATH`: the same stubs, `bun`, the `gh` tripwire and `/usr/bin:/bin`, plus the sandbox. A stub call fails the test.

  **Test files that start a real agent on purpose, so run them only when you mean to:** `apps/pi-extension/inbox.test.ts` starts the installed Pi package from `node_modules` under a temp world whenever Node 22.19+ is on PATH, so a plain `bun test` runs it. Its model is a scripted local endpoint, so no provider is called. The others are opt-in: `apps/pi-extension/inbox-reload.test.ts` (`PLANNOTATOR_RELOAD_PROOF=1`), `apps/pi-extension/omp.test.ts` (`PLANNOTATOR_OMP_BIN`), `apps/opencode-plugin/inbox-v2.test.ts` and `inbox-reload-v2.test.ts` (`OPENCODE2_BIN`), `scripts/test-claude-code-mod.sh` (`claude plugin test`) and `tests/manual/inbox-ask-claude.ts`.

### CI tiers

Every PR push runs the fast tier: the Test workflow (below), Security and the Browser smoke (`browser-smoke.yml`, below). The heavy tier runs on a PR only once it has the `ci:full` label: the Windows workflow (`windows.yml`), the Release dry run, and the Inbox Pi, Claude Code and relay workflows (those three still only when their paths change). Adding the label starts the heavy tier on the current head, and every later push runs it again; removing it does nothing. A push to main runs only Test and Security: the merge train already ran the heavy tier on the tree it merges. The heavy workflows run on main nightly (`schedule`, from 07:17 UTC, a few minutes apart) and on `workflow_dispatch`, and a release dispatches them on main before the tag (`.agents/skills/release/SKILL.md`). A tag runs the whole Release workflow. Each heavy workflow ends in a `Full CI (all green)` job that passes only when every job of that workflow ran and succeeded, since a skipped job otherwise looks green. The merge train adds `ci:full` to its own train PRs and merges only when the fast-tier checks and every `Full CI (all green)` check succeeded. **Do not add `ci:full` to your own PR**: each labeled push reruns the whole heavy tier. Add it only when you need the heavy suites to debug a failure. `scripts/ci-full-tier.test.ts` fails when a heavy job is missing from its workflow's gate or ignores the label, when a heavy workflow runs on a push to main or loses its nightly run, when a fast workflow reruns on a label, when the browser smoke stops running on every PR, or when the full browser suite loses its runs on main, its head check, its blame job or its PR labels.

**The full browser suite runs on main, not on PRs** (the owner, 2026-11-08). The Inbox window e2e (`inbox-e2e.yml`, every Playwright spec on 16 shards, about 20 to 30 minutes) no longer runs on every PR, and `ci:full` does not start it:

- **Every PR** runs the Browser smoke: one job that builds the apps and the binary on the runner while the Playwright image is pulled, then runs `SMOKE_SPECS` (`scripts/ci-e2e-shard.ts smoke`) in that image with the shards' user and flags (`scripts/ci-e2e-in-image.sh`), about 5 minutes in all. The smoke specs are `inbox.spec.ts` (the agents' threads land in the list, a row opens the thread, picks and words go out with Send and the agent reads them, Settings opens and saves) and `inbox-message-comments.spec.ts` (a comment on words in an agent's message, sent and read back). They are whole spec files because both are serial specs whose tests build on each other. Keep the slice short: `scripts/ci-e2e-shard.test.ts` fails when the smoke specs' measured time passes 2 minutes, when a smoke spec no longer exists, or when the smoke workflow stops running them on the compiled binary.
- **Main** runs the whole suite every two hours (`17 */2 * * *`), but only when main's head has had no full run yet. The run's `head` job (`scripts/ci-e2e-main.ts head`) looks for an earlier scheduled or manual run on that commit that ran its specs, or one still going; when it finds one, every other job of the run skips and the run is green. A failed lookup lets the run go on. A manual run (`workflow_dispatch`) always runs, and a release dispatches one on its bump commit.
- **When a run on main is red**, its `blame` job finds the merge that turned it red (`scripts/ci-e2e-main.ts blame`). Each failed shard records the spec files it failed (`e2e-failed-<shard>-<attempt>`: those with a failed test in its report, or all its specs when it wrote none). The job takes the newest earlier green run on main that ran its specs, lists main's first-parent commits after it up to the red one, and reruns only the failed spec files on them, each commit built as the build job builds it and run in the shards' image. It reruns them on the red commit first (a spec that passes there is flaky and is left out), then bisects for the first commit where any of them fails; when that commit fails only some of them, it searches on from there for the rest. It writes the result to the run summary and to the `e2e-blame` artifact (`blame.json`: `verdict`, `pr`, `sha`, `specs`, `culprits`, `flaky`, `green`, `red`, `note`). The verdict is `pinned` (one PR), `several` (two or more merges each broke some specs), `flaky`, or `unpinned` (no green run to start from, a commit that could not be built, no failed spec file to rerun). It never comments on a PR or opens an issue. `scripts/ci-e2e-main.test.ts` guards the head check, the green run lookup, the report reading, the PR numbers and the search.
- **A risky PR** can still run the whole suite: add the `ci:e2e` label (with reuse of passed specs between its runs, below) or `ci:e2e-all` (every spec, every run), or start the workflow by hand on the PR's branch (`gh workflow run inbox-e2e.yml --ref <branch>`). With a label the run ends in its `Full CI (all green)` job. A PR run still needs one of its path filters to match.

Deploy (`deploy.yml`) starts when a Test run for a push to main succeeds (`workflow_run`), and deploys the sites changed since the last such run, one deploy of a site at a time; when a newer main commit has already passed Test, it deploys that newer tree. Test runs of PRs never start a deploy job.

### CI test lanes

The Test workflow (`.github/workflows/test.yml`) runs the suite as parallel jobs, one lane each, through `scripts/ci-test-lane.ts <lane>`:

- `unit-1`..`unit-3`: the plain `bun test` sweep split by Bun's `--shard=k/3`, so a new test file lands in a shard by itself. A CLI `--path-ignore-patterns` replaces bunfig.toml's `pathIgnorePatterns` instead of adding to them, so the script reads them from bunfig.toml and passes them again, plus the heavy files.
- `heavy-mod`, `heavy-agents`: the files that drive real agent processes against a real Inbox (minutes each), one process per file. To move a file into a heavy lane, add it to `HEAVY_LANES` in the script.
- `dom-1`..`dom-4`: `tests/dom-test-list.txt` with `DOM_TESTS=1` and `--isolate`. **A new DOM-gated test file goes into that list**, not into the workflow.
- The `checks` job keeps the typechecks, the package smokes and the two DOM steps that need their own process (`useFileBrowser`, the real `@pierre/diffs` files). The workflow has no summary job: a job that starts only after the others finish waits in the runner queue again (on 2026-10-28 one waited over 45 min to report green), so a PR is green when every check is.

Run one lane locally with `bun run scripts/ci-test-lane.ts unit-2`. Several lanes run at once on one local checkout can race on the `apps/hook/dist` stubs (`tests/helpers/hook-dist-stub.ts`): one process removes the stubs another relies on. On CI each lane is its own machine. `scripts/ci-test-lanes.test.ts` fails when the workflow matrix and the script's lanes differ, when a shard loses a bunfig ignore pattern, or when the DOM list names a missing, repeated or own-process file. `scripts/dom-test-allowlist.test.ts` fails when a DOM-gated file is in neither the list nor an own-process step.

The Inbox window e2e (`.github/workflows/inbox-e2e.yml`) builds the apps once, then runs the Playwright specs as 16 shards, one worker each, through `scripts/ci-e2e-shard.ts <k>`. Each shard runs in the official Playwright image of the pinned `@playwright/test` version (`mcr.microsoft.com/playwright:v<version>-noble`, as uid 1001, not root), which already holds the browsers and their system libraries, so no shard installs them with apt; a tool a spec needs that the image lacks (Bun, ripgrep) is a checksummed release download, never an apt install, kept between runs with `actions/cache` (keyed by version and checksum, checked every time). A shard is a set of whole spec files, spread by their measured time in `tests/e2e/shard-times.json` (Playwright's own `--shard` splits by test count, which left one shard at 17 min). A new spec needs no edit: with no time yet it counts as the median. Refresh the times when the shards drift apart (seconds per spec file, from a CI run's log). `scripts/ci-e2e-shard.test.ts` fails when a spec is in no shard or in two, when the workflow's matrix and the script's shard count differ, or when the times are stale enough that a shard runs well past an even split.

A workflow that downloads a GitHub release asset (Bun, ripgrep, Gitleaks, Trivy, zizmor, Syft, Grype, CycloneDX) fetches it with `scripts/ci-fetch-release-asset.sh <url> <output>` and `GH_TOKEN: ${{ github.token }}`, never a bare `curl` of the `releases/download` URL: anonymous release downloads are the first to time out (HTTP 504) when github.com sheds load. The script only downloads; the step still checks the file's SHA-256. The release workflows keep `no-cache: true` on `oven-sh/setup-bun`, so each such job first runs `scripts/ci-install-bun.sh <version>` (pinned SHA-256s per platform; add the new ones when Bun is bumped), and setup-bun then finds Bun installed and downloads nothing.

On a PR, a run whose own change is the same as an earlier run's leaves out the specs that already passed (`scripts/ci-e2e-reuse.ts`, run by the workflow's plan job). The key is the PR's own change (`git diff` with its 3 lines of context, from the merge base to the PR's head, as a `git patch-id --verbatim`, so a moved line or a whitespace edit is a new key) without spec files and unit test files, plus the files that drive the run (the workflow, `package.json`, `bun.lock`, the Playwright config, its global setup, the quarantine reader and the two shard scripts) in the tested merge commit. So a merge of main into the PR, a run cancelled half way, or a push that only edits specs keeps the key; any other change the PR makes, or a harness change on main, gives a full run. Each shard records the spec files every test of which passed (from Playwright's JSON report, never a test that did not run) with their blobs; the next run with the same key leaves out a spec only when its blob and its entries in `tests/e2e/quarantine.json` are unchanged and the run that really ran it did so in the last 24 hours (a left-out spec keeps that run's pass and age, never a new one), and spreads the rest over as many shards as they need (at least one, which also runs the update specs and the phone door's proofs). The runs on main, manual runs, PRs from forks and a PR with the `ci:e2e-all` label always run every spec. Adding `ci:e2e` or `ci:e2e-all` to a PR starts a run. A left-out spec has not been rerun against the newer main the PR merged; the two-hourly run on main covers that. `scripts/ci-e2e-reuse.test.ts` fails when the key ignores a source or harness change or changes on a plain merge of main, when a spec counts as passed with a failed or unrun test, when a changed spec, a changed quarantine or a pass older than a day is left out, when a left-out spec is passed on as a new pass, when a lookup failure does not give a full run, when the planned shards drop a spec, or when the lookup takes another branch's, a fork's or an older run.

**Flaky browser tests are quarantined, not retried.** One flaky failure turns a run on main red (and a smoke run fails its PR), so a test that failed in CI and passed on the same commit (or failed on several unrelated PRs) goes into `tests/e2e/quarantine.json`: its spec, its title, why it fails, the first date and the run ids. In CI (`CI` set) `playwright.config.ts` leaves it out (`grepInvert`, through `tests/e2e/quarantine.ts`), with any later test of the same serial spec that needs the state it leaves (`dependents`); the global setup prints the list. Locally nothing is left out, and `bun run test:e2e:quarantine` (`scripts/e2e-quarantine.ts`) runs the specs that hold them, whole (extra args go to Playwright, e.g. `--repeat-each 5`). Fix the test, prove it there, then remove its entry. A test that fails every time on main is broken, not flaky: fix it, never quarantine it. `scripts/e2e-quarantine.test.ts` fails when an entry has no reason, fewer than two failing runs, or a title its spec no longer has.

The Inbox window's memory soak (`tests/e2e/inbox-memory-soak.spec.ts`, issue #2593) is one of those specs, so it runs with the full browser suite (on main every two hours, and on a PR with `ci:e2e`), not on every push. It seeds a large store (`scripts/inbox-large-store.ts`: 4,000 threads, 30,000 messages), opens the window with a thread in the pane, and has three agents send 300 messages through `plannotator inbox mcp`. It fails when the JS heap after forced collections grows more than its budget from the first round to the last, when the heap at open is over its ceiling, when a main-thread task runs over 2 s, or when a frame or a sent message does not appear in time. The long-task check leaves out the page load and the first round of 30 messages (the warm-up, which parses the large list and loads the thread view's code once) and the forced collections; the frame and response checks cover the warm-up too. It measures over raw CDP (`tests/e2e/raw-cdp.ts`, Playwright's Chromium over `--remote-debugging-pipe`), never through a Playwright page: Playwright turns on the Network domain, and DevTools then keeps every response body, which inflates the heap. The spec's header gives the budgets and the runs they come from. When an approved change makes the window legitimately hold more, measure five runs again and update the budget there, never just raise it until the spec passes.

The heavy-thread budget (`tests/e2e/inbox-heavy-thread-budget.spec.ts`, #2948) runs with them. One agent sends a thread of 120 messages with 30 screenshots of 2880 × 1800 inline and six attached (`tests/e2e/heavy-thread-world.ts`, PNGs drawn by the spec), the window opens it unread (every message open), scrolls through it and back, then 30 more messages come in while it stays open, and it is closed and opened twice more. Over raw CDP, as the soak. It fails when a picture loads wider than its place draws it (1600 in a message, 800 in the gallery, 128 in a tile), when the loaded pictures take more than their budget decoded, when the JS heap, the listeners or the DOM nodes with the thread open are over theirs, when the 30 arrivals grow the heap more than theirs (a copy of the thread kept per read), or when closing it a third time leaves more heap than the first. `measureHeavyThread` takes any raw page and running Inbox, so the budgets are measured on a binary by hand with the spec's own steps; the spec's header has the table and the rule for changing a budget.

The two Windows jobs for the Qwen Code installer steps (about 20 runner minutes, in `windows.yml`) run on a labeled PR only when the `qwen-gate` job sees a change to `scripts/install.{ps1,cmd}`, `scripts/install.test.ts`, `apps/qwen-code/`, the test setup, `package.json`, `bun.lock` or `windows.yml`; otherwise they report skipped. The nightly run on main and manual runs always run them.

The diagram engine's Windows build (`diagram-engine-windows`, in `windows.yml`) works the same way: on a labeled PR it runs only when the `diagram-engine-gate` job sees a change to `apps/review/diagram-engine/`, `packages/review-editor/utils/diagramEngineContract.ts`, `apps/review/package.json`, `package.json`, `bun.lock` or `windows.yml`. Its plugins compare Vite's module ids, which use `/` everywhere, with paths the build script makes itself, so only a Windows build catches a path that skips `normalizePath`.

On a PR, the Release dry run skips its own `bun test` (the Test workflow runs the same sweep); tag pushes and manual runs still test before building, unless the commit only bumps the release version on top of one that Test passed (see **Release tests on a tag** under Build). Every PR workflow cancels the PR's older run when the PR gets a new push. On main, a new push cancels the older run of the Windows, Pi, Claude Code, relay and Security workflows; Test runs for every main commit (Deploy follows it), and tag pushes are never cancelled.

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

**Packed bundles (#1618).** `apps/hook/dist/index.html` and `apps/review/dist/index.html` are still ONE file each, which every host embeds or copies as before, but the browser downloads only the page, its entry chunk and its stylesheet. `build/pack-app.ts` (in place of vite-plugin-singlefile) keeps Vite's code-split output (lazy chunks: Shiki grammars, Mermaid, ELK, Graphviz, KaTeX; fonts; images) packed behind a marker after the page, and every server answers `/assets/<name>` from that pack in memory (`packages/shared/packed-app.ts`; route in server-and-storage.md). A plain plan's first load is ~4.8 MB instead of ~24 MB on loopback, ~1.4 MB instead of ~6.4 MB compressed in remote mode. A host that serves the app HTML must go through `openPackedApp`. Served raw (a Pi or Oh My Pi process from before the pack reads each HTML file on first use, so after an in-place update its old server can serve the new file whole), the marker opens a hidden `<plaintext>` so none of the pack renders, and a small inline script in the page says Plannotator was updated and how to reload. It shows only on that server's signature: when the entry script or a lazy chunk fails, it asks for the entry again and speaks only if the answer is 200 `text/html` (a proxy's 502 once a session ended, a 404 or a network error say nothing). `tests/e2e/packed-page-old-server.spec.ts` guards both. The packed page's head also starts with a small script and two font preloads (`build/pack-app.ts`): the script sets `color-scheme` from the `plannotator-theme` cookie (dark by default, `system` follows the OS) so the empty page never paints white under a dark theme while the entry script loads (ThemeProvider keeps that inline value equal to the mode from its first render), and it retries the page's stylesheet or entry script once when the request fails, then shows "Plannotator couldn't finish loading. Reload" (the entry is retried at its own URL: the lazy chunks import it by that URL). The preloads fetch the Latin Inter and Geist Mono files with the stylesheet, so text does not paint in the fallback font first on a slow link. `tests/e2e/packed-page-load.spec.ts` guards all three. The Inbox window is packed too, its own way (`build/pack-inbox.ts`: stylesheet inline, only scripts packed, all ASCII; see "One file, scripts on first use" in inbox-window.md), and only the Inbox server serves it. The phone's surface stays single-file (vite-plugin-singlefile); `tests/entry-assets.test.ts` guards both.

Running only `build:hook` after review-editor changes will copy stale HTML files. When testing locally with a compiled binary, the full sequence is:

```bash
bun scripts/require-bun.ts && bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --no-compile-autoload-bunfig \
  --define "__CLI_VERSION__=\"0.0.0-dev\"" --outfile ~/.local/bin/plannotator
```

These are the flags `.github/workflows/release.yml` compiles with; without the `__CLI_VERSION__` define `plannotator --version` falls back to `plannotator dev` and the binary cannot be told apart from any other local build. Build with bun >= 1.4.4 (what CI pins). The binary carries the compiling Bun's runtime, root certificates included: Bun before 1.4.4 still trusts emSign ECC Root CA - G3 and lacks the blocked-key check for the compromised eMudhra keys (Oct 2026). On macOS, 1.3.12 also loses the linker signature, and the compiled binary is SIGKILLed on launch with no error (#541).

**Guide viewer pin (generated, never committed).** `packages/core/guide-viewer-manifest.ts` (`GUIDE_VIEWER_MANIFEST`: the guides.show viewer's entry JS and CSS, their SRI hashes, and the grammar chunks) is what guide exports and share uploads pin. It is compiled into the binary and the OpenCode bundle, vendored into the Pi package by `vendor.sh`, bundled into the VS Code extension and the guides.show Worker, and shipped in `@plannotator/core`'s tarball. It is gitignored: its hashes move with every viewer change (any shared CSS or guide-chain edit), so a committed copy made every open PR that touched the viewer conflict with the next one to merge. **After pulling the change that untracked it, run `bun install`**: git deletes the formerly tracked file, and nothing resolves `@plannotator/core/guide-viewer-manifest` until a pin is written again (`bun run typecheck` also writes one, through `vendor.sh`). `bun install` (root `postinstall`) and `vendor.sh` write the **fallback pin** when no pin exists: `apps/guides-show/build/fallback-viewer-pin.json`, v0.28.36's viewer, already on guides.show, with no grammar chunk map (those are only modulepreload hints), so typecheck, tests and local exports work on a fresh clone. Published viewer files are immutable and never deleted, so the fallback never has to change; `fallback-viewer-pin.test.ts` freezes its values, so a bad merge into it fails CI. `bun run build:viewer-pin` deletes the previous build's `dist/viewer/manifest.json`, builds this checkout's viewer and pins it (about 15 s); run it before a local binary build whose exports must match this source, and never commit the file. Every shipping build runs it: `release.yml` before compiling the binaries and, in the `npm-package` job, before building and packing the OpenCode and Pi packages; `guides-show-deploy.yml` before deploying the Worker; core's `prepack`; the VS Code `package` script; and the Pi and OpenCode `prepublishOnly`. CI publishes the npm tarballs with `--ignore-scripts`, so for releases the `release.yml` step, not `prepublishOnly`, is what pins them; `prepublishOnly` covers only a hand `npm publish`. `apps/guides-show/build/viewer-pin-wiring.test.ts` fails when one of those stops running it (it reads the workflows as YAML and rejects a conditional or `continue-on-error` step). The release and the deploy build the viewer separately from the tag's commit; the build is deterministic, but nothing assumes it: on tag runs the `viewer-pin-live` job in `release.yml` requires guides.show to answer 200 for the entry JS and CSS that the `build` and `npm-package` jobs pinned (the two must agree), retrying every 30 s for up to about 35 minutes in all and going on as soon as both answer, and `attest`, `release` and `npm-publish` wait for it. A tag that reuses main's Test run reaches that job about 10 minutes after the tag (a full `bun test` adds about 40), and the deploy takes about 6 minutes once it has a runner; the long wait covers a deploy that sat in the queue. A viewer the last release already deployed answers 200 at once. If the deploy failed or built other bytes, the release stops there before anything is attested, released or published to npm. Recovery: deploy guides.show on the tag (`gh workflow run guides-show-deploy.yml --ref vX.Y.Z`), then "Re-run failed jobs" on the release run, which keeps the build outputs and artifacts. Hand publishes are checked by hand: a pin moves to a viewer that exists on guides.show only after a deploy (release tags, or `gh workflow run guides-show-deploy.yml --ref main`), so before publishing core or the VS Code extension between releases, deploy first, then `curl -I https://guides.show/v1/<js>` and `<css>` from the pin you packed must answer 200 (see `packages/ui/HANDOFF.md`).

**Embedded pages.** The CLI embeds `apps/hook/dist/index.html`, `review.html` and `inbox.html` with `with { type: "file" }`, and reads each into a string when a server first needs it (`embeddedPage` in `apps/hook/server/index.ts`). Do not change them back to `type: "text"`. Bun 1.4 stores a text import that is not pure ASCII as UTF-16, so each ~20 MB page would cost twice its size, which on Bun 1.4.4 made the binary 243 MB instead of 179 MB. The read comes from the embedded files that Bun loads at startup, never from the binary's path. A running process whose binary the installer replaces still reads its own pages. `smoke-binaries` checks this on all three OSes with `scripts/smoke-pages.mjs`. It also checks that every served page, and the chunks and stylesheet it loads up front, is byte-identical to the build, using the build job's `page-digests` artifact (`scripts/page-digests.ts`: a packed page's digest is the page as served, plus one per packed file).
**Release trust gate.** `release.yml` runs `scripts/check-bun-runtime-trust.ts` over every compiled binary before upload. A binary fails when its embedded Bun is below 1.4.4, when it holds emSign ECC Root CA - G3 (as PEM, DER or public key), or when it lacks the blocked-key check (oven-sh/bun#46300; marker `addBlockedSPKIForTesting`). The script reads bytes only, so the Linux builder also checks the darwin and Windows binaries. Raise `MIN_BUN_VERSION` there together with the workflow pins.

**Patched dependency.** `patches/@opencode-ai%2Fsdk@1.19.3.patch` (root `patchedDependencies`) makes the SDK's SSE abort handler catch `reader.cancel()`. On Bun 1.4 that promise rejects once the aborted fetch has errored the body, and the unhandled rejection ends the process: every OpenCode Ask AI answer or Stop aborts the event stream. `packages/ai/providers/opencode-sdk.test.ts` ("through the real client") fails without it. A new SDK version needs the patch carried over (`bun patch @opencode-ai/sdk`) until upstream catches the promise.

**Partial-diff compatibility patch (#2264).** `patches/@pierre%2Fdiffs@1.6.4.patch` lets `FileDiff.loadFilesIfNecessary()` return without hydrating when no `loadDiffFiles` callback is configured. Plannotator already loads and validates full contents through `/api/file-content`; a missing or stale response must leave a readable partial diff, not crash either review surface when `expandUnchanged` is enabled. Pierre still hides expansion controls for partial diffs without a loader, and `prepareForEditing()` still rejects incomplete content. Carry this patch forward when upgrading `@pierre/diffs` until upstream supports externally hydrated partial diffs without throwing.

**Release versions:** a release bumps 10 version files together, `apps/dsh-plugin/package.json` (`@plannotator/dsh`) and `apps/cline-plugin/package.json` (`@plannotator/cline`) among them; `scripts/check-release-version.mjs` lists them and fails on a mismatch. The full procedure is [`.agents/skills/release/SKILL.md`](../../.agents/skills/release/SKILL.md). `bun run build` also builds the DeepSeek Harness plugin (`build:dsh`) and the Cline plugin (`build:cline`), whose type checks and tests run in the release workflow's `test` job with everything else.

**Release tests on a tag.** A tag's `test` job skips its unsharded `bun test` (about 40 minutes) when main's Test workflow already passed the same code. `scripts/release-test-reuse.ts` lists the passed Test runs of pushes to main (`actions: read`), takes the one on the nearest commit in the tag's history, and reuses it only when `git diff` from that commit to the tag changes nothing but the bump files: the 10 version files (only their version field) and `packages/inbox/feedbackSearch.data.json` (still valid JSON; its test, `packages/inbox/feedbackSearch.test.ts`, then runs). Root `RELEASE_NOTES*.md` files are allowed too. The step logs and writes to the job summary which run it reused, with its link. Any other changed file, a version file with other edits, no passed run in the tag's history (Test's concurrency group can replace the bump commit's own run), a PR run, or any API or git error runs the full `bun test` as before; the step never fails the job. The type check always runs. `scripts/release-test-reuse.test.ts` fails when a non-bump change, a broken index or a run that is not a passed push to main is reused, when an API or git failure does not run the tests, or when the bump file list drifts from `scripts/check-release-version.mjs`.

Running only `build:opencode` will copy stale HTML files.

## Marketing Site

`apps/marketing/` is the plannotator.ai website — landing page, documentation, and blog. Built with Astro 5 (static output, zero client JS except a theme toggle island). Docs are markdown files in `src/content/docs/`, blog posts in `src/content/blog/`, both using Astro content collections. Tailwind CSS v4 via `@tailwindcss/vite`. Deploys to S3/CloudFront via GitHub Actions on push to main.

The `/docs/reference/keyboard-shortcuts` page is auto-generated from the shortcut registry at build time — see the Keyboard Shortcuts section above. Editing the markdown body has no effect; update the scope files instead.

### The agents pages

`/inbox/agents/` (the three tiers and the comparison table) and `/inbox/agents/<slug>/` (one page per agent) read one list, `apps/marketing/src/lib/inbox-agents.ts`: each agent's tier, its answer in every column (with the source file of each fact in `src`), its install steps, Windows line and limits. When an integration changes (a new agent, a reply that now wakes it, a new launch host), change the cell there and both pages follow. The pages are generated behind `INBOX_LAUNCHED`, like `/inbox/`. `apps/marketing/inbox-launch.test.ts` checks that every agent has its page and its row, in the columns' order, and that no heading or button has a comma.

### Videos

The site's videos are not in the repository, so a plugin update that copies the repo stays small. They live in the `plannotator-marketing` S3 bucket under `assets/` and are served at `https://plannotator.ai/assets/<name>` (the same URLs as when they shipped from `public/assets/`; the in-app announcements and the README link to them). The marketing deploy's `aws s3 sync … --delete` has `--exclude "assets/*.mp4" --exclude "assets/*.webm"`, so it neither uploads nor deletes them. Pages link to them with `videoUrl('<name>')` from `src/lib/media.ts`, an absolute URL, so `bun run dev` plays the production files. Posters (small jpgs) stay in `public/assets/`. `apps/marketing/media.test.ts` fails when a video is put back in `public/`, a page links one by a relative path, or the sync loses its excludes.

To add or replace a video, someone with AWS access uploads it with an explicit content type (`video/webm` for `.webm`), then checks the public URL:

```bash
aws s3 cp ./my-demo.mp4 s3://plannotator-marketing/assets/my-demo.mp4 --content-type video/mp4
curl -sI https://plannotator.ai/assets/my-demo.mp4   # 200, content-type video/mp4, the file's size
```

A new name needs no CloudFront invalidation. To replace a file in place, prefer a new name (for example `my-demo-v2.mp4`) and update the page; overwriting the same key needs `aws cloudfront create-invalidation --distribution-id E284ON0A27O2H6 --paths "/assets/my-demo.mp4"`, and browsers that cached the old file can keep it for a while. Upload before merging the page that links it.

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
