# Plannotator

A plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. Also provides code review for git diffs and annotation of arbitrary markdown files.

> **Reusing the document UI (theme / markdown / editor / settings / comments / layout) in the commercial Workspaces app? Read `packages/ui/README.md` FIRST.** It explains the published `@plannotator/ui` + `@plannotator/core` packages and the host-override seams a host plugs its own backend into via `configurePlannotatorUI()`. A prior from-scratch reimplementation of this UI broke the app and was reverted — do **not** rebuild it or recreate `packages/document-ui`. Add a seam to `@plannotator/ui` instead, keep Plannotator's app unchanged, and never delete working code until a human confirms parity in the browser.

## Project Structure

```
plannotator/
├── apps/
│   ├── hook/                     # Claude Code plugin (no commands/ — core skills installed to ~/.claude/skills act as slash commands)
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json      # PermissionRequest hook config
│   │   ├── server/index.ts       # Entry point (plan + review + annotate + archive subcommands)
│   │   └── dist/                 # Built single-file apps (index.html, review.html)
│   ├── opencode-plugin/          # OpenCode plugin
│   │   ├── commands/             # Slash command stubs (review, annotate, last — plugin intercepts execution)
│   │   ├── index.ts              # OpenCode 1 entry with submit_plan tool + review/annotate event handlers
│   │   ├── server.ts             # OpenCode 2 adapter (experimental V2 plugin API)
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
│   ├── kiro-cli/                 # Kiro CLI integration source (consumed by scripts/install.sh; auto-detected via ~/.kiro)
│   │   ├── agents/plannotator.json   # Example Kiro custom agent
│   │   └── skills/               # Kiro-specific skill packages (review, annotate); setup-goal + visual-explainer install from apps/skills/extra
│   ├── paste-service/            # Paste service for short URL sharing
│   │   ├── core/                 # Platform-agnostic logic (handler, storage interface, cors)
│   │   ├── stores/               # Storage backends (fs, kv, s3)
│   │   └── targets/              # Deployment entries (bun.ts, cloudflare.ts)
│   ├── review/                   # Standalone review server (for development)
│   │   ├── index.html
│   │   ├── index.tsx
│   │   └── vite.config.ts
│   ├── vscode-extension/         # VS Code extension — opens plans in editor tabs
│   │   ├── bin/                   # Router scripts (open-in-vscode, xdg-open)
│   │   ├── src/                   # extension.ts, cookie-proxy.ts, ipc-server.ts, panel-manager.ts, editor-annotations.ts, vscode-theme.ts
│   │   └── package.json           # Extension manifest (publisher: backnotprop)
│   └── skills/                    # Agent skills (agentskills.io format)
│       ├── core/                  # CORE skills (single-sourced) — installed to ~/.claude/skills and ~/.agents/skills (Codex)
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
│   │   │   ├── plan-diff/        # PlanDiffBadge, PlanDiffViewer, clean/raw diff views
│   │   │   └── sidebar/          # SidebarContainer, SidebarTabs, VersionBrowser, ArchiveBrowser
│   │   ├── shortcuts/            # Keyboard shortcut registry (see Keyboard Shortcuts section below)
│   │   │   ├── core.ts           # Engine: parser, formatter, dispatcher, validator
│   │   │   ├── runtime.ts        # Engine: useShortcutScope, useDoubleTapShortcuts hooks
│   │   │   ├── index.ts          # Barrel — re-exports engine + scopes from both subfolders
│   │   │   ├── plan-review/      # Scopes for plan-editor surfaces (annotationToolbar, annotationPanel, commentPopover, imageAnnotator, inputMethod, viewer)
│   │   │   └── code-review/      # Scopes for review-editor surfaces (ai, allFilesDiff, annotationToolbar, fileTree, prComments, suggestionModal, tourDialog)
│   │   ├── shortcuts.test.ts     # Registry unit tests (parser, dispatcher, validator)
│   │   ├── utils/                # parser.ts, sharing.ts, storage.ts, planSave.ts, agentSwitch.ts, planDiffEngine.ts, planAgentInstructions.ts
│   │   ├── hooks/                # useAnnotationHighlighter.ts, useSharing.ts, usePlanDiff.ts, useSidebar.ts, useLinkedDoc.ts, useAnnotationDraft.ts, useCodeAnnotationDraft.ts, useArchive.ts
│   │   └── types.ts
│   ├── ai/                       # Provider-agnostic AI backbone (providers, sessions, endpoints)
│   ├── core/                     # @plannotator/core — browser-safe, zero-dep universal slice (pure utils + types) shared by ui + shared; published so @plannotator/ui can be installed standalone. `shared` re-exports the moved modules via one-line shims so Plannotator is unchanged.
│   ├── shared/                   # Node/git/server logic + cross-runtime types (re-exports browser-safe modules from @plannotator/core)
│   │   ├── storage.ts            # Plan saving, version history, archive listing (node:fs only)
│   │   ├── draft.ts              # Annotation draft persistence (node:fs only)
│   │   └── project.ts            # Pure string helpers (sanitizeTag, extractRepoName, extractDirName)
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

## Installation

**Via plugin marketplace** (when repo is public):

```
/plugin marketplace add backnotprop/plannotator
```

**Local testing:**

```bash
claude --plugin-dir ./apps/hook
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` / `true` for remote mode, `0` / `false` for local mode, or leave unset for SSH auto-detection. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. Remote ready messages also render a terminal QR code of the advertised URL when stderr is a TTY and the advertised host is overridden away from localhost (a QR of a localhost URL scans to nowhere), so another device can join without retyping the URL. |
| `PLANNOTATOR_AGENT_TERMINAL_REMOTE` | Set to `1` / `true` to enable the annotate-mode agent terminal while `PLANNOTATOR_REMOTE` is active or the session is published with `--tailscale`. Off by default in both cases because the session is reachable by network peers and the PTY token is not an auth boundary. |
| `PLANNOTATOR_PORT` | Fixed port or inclusive range to use. A range selects the first available port. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_PUBLIC_URL` | Full HTTP(S) origin advertised for a remote session behind a reverse proxy, for example `https://plannotator.example.com`. Plannotator uses it as-is instead of appending the local runtime port. For a configured port range, it applies only to the first port; sessions on later ports fall back to `PLANNOTATOR_URL_HOST` or `localhost` with the runtime port appended. Origin only: credentials, paths, query strings, fragments, and non-HTTP(S) schemes warn once on stderr and fall back to `PLANNOTATOR_URL_HOST` or `localhost`. Strictly display-only and remote-only: it never changes the bind interface or same-machine agent API URL. Can also be set via `~/.plannotator/config.json` (`{ "publicUrl": "https://plannotator.example.com" }`); the env var takes precedence, and an empty value suppresses the config key. |
| `PLANNOTATOR_URL_HOST` | Display-only hostname for advertised session URLs (issue #657), e.g. a Tailscale MagicDNS name or tailnet IP, so remote-mode links are reachable from another device instead of `http://localhost:<port>`. Host only — bare hostname, IPv4, or bracketed IPv6 (`[fd7a::1]`); the runtime-chosen port is always appended, and anything carrying a scheme, port, path, credentials, or whitespace warns once on stderr and falls back to `localhost`. Used when `PLANNOTATOR_PUBLIC_URL` is unset or a configured port range selects a later port. Strictly display-only and remote-only: binding stays governed by `PLANNOTATOR_REMOTE`; a local session ignores the override (localhost is advertised and opened, since only loopback is bound) with a once-per-process stderr warning to set `PLANNOTATOR_REMOTE=1`, and spawned agent-review jobs keep a pinned `http://127.0.0.1:<port>` API URL so a tailnet-only hostname cannot break local jobs. The sentinel `auto` resolves the host from Tailscale once per process, at first use in a remote session: `tailscale status --json` → `Self.DNSName` (trailing dot stripped), falling back to the single `tailscale ip -4` CGNAT (100.64.0.0/10) address; detection failure warns once on stderr and falls back to `localhost`, and detection never changes binding — `auto` is as display-only as any explicit host. Can also be set via `~/.plannotator/config.json` (`{ "urlHost": "host" }` or `{ "urlHost": "auto" }`); the env var takes precedence, and an empty-but-set env var (`PLANNOTATOR_URL_HOST=`) suppresses a config-file `urlHost`. Default: unset (`localhost`). |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_AI` | Set to `disabled` to disable Ask AI and the Review Agents / Guided Review execution surfaces, including provider and agent-job endpoints. Persisted guide data is retained and its server APIs remain available, but the in-app history browser is hidden while AI is disabled. External agents can still open reviews and submit annotations. The explicit annotate-mode agent terminal is separate and remains controlled by its own settings. Default: enabled. |
| `PLANNOTATOR_SHARE` | Set to `disabled` to turn off URL sharing entirely. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "share": "disabled" }`); the env var takes precedence. |
| `PLANNOTATOR_SHARE_URL` | Custom base URL for share links (self-hosted portal). Default: `https://share.plannotator.ai`. |
| `PLANNOTATOR_PASTE_URL` | Base URL of the paste service API for short URL sharing. Default: `https://plannotator-paste.plannotator.workers.dev`. |
| `PLANNOTATOR_ORIGIN` | Explicit agent-origin override at the top of the detection chain. Valid values: `claude-code`, `amp`, `droid`, `opencode`, `codex`, `copilot-cli`, `gemini-cli`, `kiro-cli`, `pi`. Invalid values silently fall through to env-based detection. Unset by default. |
| `PLANNOTATOR_JINA` | Set to `0` / `false` to disable Jina Reader for URL annotation, or `1` / `true` to enable. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "jina": false }`) or per-invocation via `--no-jina`. |
| `PLANNOTATOR_ANNOTATE_HISTORY` | Set to `0` / `false` to disable ALL annotate-session writes to the data dir: per-file version history (no copies of annotated files are written; the annotate version diff is unavailable) AND the durable submitted-feedback records (#678) that single-local-file annotate sessions otherwise write to `history/{project}/{slug}/submissions/` before deleting the draft on submit. Disabling it keeps annotate sessions fully stateless but also gives up that submit crash-recovery record. URL / folder / annotate-last sessions never write either kind of data regardless of this flag. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "annotateHistory": false }`); the env var takes precedence. |
| `PLANNOTATOR_GUIDE_HISTORY` | Set to `0` / `false` to disable persisting successful Guided Reviews (no guide copies are written to the data dir; the "Previous guides" list is then never populated, though already-saved guides remain readable and listed). Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "guideHistory": false }`); the env var takes precedence. |
| `PLANNOTATOR_CURSOR_SANDBOX` | Set to `0` / `false` / `disabled` to stop passing `--sandbox enabled` when launching Cursor's `agent` CLI for review jobs — the flag pair is omitted entirely, deferring to the user's own Cursor Agent sandbox configuration. For systems where Cursor's sandbox cannot start (NixOS, AppArmor-restricted Linux). Default: enabled (`--sandbox enabled` is passed). Can also be set via `~/.plannotator/config.json` (`{ "cursorSandbox": false }`); the env var takes precedence. Note: opting out means the review job's write protection relies on `--mode ask` plus the user's own Cursor configuration. |
| `PLANNOTATOR_TODO_PROVIDER` | Set to `off` / `0` / `false` / `disabled` to stop mirroring the approved plan checklist into an editable todo provider during execution. Default: enabled, which syncs only when a provider is detected (currently pi-todos: detected when its todo directory exists — `<cwd>/.pi/todos` by default, or wherever `PI_TODO_PATH` redirects it when set). The repo-implied `<cwd>/.pi/todos` must realpath to a location inside the project or the provider reads as absent and never writes, so a symlink committed into a hostile repo cannot redirect todo writes out of it; an explicitly set `PI_TODO_PATH` is the user's own choice and is honored verbatim, including outside the project. The mirror is additive — the progress widget is unaffected either way — and sync is one-way, so provider-side edits never feed back into plan execution. Can also be set via `~/.plannotator/config.json` (`{ "todoProvider": "off" }`); the env var takes precedence. |
| `JINA_API_KEY` | Optional Jina Reader API key for higher rate limits (500 RPM vs 20 RPM unauthenticated). Free keys include 10M tokens. |
| `PLANNOTATOR_DATA_DIR` | Override the base data directory. Supports `~` expansion. Default: `~/.plannotator`. When unset, an existing `~/.plannotator` always wins; if it doesn't exist and `$XDG_DATA_HOME` is set to an absolute path, `$XDG_DATA_HOME/plannotator` is used; otherwise `~/.plannotator` (the XDG spec's implicit `~/.local/share` default is deliberately not applied). All data (plans, history, drafts, config, hooks, sessions, debug logs, IPC registry) is stored under this directory. |
| `PLANNOTATOR_FILE_BROWSER_MAX_FILES` | File-discovery limit: regular files inspected by CLI markdown/folder resolution and startup code-file warming, supported files returned by the file browser, and directories scanned during multi-repo workspace discovery (symlinks may point outside the workspace, so the budget — not the root — bounds that walk). Must be a positive integer; invalid, zero, or negative values use the default of `5000`. |
| `PLANNOTATOR_GLIMPSE` | Set to `0` / `false` to disable the Glimpse native window even when `glimpseui` is installed. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "glimpse": false }`). |
| `PLANNOTATOR_GLIMPSE_WIDTH` | Width in pixels for the Glimpse native window. Default: `1280`. |
| `PLANNOTATOR_GLIMPSE_HEIGHT` | Height in pixels for the Glimpse native window. Default: `900`. |
| `PLANNOTATOR_VERIFY_ATTESTATION` | **Read by the install scripts only**, not by the runtime binary. Set to `1` / `true` to have `scripts/install.sh` / `install.ps1` / `install.cmd` run `gh attestation verify` on every install. Off by default. Can also be set persistently via `~/.plannotator/config.json` (`{ "verifyAttestation": true }`) or per-invocation via `--verify-attestation`. Requires the `gh` CLI, but not a login: the attestation bundle is fetched from GitHub's public attestations API (single unauthenticated attempt, never retried; the endpoint allows 60 requests/hour per IP) and verified with `--bundle`; the extraction needs one JSON tool on PATH (node, python3, or jq). gh's authenticated fetch is the fallback whenever the bundle path is unavailable or does not complete (missing extractor, fetch failure, or a gh that cannot verify the fetched bundle, e.g. an older gh without `--bundle`). Verification still needs network on every run because the Sigstore TUF trust root is fetched per-run; that failure is reported as connectivity, distinct from a real provenance failure, and both fail closed. |
| `PLANNOTATOR_SKIP_CODEX_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip writing the Codex integration (`hooks.json` / `config.toml` under `CODEX_HOME`, and the Codex-home stale-skill cleanup) even when Codex is detected. The installer reports the honest state ("Codex: detected, skipped (...)" vs "not detected" vs installed) and never removes an integration a previous install wired. Also settable via `~/.plannotator/config.json` (`{ "skipInstall": { "codex": true } }`); precedence is `--skip-codex` flag > env var > config. Off by default. |
| `PLANNOTATOR_SKIP_GEMINI_INSTALL` | **Read by the install scripts only.** Same opt-out shape for the Gemini CLI integration (`~/.gemini` policy file, settings hook, slash commands). Config key: `skipInstall.gemini`; flag: `--skip-gemini`. Off by default. |
| `PLANNOTATOR_SKIP_KIRO_INSTALL` | **Read by the install scripts only.** Same opt-out shape for the Kiro CLI integration (`~/.kiro` skills and agent, including the `~/.kiro` stale-skill sweep). Config key: `skipInstall.kiro`; flag: `--skip-kiro`. Off by default. |
| `PLANNOTATOR_SKIP_OPENCODE_INSTALL` | **Read by the install scripts only.** Do-not-write switch for the OpenCode integration (command stubs under `~/.config/opencode/commands`, the OpenCode plugin cache clear, and the stale command-stub sweep). OpenCode has no detection leg, so there is no detected/not-detected reporting, just a skip note. Config key: `skipInstall.opencode`; flag: `--skip-opencode`. Off by default. |
| `PLANNOTATOR_SKIP_SKILLS_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip the skills/slash-command sparse checkout entirely — no `git clone` of the release tag, so nothing is written to any skill or command scope (`~/.claude/skills`, `~/.agents/skills`, the OpenCode command stubs, the Gemini `.toml` commands, `~/.kiro`), the extras are not offered, and the skill-scope cleanup sweeps stay suspended (skip means do-not-write, never remove). The binary, sem sidecar, agent-terminal runtime, hooks, and per-agent config still install, and git stops being a hard requirement. The installer reports `Skills: skipped (...)` and the closing banner stops claiming the `/plannotator-*` commands are ready. Unlike the per-agent opt-outs this is not one agent's home — it covers every scope the checkout writes. Config key: `skipInstall.skills`; flags: `--skip-skills` (bash/cmd), `-SkipSkills` (PowerShell); precedence is flag > env var > config. Used by the `install-script-smoke` CI job, which installs a synthetic `v9.9.9` whose tag has no GitHub counterpart. Off by default. |
| `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL` | Set to `1` / `true` to skip installing the managed Node/WebTUI runtime used by compiled Bun builds for the annotate-mode agent terminal. Read by `plannotator install-runtime agent-terminal`, which the installers call automatically. |
| `PLANNOTATOR_MINIMAL` | **Read by the install scripts only**, not by the runtime binary. Set to `1` / `true` / `yes` to have `scripts/install.sh` / `install.ps1` / `install.cmd` install **only** the `plannotator` binary, skipping the sem sidecar, the agent-terminal runtime, all per-agent skills, hooks, slash commands, and config, and the CallDiff runtime even when its opt-in is set. Equivalent to the `--minimal` (aliased to `--binary-only`) flag; `--no-minimal` overrides it. Off by default. |
| `PLANNOTATOR_SKIP_SEM_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip installing the optional `sem` semantic-diff sidecar (used by code review). Off by default. |
| `PLANNOTATOR_INSTALL_CALLDIFF` | **Read by the install scripts only.** Set to `1` / `true` / `yes` to ALSO install the optional pinned, pruned CallDiff core used by code review's Call Flow analysis (about 5 MB on macOS arm64, Node.js 22+). The runtime is strictly opt-in and is NOT installed by default. The normal path is in-app: enabling Call flow consents to one background install of core plus exactly the language packs required by the current changed files; later missing languages install automatically under the same consent, while the Languages list supports install-ahead. Each target gets one automatic attempt per review session; a failed target then requires an explicit Retry in that session. Equivalent to `--with-call-flow` (PowerShell: `-WithCallFlow`) or `{ "installCallFlow": true }` in `~/.plannotator/config.json`; precedence is flag > env var > config. `--minimal` always excludes it. Off by default. |
| `PLANNOTATOR_CALLDIFF_PATH` | Development override for a built CallDiff `0.4.1` package root containing `dist/run.js`; the exact pinned Tree-sitter core and any desired optional grammars must already exist under its `node_modules`. Managed language-pack installation is disabled for overrides. Normal installs use the selective managed core and grammar cache under the Plannotator data directory. |

**Config-only settings (`~/.plannotator/config.json`)**: Some settings have no env-var equivalent and are toggled by editing the config file directly:

- `markdownExtensions` (array of strings, default none) — extra file extensions the **annotate** path treats as markdown, e.g. `{ "markdownExtensions": [".livemd"] }` for Livebook notebooks (#1307). A listed extension is accepted everywhere `.md` is on that path: CLI target resolution (`plannotator annotate notes.livemd`), folder discovery and the file browser, `/api/doc` plus relative and wiki-link navigation between sibling docs, the 2MB `MAX_ANNOTATABLE_FILE_BYTES` cap, and per-file version history. Listed extensions render as **markdown** (frontmatter stripped), never as raw HTML, and they only widen the set: nothing built in is removed. Entries must start with a dot and be free of path separators, globs, and whitespace (`".livemd"`, not `"livemd"` or `"*.livemd"`); invalid entries are dropped silently, built-in extensions are deduplicated, and the dotenv family can never be registered: `.env` itself plus any entry ending in `.env` or starting with `.env.` (such as `.prod.env` or `.env.local`) is denied, because annotate copies file contents into the data dir (the same reason `.env` is excluded from the built-in set). The value is read from `config.json` once per process. Predicates stay pure in `packages/core/annotatable.ts`, which is browser-safe and cannot read config; the node-side resolver that threads the normalized list into them is `packages/shared/markdown-extensions.ts` (vendored to Pi), and the annotate `/api/plan` payload ships the same list to the renderer so it can linkify links to sibling documents. Not applied to plan write (`ALLOWED_PLAN_EXTENSIONS` in `apps/pi-extension/tool-scope.ts`) or to Edit Mode source save (`SOURCE_SAVE_FILE_REGEX` in `packages/core/source-save.ts`), which keep their own narrower allowlists.
- `pfmReminder` (`true` / `false`, default `false`) — when enabled, a Plannotator Flavored Markdown reminder is injected at plan-time describing the renderer's extensions (code-file links, callouts, tables, diagrams, task lists, hex swatches, wiki-links). Lets the planning agent enrich plans with PFM features without having to discover them. Composes cleanly with the compound-skill improvement hook. Supported across all three runtimes: Claude Code (`improve-context` PreToolUse hook in `apps/hook/server/index.ts`), OpenCode (`experimental.chat.system.transform` in `apps/opencode-plugin/index.ts`), and Pi (`before_agent_start` in `apps/pi-extension/index.ts`).

**Legacy:** `SSH_TTY` and `SSH_CONNECTION` are still detected when `PLANNOTATOR_REMOTE` is unset. Set `PLANNOTATOR_REMOTE=1` / `true` to force remote mode or `0` / `false` to force local mode.

**Devcontainer/SSH usage:**
```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999
```

**Tailnet sessions (`--tailscale`):** `plannotator review --tailscale` (also `annotate` and `annotate-last`/`last`; other subcommands reject the flag with a clear error; Bun CLI only, not mirrored to Pi) publishes the session over the user's tailnet instead of remote mode: the server stays **loopback-bound** and the CLI orchestrates `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`, so devices on the tailnet reach the session over HTTPS while nothing listens beyond localhost and nothing is ever public (serve, never funnel). The advertised HTTPS URL prints on stderr with a terminal QR code (TTY only), and a publishing failure exits `1` — or `2` under a strict annotate gate (`--require-approval` / `--result-file`), where `1` is reserved for "the reviewer did not approve" and a publish failure is a startup failure like any other — with an actionable message instead of leaving the loopback server hanging (CLI missing, daemon down or logged out, unparsable `serve status` output — which fails closed, or no serve URL matching the session port). A pre-existing serve mapping on the chosen port — background or foreground session, which Tailscale prefers — aborts rather than being stolen, and mappings on other ports are never touched. Mappings the process creates are cleaned up on normal exit and on SIGINT/SIGTERM/SIGHUP (all routed through `process.exit` so exit handlers run; the SIGHUP route is installed by `enableTailscaleServe` only once a mapping exists — an unconditional SIGHUP listener would override the ignored disposition `nohup` depends on, so plain non-tailscale sessions keep no SIGHUP listener and `nohup plannotator review &` survives terminal close); a failed teardown retries once and then warns with the exact manual command, and a hard kill (SIGKILL) or reboot can leave the mapping — `tailscale serve --bg` state persists — so remove it with `tailscale serve --https=<port> off`. Combined with `PLANNOTATOR_REMOTE`/SSH detection, `--tailscale` wins and forces local mode with a stderr notice — the wide `0.0.0.0` bind would only broaden exposure (`urlHost` is also suppressed for the run; the advertised URL comes from serve). The annotate agent terminal is **off by default** in `--tailscale` sessions, exactly like remote mode, because the session is reachable across the tailnet and the PTY token is not an auth boundary; enable it with `PLANNOTATOR_AGENT_TERMINAL_REMOTE=1`. Orchestration lives in `packages/server/tailscale-serve.ts` on shared parsers in `packages/shared/tailscale.ts`.

## Plan Review Flow

```
Claude calls ExitPlanMode
        ↓
PermissionRequest hook fires
        ↓
Bun server reads plan from stdin JSON (tool_input.plan)
        ↓
Server starts on random port, opens browser
        ↓
User reviews plan, optionally adds annotations
        ↓
Approve → stdout: {"hookSpecificOutput":{"decision":{"behavior":"allow"}}}
Deny    → stdout: {"hookSpecificOutput":{"decision":{"behavior":"deny","message":"..."}}}
```

## Code Review Flow

```
User runs /plannotator-review command
        ↓
Claude Code: plannotator review subcommand runs
OpenCode: event handler intercepts command
        ↓
VCS provider captures local changes (Git, GitButler, JJ, or P4 where supported). When review runs from a
non-VCS parent that contains nested Git/JJ/GitButler repos, child diffs are combined with
folder-prefixed paths.
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → feedback sent to agent session
Approve → "LGTM" sent to agent session
```

### Since-main default review view

The default code-review diff is **`since-base`** — a composite of `merge-base(base, HEAD)` vs the working tree plus untracked files ("everything a PR would show if you committed and pushed now"). It can render as a three-section **git status** panel (Committed / Changes / Untracked) via `SectionsPanel`, with a `Tree | Git status | Commits` toggle (`PanelViewToggle`). The Commits segment (git-local sessions only) is a linear `--first-parent` history rail (`CommitsPanel`): clicking a commit opens its own diff (`commit:<sha>`, vs its first parent) as the all-files view headed by the commit message rendered as markdown. The Commits view is a self-contained detour: entering it memoizes the previously active diff, exiting to Tree restores that diff verbatim (exiting to Git status resets to `since-base` as always), the memo clears whenever any non-commit diff is applied, and a reload that serves a commit-family diff with a non-Commits panel view snaps once to the session default so the commit diff cannot outlive the visit. The toggle never writes the persisted `reviewPanelView`/`defaultDiffType` pair (no server writes from a toggle click), but it does record a cookie-only last-used memo (`reviewPanelViewLastUsed`, `sections` | `tree` — never `commits`; the Commits view is session-only). A review OPENS on session choice ?? last-used memo ?? persisted `reviewPanelView` (cookie-only, written only by Settings and `ReviewSetupDialog` through `setReviewPanelView()`, which also syncs the memo so an explicit choice is never shadowed by a stale one — except the App self-heal, which passes `recordLastUsed: false` to repair the diff half of a conflicted pair without touching the memo). The first-run initializer marks review-setup-seen when it seeds the cookie-only Tree choice, not only on dismiss, so it is genuinely one-time per browser and cannot overwrite a returning reviewer's persisted or last-used view; it inherits the resolved `defaultDiffType` without a server config write. The persisted pair is coupled: the Sections view only renders `since-base`, so choosing a classic diff default snaps the persisted view to Tree and vice-versa (enforced in `ReviewSetupDialog`, the Settings Git tab, and the App first-run initializer).

**Staging display invariant:** `useGitAdd`'s `stagedFiles` is the EFFECTIVE staged set (sections-sidecar snapshot + session stage/unstage overrides) and is the only source any surface may render staging state from. The sidecar entry's `staged` flag is a snapshot — ORing it back in makes files unstaged mid-session render as staged (and inverts the next toggle).

`since-base` is only offered when the base ref actually resolves — on a repo whose trunk isn't discoverable (`trunk`, no `origin/HEAD`) `getGitContext` omits it and the default falls through to `uncommitted`, so committed branch work is never silently hidden. The since-base patch/sections/fingerprint/file-content paths all degrade to `HEAD` together when merge-base fails for a resolvable-but-unrelated base. First-run shows `ReviewSetupDialog` (replaces the removed `DiffTypeSetupDialog`), which initializes an unseen reviewer's panel to Tree once while preserving the resolved diff default, and is reopenable from the review header menu. The one-time dialog chain is guide intro → look-and-feel → review setup → Edit Mode; none of the dialogs stack. Analysis layers no longer add a startup dialog: Semantic Changes retains its enabled default, while Call Flow remains disabled until the user explicitly enables it in Settings, which is also consent for its managed runtime installation.

### GitButler review invariants

GitButler is a distinct VCS provider, ordered after JJ and before Git in both Bun and Pi. It is selected only while symbolic `HEAD` is `refs/heads/gitbutler/workspace` (or legacy `gitbutler/integration`) and the repository has GitButler's local target-ref configuration; a leftover database or an ordinary branch with the reserved name is not detection. An active workspace requires `but >= 0.21.0` on `PATH`, and a missing/incompatible CLI is an explicit error rather than a fallback to ordinary Git staging against the synthetic workspace commit. `--gitbutler` forces this provider; `--git` remains the escape hatch.

The default `gitbutler:workspace` view is GitButler's reported merge base versus the working tree plus untracked files, so it includes every applied committed change and assigned/unassigned worktree change. Multi-branch stack views are committed-only merge-base→stack-tip Git diffs; branch views are committed-only first-parent segment diffs. Client IDs encode branch-name anchors, never GitButler's transient CLI IDs. Do not concatenate independent GitButler hunks: their bases can differ. Assigned worktree hunks stay in Workspace until GitButler exposes an authoritative combined stack diff.

GitButler assignment is not the Git index, so the provider never opts into stage/unstage. Git-status sections, commit history, remote-base discovery/fetch, and the first-run Git setup remain `vcsType: "git"` only. File expansion uses the exact object range for committed views and merge-base/working-tree pair for Workspace; fingerprints cover the visible Git content plus canonical stack/branch topology. Nested multi-repo mode maps only `workspace-current` to GitButler; staged/unstaged/last modes are unavailable when a GitButler child is present.

### Code-review Ask AI context

Ask AI's "changes under review" context for **code review** is generated by the shared agent-review prompt machine (`buildAgentReviewUserMessage` / `buildAgentReviewUserMessageForTarget` in `packages/server/agent-review-message.ts`) — the same machine the launchable review jobs use — and is **delivered on the user's messages, not the system prompt**. The review server computes it for the current view (`buildCurrentAiReviewContext` in `packages/server/review.ts`, mirrored in `apps/pi-extension/server/serverReview.ts`) and ships it as `aiReviewContext` in the diff payloads (`/api/diff` and the switch/PR endpoints). The client (`packages/review-editor`) latches it onto each question via `buildReviewContextPreamble` (`packages/ui/utils/aiPrompt.ts`): the full block on the first message and whenever the view changes, a short reminder otherwise (never re-pasting a large diff). This keeps the agent looking at exactly the on-screen changeset across every mode (uncommitted/untracked, branch, merge-base, stacked-PR full-stack, hide-whitespace, PR worktrees, workspace, GitButler, jj). The code-review system prompt (`buildCodeReviewPrompt` in `packages/ai/context.ts`) is intentionally role-only.

## Ask AI Provider Defaults

Ask AI providers are detected independently from installed/authenticated local CLIs, then the UI picks a default from the detected Plannotator origin. The mapping lives in `packages/core/agents.ts` (re-exported via the `packages/shared/agents.ts` shim) and is applied by `packages/ui/utils/aiProvider.ts`:

| Origin | Preferred Ask AI provider |
|--------|---------------------------|
| `claude-code` | `claude-agent-sdk` |
| `amp` | no dedicated provider; fallback to saved/server default |
| `droid` | no dedicated provider; fallback to saved/server default |
| `codex` | `codex-sdk` |
| `opencode` | `opencode-sdk` |
| `pi` | `pi-sdk` |
| `copilot-cli` | no dedicated provider; fallback to saved/server default |
| `gemini-cli` | no dedicated provider; fallback to saved/server default |

Automatic resolution is session-only and never writes a preference. Explicit per-origin choices are persisted in cookies, so a user can override the automatic match for one agent without changing the default for another.

> **Codex transport note:** the `codex-sdk` provider id is a stable identifier only — it no longer uses `@openai/codex-sdk` / `codex exec`. It drives a long-lived `codex app-server` process over JSON-RPC (`packages/ai/providers/codex-app-server.ts`), which respects the user's/enterprise-managed approval policy and supports interactive Allow/Deny approvals. The id stays `codex-sdk` to preserve saved cookie preferences, the `agents.ts` mapping, and the UI reasoning-effort gate.

## Annotate Flow

```
User runs /plannotator-annotate <file.md | file.html | https://... | folder/>
        ↓
Claude Code: plannotator annotate subcommand runs
OpenCode/Pi: event handler intercepts command
        ↓
Input type detected:
  .md/.mdx/.txt → file read from disk
  plain-text config/data formats (.yaml .yml .json .jsonc .json5 .toml .ini .cfg .conf .properties .csv .tsv .log .xml .env.example)
             → read from disk, rendered as plain text exactly like .txt (.env itself is
               deliberately excluded — it commonly holds secrets and annotate history
               copies file contents; source-code extensions stay with code review)
             All single-file annotate reads and /api/doc document serves are capped at
             2MB (`MAX_ANNOTATABLE_FILE_BYTES` in `packages/core/annotatable.ts`) —
             larger files get a clear "File too large to annotate (max 2MB)" error.
             Extra extensions listed in `markdownExtensions` (config-only setting,
             e.g. `.livemd`) join this set and render as markdown, frontmatter stripped.
  .html/.htm → file read, rendered as raw HTML by default (or converted to markdown with --markdown)
  https://   → fetched via Jina Reader (default) or fetch+Turndown (--no-jina)
  folder/    → file browser opened, files converted on demand
        ↓
Annotate server starts (reuses plan editor HTML with mode:"annotate")
        ↓
User annotates content, provides feedback
        ↓
Send Annotations → feedback sent to agent session
```

### Tolerant argument resolution

Slash-command hosts forward raw user words to `plannotator annotate` verbatim (on Claude Code through a bash-substitution prefix that runs before the model sees anything), so non-strict invocations resolve their arguments in three tiers. The shared logic lives in `packages/shared/annotate-target.ts` (vendored to Pi) and is wired into the CLI's annotate branch plus the OpenCode and Pi command parsers:

1. A single-token invocation runs the classic pipeline unchanged: a bare correct path behaves exactly as before, and a lone typo'd path still fails with `File not found` and exit `1`.
2. With several tokens, each token is probed; exactly one naming an existing file, URL, or folder proceeds with it (`annotate look at notes.md please` opens `notes.md`). Two or more resolving tokens error naming every candidate rather than guessing, which also means `annotate a.md b.md` (previously: silently opened `a.md`, ignoring `b.md`) is now that error. Bare directory names only count as targets when they are the sole argument, so a stray word matching a directory (or `.`) cannot hijack the fast path; unrecognized dash-prefixed tokens disable the tolerance entirely so a typo'd flag (`--no-jna`) errors the way it always did instead of being silently skipped.
3. When nothing resolves, the CLI emits an agent-addressed handoff that echoes the words tried and asks the reading agent to re-run with a concrete target (content flags such as `--markdown` / `--no-jina` / `--render-html` are echoed for the re-run; transport flags are not). In plain mode the handoff goes to **stdout with exit `0`**, because a non-zero exit from a Claude Code bang-prefix skill aborts the prompt before the model sees any output; with `--json` / `--hook` it goes to stderr with exit `1` so machine-readable stdout stays reserved for decision records. OpenCode and Pi surface the same message as a host notification.

Strict invocations (`--require-approval` / `--result-file`) bypass all three tiers: `args[1]` is the target and a typo'd path stays a startup failure with exit `2`.

The bang prefix in the Claude Code skill is deliberate: #872 (commit `aac5aacb`, "restore `/plannotator-*` bash execution on Claude Code") put it back so the slash command never depends on the model choosing to run the binary. Argument-shape problems belong here in the CLI's resolution, not in the skill templates.

### Strict direct annotate results

Direct `plannotator annotate` invocations may add `--require-approval` and/or `--result-file <path>` only with `--gate --json`; both reject `--hook` and are not shared with OpenCode/Pi slash-command parsing. When neither strict option is present, single-target invocations keep the legacy plaintext, JSON, hook, and exit behavior unchanged; multi-token invocations go through the tolerant tiers described under "Tolerant argument resolution" above.

Strict decisions use one newline-terminated JSON record on stdout and, when requested, identical bytes in the result file. Exit codes follow the grep convention: approval exits `0`; with `--require-approval`, annotated and dismissed decisions are published before exiting `1` (negative human outcome); usage/startup/validation failures — bad flag combinations, strict flags outside `annotate --gate --json`, a missing `--result-file` parent, a pre-existing or dangling-symlink destination, and every annotate startup failure (missing path, unreachable URL, empty folder, ambiguous name, missing file, oversized file) — exit `2` (the gate itself was misconfigured or could not start). Those startup sites exit `1` as before for non-strict invocations, with one deliberate exception: the multi-token zero-resolve handoff is not a startup failure, so in plain non-strict mode it prints on stdout and exits `0` (under `--json`/`--hook` it stays stderr + exit `1`). Under a strict flag `1` is reserved for "the reviewer did not approve", so a typo'd path must never masquerade as a rejection. Post-decision publication failures (destination appears between validation and publish, hard links unavailable) also exit `2`: the result *file* was not published, so they present as environment errors — "the gate could not publish its result" — never as a reviewer outcome, and never as approval (still fail-closed, since only `0` means approved). The stdout decision record is written **before** result-file publication and is still emitted whenever the decision itself completed; only a stdout write failure leaves no record anywhere. Signal deaths keep `128+n`. Result paths resolve from the invocation working directory, require an existing parent and absent destination, and publish via a flushed/closed `0600` same-directory temporary file plus an atomic no-clobber hard link—never copy or overwrite fallback (the `0600` mode is a no-op on Windows, and the atomic link/rename is not followed by a parent-directory fsync, so publication is atomic but not crash-durable). Keep reviewed sources at stable project paths; unique result and diagnostic log files may use a narrow temporary directory. Explicit Close emits `dismissed`; missing results or process/browser failures are recovery cases, never approval.

### Abandoned strict gate sessions

Local direct structured gates (`--gate --json`, not `--hook`, not remote) advertise a client lease in `/api/plan` and serve `/api/annotate/client-lease` (SSE, `ANNOTATE_CLIENT_LEASE_STREAM_PATH`). Each open stream is one connected review surface; the server heartbeats every 5s and, once at least one client has connected, starts a 30s reconnect grace when the last one disconnects. A reconnect inside the grace continues the same review; expiry resolves the gate as the same `dismissed` decision an explicit Close produces, except that it keeps the saved annotation draft so an abandoned review can still be recovered. Approve, feedback, explicit exit, and server stop all cancel a pending expiry. Whichever producer settles the session first wins: every one of them (each connected surface and the expiry itself) goes through a single one-shot settlement, so a decision arriving after the session already resolved is rejected with `409` rather than deleting the draft and reporting success for an outcome the caller never received. Page lifecycle events are deliberately not used: `pagehide`/`beforeunload` also fire on reload and navigation, so they cannot distinguish abandonment from a reconnect. A session that never receives its first client never auto-dismisses, so browser-launch failures still need a caller-side timeout, and remote/shared sessions keep the capability off because tunnel disconnects would read as abandonment — as do `--tailscale`-published sessions, which force local mode but are reached through the serve proxy, whose disconnects would read the same way.

## Archive Flow

```
User runs plannotator archive (CLI)
        ↓
Server starts in mode:"archive", reads ~/.plannotator/plans/
        ↓
Browser opens read-only archive viewer
        ↓
User browses saved plan decisions with approved/denied badges
        ↓
Done → POST /api/done closes the browser
```

During normal plan review, an Archive sidebar tab provides the same browsing via linked doc overlay without leaving the current session.

## Server API

### Plan Server (`packages/server/index.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/plan`           | GET    | Returns `{ plan, origin, previousPlan, versionInfo }` (plan mode) or `{ plan, origin, mode: "archive", archivePlans }` (archive mode) |
| `/api/plan/version`   | GET    | Fetch specific version (`?v=N`)            |
| `/api/plan/versions`  | GET    | List all versions of current plan          |
| `/api/archive/plans`  | GET    | List archived plan decisions (`?customPath=`) |
| `/api/archive/plan`   | GET    | Fetch archived plan content (`?filename=&customPath=`) |
| `/api/done`           | POST   | Close archive browser (archive mode only)  |
| `/api/approve`        | POST   | Approve plan (body: planSave, agentSwitch, obsidian, bear, feedback) |
| `/api/deny`           | POST   | Deny plan (body: feedback, planSave)       |
| `/api/save-notes`     | POST   | Save to external note apps (Obsidian, Bear, Octarine) |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns `{ path, originalName }` |
| `/api/obsidian/vaults`| GET    | Detect available Obsidian vaults           |
| `/api/skills`         | GET    | List global agent skills for comment skill references (`{ skills: [{ name, root, description?, humanOnly, dir }] }`) |
| `/api/skills/content` | GET    | SKILL.md contents of one discovered skill for human-only feedback injection (`?name=<skill>`) returns `{ skill: { name, dir, path, content, truncated, humanOnly } }`; the name is matched against discovery only, never used as a path |
| `/api/reference/obsidian/files` | GET | List vault markdown files as nested tree (`?vaultPath=<path>`) |
| `/api/reference/obsidian/doc`   | GET | Read a vault markdown file (`?vaultPath=<path>&path=<file>`) |
| `/api/plan/vscode-diff` | POST   | Open diff in VS Code (body: baseVersion)   |
| `/api/doc`              | GET    | Serve linked .md/.mdx file (`?path=<path>`) |
| `/api/doc/exists`       | POST   | Batch-validate code-file paths (body: `{ paths: string[], base?: string }`) returns `{ results: { [path]: { status: "found"\|"ambiguous"\|"missing"\|"unavailable", … } } }` |
| `/api/draft`          | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |
| `/api/editor-annotations` | GET | List editor annotations (VS Code only) |
| `/api/editor-annotation` | POST/DELETE | Add or remove an editor annotation (VS Code only) |
| `/api/ai/capabilities` | GET | Check if AI features are available |
| `/api/ai/session` | POST | Create or fork an AI session |
| `/api/ai/query` | POST | Send a message and stream the response (SSE) |
| `/api/ai/abort` | POST | Abort the current query |
| `/api/ai/permission` | POST | Respond to a permission request |
| `/api/ai/sessions` | GET | List active sessions |
| `/api/external-annotations/stream` | GET | SSE stream for real-time external annotations |
| `/api/external-annotations` | GET | Snapshot of external annotations (polling fallback, `?since=N` for version gating) |
| `/api/external-annotations` | POST | Add external annotations (single or batch `{ annotations: [...] }`) |
| `/api/external-annotations` | PATCH | Update fields on a single annotation (`?id=`) |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |

### Review Server (`packages/server/review.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/diff`           | GET    | Returns `{ rawPatch, gitRef, snapshotId, origin, mode?, diffType, base, hideWhitespace, gitContext, agentCwd?, semanticDiff?, callFlow?, sections?, commitInfo?, baseBehindRemote? }`. `snapshotId` identifies this diff snapshot; the client echoes it on `/api/diff/fresh` probes (also returned by the switch/PR endpoints). `sections` is the since-base sidecar (Committed/Changes/Untracked partition); `commitInfo` is the commit-metadata sidecar (subject, markdown body, author + avatar) present only while a `commit:<sha>` diff is active; `baseBehindRemote` flags that the diff base is behind its remote tip. Workspace mode returns `mode: "workspace"` with folder-prefixed paths and no `gitContext`. |
| `/api/diff/switch`    | POST   | Switch diff type, base branch, or whitespace mode (body: `{ diffType, base?, hideWhitespace?, explicitBase? }` — `diffType` includes the `commit:<sha>` family). `explicitBase: true` marks a base the user picked from the picker — the server then honors it verbatim and permanently disables the bare-local-name → `origin/*` canonicalization for the session (echoed bases stay canonicalizable). Response includes `semanticDiff?`, `callFlow?`, `sections?`, `commitInfo?`, `baseBehindRemote?`, or `{ superseded: true }` when a newer concurrent switch has taken over (client ignores it). |
| `/api/commits`        | GET    | One page of the branch's linear `--first-parent` history for the Commits panel (`?limit=&before=`) → `{ commits, hasMore, base }`. Rows carry `isHead` / `isPastBase` (where the branch meets the active base) and best-effort author `avatarUrl`. Plain local git sessions only (PR/workspace/GitButler/jj/p4 → 400); computed against the active diff's cwd, so worktree sessions list the worktree's history. |
| `/api/diff/fresh`     | GET    | Cheap staleness probe: recomputes the VCS fingerprint captured with the current diff snapshot and returns `{ fresh, fingerprint?, baseBehindRemote?, agentCwd? }`. Accepts `?snapshot=<id>` — the client echoes the `snapshotId` it received with its diff, and a mismatch with the server's current snapshot reports stale PER CLIENT (covers the startup base upgrade and cross-tab switches even when the VCS fingerprint matches). `baseBehindRemote` is carried on every response (omitting it would flicker the "behind GitHub" banner); `agentCwd` re-advertises the PR checkout in PR mode. Unfingerprintable modes (e.g. P4) always report fresh to a matching snapshot. Polled by the UI's "Diff out of date · Refresh" notice. |
| `/api/fetch-base`     | POST   | Runs `git fetch` for the base's remote tracking ref, then re-queries the remote tip (fresh `ls-remote`) so narrow-refspec fetches report honestly. Backs the "Baseline is behind GitHub · Fetch" banner. Git-only, base-relative diff types only. |
| `/api/semantic-diff`  | GET    | Runs semantic diff for the active patch and returns parsed sem output or an unavailable/error response (`?fileExt=` / `?fileExts=` optional). |
| `/api/call-flow`      | GET    | Runs snapshot-bound CallDiff analysis for the active Git review (`?snapshot=<id>` required). Returns bounded call trees, raw output, per-file impacts, and explicit skipped-language/file metadata for packs not yet installed. |
| `/api/call-flow/install` | POST | Starts or joins the selective install (`{ languageIds?: [...] }`; omission uses the current review's server-authored plan). The UI calls it automatically once per target per review session after Call flow consent; manual calls remain for Retry and install-ahead. The coordinator deduplicates/queues core and pack targets, a stale-tolerant data-dir lease serializes publication across server processes, Node >= 22 preflight runs before download, and the endpoint enforces the same-origin guard. |
| `/api/call-flow/install-status` | GET | Poll `{ state, stage?, languageIds?, currentLanguageId?, error?, reason? }` across `downloading` / `verifying` / `installing-deps` / `building`. |
| `/api/review-analysis` | GET / POST  | GET refreshes capability adverts without mutating settings; POST persists independent `{ semanticDiff, callFlow }` booleans and returns adverts. |
| `/api/file-content`   | GET    | Returns `{ oldContent, newContent }` for expandable diff context (`?path=&oldPath=&base=`) |
| `/api/git-add`        | POST   | Stage/unstage a file (body: `{ filePath, undo? }`) |
| `/api/feedback`       | POST   | Submit review (body: feedback, annotations, agentSwitch) |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns `{ path, originalName }` |
| `/api/draft`          | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |
| `/api/editor-annotations` | GET | List editor annotations (VS Code only) |
| `/api/editor-annotation` | POST/DELETE | Add or remove an editor annotation (VS Code only) |
| `/api/ai/capabilities` | GET | Check if AI features are available |
| `/api/ai/session` | POST | Create or fork an AI session |
| `/api/ai/query` | POST | Send a message and stream the response (SSE) |
| `/api/ai/abort` | POST | Abort the current query |
| `/api/ai/permission` | POST | Respond to a permission request |
| `/api/ai/sessions` | GET | List active sessions |
| `/api/external-annotations/stream` | GET | SSE stream for real-time external annotations |
| `/api/external-annotations` | GET | Snapshot of external annotations (polling fallback, `?since=N` for version gating) |
| `/api/external-annotations` | POST | Add external annotations (single or batch `{ annotations: [...] }`) |
| `/api/external-annotations` | PATCH | Update fields on a single annotation (`?id=`) |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |
| `/api/agents/capabilities` | GET | Check available agent providers (claude, codex, tour, guide, cursor, opencode, pi, copilot) |
| `/api/agents/review-profiles` | GET | List launchable review profiles (enabled skills + builtin default) |
| `/api/agents/skills` | GET | List all discovered skills for the add-a-review picker (each flagged `enabled`) |
| `/api/agents/review-skills` | POST | Enable a skill as a review (body: `{ name }`); writes `review-skills.json` |
| `/api/agents/guide-instructions` | GET/PUT | Read or replace the Guided Review standing instructions, stored in `${dataDir}/guide-instructions.md` (trimmed, capped; blank PUT deletes). Guide launches whose body carries no `instructions` apply this stored text. |
| `/api/agents/jobs/stream` | GET | SSE stream for real-time agent job status updates |
| `/api/agents/jobs` | GET | Snapshot of agent jobs (polling fallback, `?since=N` for version gating) |
| `/api/agents/jobs` | POST | Launch an agent job (body: `{ provider, command, label, engine?, model?, effort?, reasoningEffort?, thinking?, fastMode?, reviewProfileId?, repairOf?, instructions? }`; `instructions` is guide-only reviewer text appended to the organizer prompt, capped at `GUIDE_EXTRA_INSTRUCTIONS_MAX_CHARS`; when absent, guide launches apply the server-stored standing instructions) |
| `/api/agents/jobs` | DELETE | Kill all running agent jobs |
| `/api/agents/jobs/:id` | DELETE | Kill a specific agent job |
| `/api/pr-diff-scope` | POST | Switch between layer and full-stack diff scope. Response includes `semanticDiff?`. |
| `/api/pr-list` | GET | List PRs for the current repo (cached 30s) |
| `/api/pr-switch` | POST | Switch to a different PR in-place (body: `{ url }`). Response includes `semanticDiff?`. |
| `/api/tour/:jobId` | GET | Fetch Code Tour result (greeting, stops, checklist) for a completed tour job |
| `/api/tour/:jobId/checklist` | PUT | Persist checklist item state for a Code Tour |
| `/api/guide/:jobId` | GET | Fetch Guided Review result (ordered sections with overviews + file refs) for a completed guide job, or a persisted guide via the `saved:{id}` pseudo job id |
| `/api/guide/:jobId/reviewed` | PUT | Persist per-section reviewed state for a guide (live job ids write through to the job's autosaved file; `saved:{id}` ids persist directly) |
| `/api/guides` | GET | List persisted guides for the current repo: `[{ id, label, title, savedAt, progress: { reviewed, total }, moved }]` — `moved` flags a stored head sha that differs from the head currently under review |
| `/api/guides/:id` | DELETE | Delete a persisted guide |
| `/api/guide/:jobId/output` | GET | Fetch a failed guide job's captured raw output for manual repair (404 if none captured) |
| `/api/guide/:jobId/submit` | POST | Manually submit corrected guide JSON for a failed job (body: `{ payload }`) |
| `/api/code-nav/resolve` | POST | Search for symbol definitions and references via ripgrep (body: `{ symbol, filePath, line, charStart, side, language? }`) |
| `/api/code-nav/file` | GET | Read file from working tree for code-nav preview (`?path=`) |

### Annotate Server (`packages/server/annotate.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/plan`           | GET    | Returns `{ plan, origin, mode: "annotate", filePath, sourceInfo?, gate, renderAs?, rawHtml?, previousPlan?, versionInfo?, diffCurrent?, diffHtml? }`. The last four power the per-file version diff: `previousPlan`/`versionInfo`/`diffCurrent` for the markdown diff, `diffHtml` (the previous→current page rendered with inline `<ins>`/`<del>`) for `--render-html` files. |
| `/api/plan/version`   | GET    | Fetch a specific stored version of the annotated file (`?v=N`) |
| `/api/plan/versions`  | GET    | List all stored versions of the annotated file |
| `/api/feedback`       | POST   | Submit annotations (body: feedback, annotations) |
| `/api/approve`        | POST   | Approve without feedback (review-gate UX, `--gate`) |
| `/api/exit`           | POST   | Close session without feedback |
| `/api/save-notes`     | POST   | Save to external note apps (Obsidian, Bear, Octarine) |
| `/api/html-assets/<token>/<path>` | GET | Serve relative support assets for raw HTML annotation sessions |
| `/api/share-html`     | GET    | Lazily prepare portable raw HTML for sharing (`?path=<html-file>` optional) |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns `{ path, originalName }` |
| `/api/doc`            | GET    | Serve linked .md/.mdx/.html file or code file (`?path=<path>&base=<dir>`) |
| `/api/doc/exists`     | POST   | Batch-validate code-file paths (body: `{ paths: string[], base?: string }`) |
| `/api/skills`         | GET    | List global agent skills for comment skill references (`{ skills: [{ name, root, description?, humanOnly, dir }] }`) |
| `/api/skills/content` | GET    | SKILL.md contents of one discovered skill for human-only feedback injection (`?name=<skill>`) returns `{ skill: { name, dir, path, content, truncated, humanOnly } }`; the name is matched against discovery only, never used as a path |
| `/api/draft`          | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |
| `/api/annotate/client-lease` | GET (SSE) | Client lease for local direct structured gates: each open stream is one connected review surface. 404 when the capability is not advertised. |
| `/api/agent-terminal/pty/<token>` | WebSocket | Tokenized PTY bridge for the optional annotate-mode agent terminal |
| `/api/ai/capabilities` | GET | Check if AI features are available |
| `/api/ai/session` | POST | Create or fork an AI session |
| `/api/ai/query` | POST | Send a message and stream the response (SSE) |
| `/api/ai/abort` | POST | Abort the current query |
| `/api/ai/permission` | POST | Respond to a permission request |
| `/api/ai/sessions` | GET | List active sessions |
| `/api/external-annotations/stream` | GET | SSE stream for real-time external annotations |
| `/api/external-annotations` | GET | Snapshot of external annotations (polling fallback, `?since=N` for version gating) |
| `/api/external-annotations` | POST | Add external annotations (single or batch `{ annotations: [...] }`) |
| `/api/external-annotations` | PATCH | Update fields on a single annotation (`?id=`) |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |

All servers use random ports locally or fixed port (`19432`) in remote mode.

### Paste Service (`apps/paste-service/`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/paste`          | POST   | Store compressed plan data, returns `{ id }` |
| `/api/paste/:id`      | GET    | Retrieve stored compressed data            |

Runs as a separate service on port `19433` (self-hosted) or as a Cloudflare Worker (hosted).

## Plan Version History

Every plan is automatically saved to `~/.plannotator/history/{project}/{slug}/` on arrival, before the user sees the UI. Versions are numbered sequentially (`001.md`, `002.md`, etc.). The slug is derived from the plan's first `# Heading` + today's date via `generateSlug()`, scoped by project name (git repo or cwd). Same heading on the same day = same slug = same plan being iterated on. Identical resubmissions are deduplicated (no new file if content matches the latest version).

This powers the version history API (`/api/plan/version`, `/api/plan/versions`) and the plan diff system.

**Annotate mode** also saves history on open, so the same version diff works when annotating a standalone `.md`/`.txt`/`.html` file (or any other supported plain-text file, e.g. `.yaml`/`.json`/`.toml`). It keys the slug by **file path** — `annotate-{sanitized-basename}-{hash8}` — rather than heading + date, so re-opening the same file groups its versions even as its content (and headings) change. **Note this writes a copy of each annotated file's content** under `~/.plannotator/history/` (or `PLANNOTATOR_DATA_DIR`); disable via `PLANNOTATOR_ANNOTATE_HISTORY=0` or `{ "annotateHistory": false }` in `~/.plannotator/config.json` to keep annotate sessions stateless (the version diff is then unavailable, and the durable submitted-feedback records described in the env-var table are also skipped). Single-local-file annotate sessions additionally write each submitted decision to `history/{project}/{slug}/submissions/{timestamp}.md` BEFORE deleting the annotation draft, so feedback survives an agent-side timeout (#678); a failed record write keeps the draft as the recovery copy. For `--render-html` files the diff is rendered as the real page with inline `<ins>`/`<del>` highlights via `htmlDiff()` (`packages/shared/html-diff.ts`).

History saves independently of the `planSave` user setting (which controls decision snapshots in `~/.plannotator/plans/`). Storage functions live in `packages/shared/storage.ts` (runtime-agnostic, re-exported by `packages/server/storage.ts`). Pi copies the shared files at build time. Slug format: `{sanitized-heading}-YYYY-MM-DD` (heading first for readability).

## Plan Diff

When a user denies a plan and Claude resubmits, the UI shows what changed between versions. A `+N/-M` badge appears below the document card; clicking it toggles between normal view and diff view.

**Diff engine** (`packages/ui/utils/planDiffEngine.ts`): Uses the `diff` npm package (`diffLines()`) to compute line-level diffs. Groups consecutive remove+add into "modified" blocks. Returns `PlanDiffBlock[]` and `PlanDiffStats`.

**Two view modes** (toggle via `PlanDiffModeSwitcher`):
- **Rendered** (`PlanCleanDiffView`): Color-coded left borders — green (added), red (removed/strikethrough), yellow (modified)
- **Raw** (`PlanRawDiffView`): Monospace `+/-` lines, git-style

**State** (`packages/ui/hooks/usePlanDiff.ts`): Manages base version selection, diff computation, and version fetching. The server sends `previousPlan` with the initial `/api/plan` response; the hook auto-diffs against it. Users can select any prior version from the sidebar Version Browser.

**Diff annotations:** The clean diff view supports block-level annotation — hover over added/removed/modified sections to annotate entire blocks. Annotations carry a `diffContext` field (`added`/`removed`/`modified`). Exported feedback includes `[In diff content]` labels.

**Annotation hook** (`packages/ui/hooks/useAnnotationHighlighter.ts`): Annotation infrastructure used by `Viewer.tsx`. Manages web-highlighter lifecycle, toolbar/popover state, annotation creation, text-based restoration, and scroll-to-selected. The diff view uses its own block-level hover system instead.

**Sidebar** (`packages/ui/hooks/useSidebar.ts`): Shared left sidebar with three tabs — Table of Contents, Version Browser, and Archive. The "Auto-open Sidebar" setting controls whether it opens on load (TOC tab only). In archive mode, the sidebar opens to the Archive tab automatically.

## Data Types

**Location:** `packages/ui/types.ts`

```typescript
enum AnnotationType {
  DELETION = "DELETION",
  COMMENT = "COMMENT",
  GLOBAL_COMMENT = "GLOBAL_COMMENT",
}

interface ImageAttachment {
  path: string;   // temp file path
  name: string;   // human-readable label (e.g., "login-mockup")
}

interface Annotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: AnnotationType;
  text?: string; // For comment
  originalText: string; // The selected text
  createdA: number; // Timestamp
  author?: string; // Tater identity
  images?: ImageAttachment[]; // Attached images with names
  source?: string; // External tool identifier (e.g., "eslint") — set when annotation comes from external API
  diffContext?: 'added' | 'removed' | 'modified'; // Set when annotation created in plan diff view
  htmlAnchor?: HtmlElementAnchor; // Raw-HTML pinpoint: serialized element anchor for reliable restoration
  htmlAdditionalTargets?: HtmlAnnotationTarget[]; // Raw-HTML shift-click multi-select: extra elements this one comment covers
  startMeta?: { parentTagName; parentIndex; textOffset };
  endMeta?: { parentTagName; parentIndex; textOffset };
}

interface HtmlElementAnchor {
  selector: string; // verified-unique CSS selector built in the viewer bridge
  tagName: string;
  text?: string; // normalized text snapshot; weak selectors fail closed against it
  point?: { x: number; y: number }; // normalized (0..1) selected point inside the element's rect, used by placed markers to reproject against the element's current geometry
}

interface HtmlAnnotationTarget {
  label?: string; // semantic label from the pinpoint hover cascade (e.g. "Button")
  text: string; // capped element text, or an element description when text-less
  anchor?: HtmlElementAnchor; // absent when anchoring failed closed
}

interface Block {
  id: string;
  type: "paragraph" | "heading" | "blockquote" | "list-item" | "code" | "hr" | "table" | "html" | "directive";
  content: string;
  level?: number; // For headings (1-6)
  language?: string; // For code blocks
  alertKind?: "note" | "tip" | "warning" | "caution" | "important"; // GitHub alerts (blockquote subtype)
  order: number;
  startLine: number;
}
```

## Markdown Parser

**Location:** `packages/ui/utils/parser.ts`

`parseMarkdownToBlocks(markdown)` splits markdown into Block objects. Handles:

- Headings (`#`, `##`, etc.) with slug-derived anchor ids
- Code blocks (``` with language extraction)
- List items (`-`, `*`, `1.`)
- Blockquotes (`>`) — including GitHub alerts (`> [!NOTE|TIP|WARNING|CAUTION|IMPORTANT]`) which set `alertKind`
- Horizontal rules (`---`)
- Tables (pipe-delimited) — rendered via `TableBlock` with a `TableToolbar` (copy as markdown/CSV) and `TablePopout` overlay
- Raw HTML blocks (`<details>`, `<summary>`, etc.) — rendered via `HtmlBlock` through `marked` + DOMPurify
- Directive containers (`:::kind ... :::`) — rendered via `Callout`
- Paragraphs (default) with inline extras: bare URL autolinks, `@mentions` / `#issue-refs`, emoji shortcodes, smart punctuation

`exportAnnotations(blocks, annotations, globalAttachments)` generates human-readable feedback for Claude. Images are referenced by name: `[image-name] /tmp/path...`. Annotations with `diffContext` include `[In diff content]` labels.

## Annotation System

**Selection mode:** User selects text → toolbar appears → choose annotation type
**Redline mode:** User selects text → auto-creates DELETION annotation

Text highlighting uses `web-highlighter` library. Code blocks use manual `<mark>` wrapping (web-highlighter can't select inside `<pre>`).

**Raw-HTML annotate:** the sandboxed viewer never mutates the visited page's DOM. Committed annotations render as numbered placed comment markers plus overlay-projected highlight rectangles inside a shadow-rooted fixed overlay host: the durable anchor data (element selector, text snapshot, normalized selected point) is persisted, and the markers/highlights are disposable projections re-resolved from it on every reconcile. Shift-click multi-select joins additional elements to one comment (`htmlAdditionalTargets`).

Known limitation: printing a raw-HTML annotate session prints highlight stripes from a best-effort absolute-coordinate layer and is degraded inside the iframe (pre-existing); element-only targets (SVG anchors, multi-select additional element targets) have no print representation.

## Keyboard Shortcuts

**Location:** `packages/ui/shortcuts/` (engine + scope data), `packages/editor/shortcuts.ts` and `packages/review-editor/shortcuts.ts` (per-app surfaces).

The shortcut system has three layers:

1. **Engine** (`packages/ui/shortcuts/{core,runtime}.ts`) — parser for declarative bindings (`Mod+Enter`, `Alt Alt` double-tap, `Alt hold`), dispatcher, platform-aware formatter (mac glyphs vs. `Ctrl`), validator, and the `useShortcutScope` / `useDoubleTapShortcuts` React hooks. Truly shared — both apps use it as-is.
2. **Scopes** — `defineShortcutScope({ id, title, shortcuts: { actionId: { bindings, description, section, ... } } })`. One scope per UI surface (annotation toolbar, comment popover, file tree, etc.). Lives in `packages/ui/shortcuts/{plan-review,code-review}/` — **the subfolder names which app's UI the scope serves**. Components/Apps wire handlers to a scope via `useShortcutScope({ scope, handlers: { actionId: () => ... } })`.
3. **Surfaces** (`packages/editor/shortcuts.ts`, `packages/review-editor/shortcuts.ts`) — each app composes its scopes into a `ShortcutSurface` (`planReviewSurface`, `annotateSurface`, `codeReviewSurface`). Surfaces feed both the in-app help modal and the marketing site's auto-generated docs page.

**Convention for adding new shortcuts:** define the action in the relevant scope file under the right subfolder (`plan-review/` or `code-review/`), declare the binding(s) and description, then wire a handler at the call site with `useShortcutScope`. The marketing docs page picks it up automatically at next build. Unit tests in `packages/ui/shortcuts.test.ts` enforce normalized binding tokens (`Mod`, `Shift`, `Alt`, `A-Z`, `1-0`, named keys, `F1`–`F12`) and unique scope ids.

**Marketing docs auto-generation:** `apps/marketing/src/lib/shortcutReference.ts` reads the three surfaces and `apps/marketing/src/components/ShortcutReference.astro` renders them as tables. The `/docs/reference/keyboard-shortcuts` page is special-cased in `apps/marketing/src/pages/docs/[...slug].astro` to render the component instead of the markdown body.

## URL Sharing

**Location:** `packages/ui/utils/sharing.ts`, `packages/ui/hooks/useSharing.ts`

Shares full plan + annotations via URL hash using deflate compression. For large plans, short URLs are created via the paste service (user must explicitly confirm).

**Payload format:**

```typescript
// Image in shareable format: plain string (old) or [path, name] tuple (new)
type ShareableImage = string | [string, string];

interface SharePayload {
  p: string; // Plan markdown
  a: ShareableAnnotation[]; // Compact annotations
  g?: ShareableImage[]; // Global attachments
  d?: (string | null)[]; // diffContext per annotation, parallel to `a`
  s?: (string | undefined)[]; // source per annotation (external tool identifier), parallel to `a`
  h?: string; // Raw HTML content (direct HTML rendering mode)
  r?: 'html'; // Render mode flag (omitted = markdown)
}

type ShareableAnnotation =
  | ["D", string, string | null, ShareableImage[]?] // [type, original, author, images?]
  | ["C", string, string, string | null, ShareableImage[]?] // [type, original, comment, author, images?]
  | ["G", string, string | null, ShareableImage[]?]; // [type, comment, author, images?]
```

**Compression pipeline:**

1. `JSON.stringify(payload)`
2. `CompressionStream('deflate-raw')`
3. Base64 encode
4. URL-safe: replace `+/=` with `-_`

**On load from shared URL:**

1. Parse hash, decompress, restore annotations
2. Find text positions in rendered DOM via text search
3. Apply `<mark>` highlights
4. Clear hash from URL (prevents re-parse on refresh)

Known limitation: share links intentionally do not carry HTML element anchors or additional multi-select targets. Restore on the raw-HTML surface is text-search based; this is the contract asserted by `sharing.multiTarget.test.ts`.

## Settings Persistence

**Location:** `packages/ui/utils/storage.ts`, `planSave.ts`, `agentSwitch.ts`

Uses cookies (not localStorage) because each hook invocation runs on a random port. Settings include identity, plan saving (enabled/custom path), and agent switching (OpenCode only).

## Syntax Highlighting

There is **one** highlighter in the app: the Shiki instance `@pierre/diffs` already runs for the code-review diff pane, driven by Shiki's **JavaScript regex engine** (`preferredHighlighter: 'shiki-js'`). `highlight.js` is gone. The wrapper is `packages/ui/utils/codeHighlight.ts`:

- `applyHighlight(el, code, lang, theme)` — imperative drop-in for the old `hljs.highlightElement(el)`. Writes plain text immediately (final size on first paint, no layout shift), then swaps in highlighted markup once the grammar is attached; already-attached grammars highlight synchronously, so there is no flicker on cached highlights. It also enforces that the rendered text is byte-identical to the source and falls back to plain text otherwise, because the annotation layer addresses code blocks by text offset.
- `highlightToHtml(code, lang, theme)` / `ensureHighlight(lang, theme)` — the sync/async pair behind it, for callers that need HTML strings (the code-file hover preview).
- `codeBlockClassName(lang)` — the `pn-code font-mono language-{lang}` class every fenced `<code>` carries. **`pn-code` replaced the old `hljs` class** and is the structural hook `blockTargeting`, vim navigation and `print.css` use (`pre > code.pn-code`); `language-*` is how `blockTargeting` reads a block's language back out of the DOM.
- `onCodeHighlightSwap(listener)` — observes every write `applyHighlight` makes, SYNCHRONOUSLY, immediately after it. Each write replaces the element's children, so it also destroys whatever the annotation layer wrapped inside the fence.

**Code-block annotation marks and highlight swaps.** `web-highlighter` cannot select inside a `<pre>`, so a fenced block is annotated all-or-nothing: one `<mark data-bind-id>` that is the `<code>` element's only child, painted by `paintCodeBlockMark` (`packages/ui/utils/codeBlockMark.ts`) — which MOVES the token spans into the mark rather than flattening them to text, so annotating or re-theming a block never costs it its colours. `Viewer` subscribes to `onCodeHighlightSwap` and re-paints that mark right after any swap, which is what keeps a palette or dark/light change from wiping code-block annotations. Being driven by the swap is also what makes the share/draft restore race safe **by ordering rather than by timing**: a restore that painted before the swap is re-established in the same task the swap ran in, and one that runs after finds the mark already there. Do not "fix" a mark-eating swap by skipping the rewrite when a mark is present — that leaves annotated blocks in stale theme colours.

**Language-less fences render as plain text and are never guessed at (#1212). There is no auto-detection anywhere.** `HighlightedCode` (review suggestions) derives its language from the caller's file path via `detectLanguage`; an unrecognised extension renders plain.

**Theming:** fences resolve the SAME theme the diff pane resolves, via `resolveFenceTheme` / `resolveSyntaxTheme` in `packages/ui/utils/syntaxTheme.ts` (keyed on `(colorTheme, resolvedMode)`; `packages/review-editor/hooks/usePierreTheme.ts` re-exports them). `useFenceTheme()` (`packages/ui/hooks/useFenceTheme.ts`) feeds the components and re-highlights on palette or mode change. Palettes with no Shiki counterpart fall back to `@pierre/diffs`' own `pierre-dark` / `pierre-light`. Consequence: code blocks follow the active palette in both light and dark instead of always rendering github-dark, so **do not add per-theme `.hljs-*`-style token CSS** — pick the right Shiki theme in `SHIKI_THEME_MAP` instead.

**Bundle note:** Pierre imports Shiki's full bundle, so every grammar and theme is already inlined in the single-file builds; reusing its shared highlighter costs no extra bytes and needs no CDN or runtime wasm fetch. The Oniguruma WASM engine is dead weight under `shiki-js` and is aliased to `build/shiki-wasm-stub.ts` in the review, hook and portal Vite configs (via `resolve.alias`, which — unlike `plugins` — is shared with Vite's worker build).

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
  bun build apps/hook/server/index.ts --compile --outfile ~/.local/bin/plannotator
```

Running only `build:opencode` will copy stale HTML files.

## Marketing Site

`apps/marketing/` is the plannotator.ai website — landing page, documentation, and blog. Built with Astro 5 (static output, zero client JS except a theme toggle island). Docs are markdown files in `src/content/docs/`, blog posts in `src/content/blog/`, both using Astro content collections. Tailwind CSS v4 via `@tailwindcss/vite`. Deploys to S3/CloudFront via GitHub Actions on push to main.

The `/docs/reference/keyboard-shortcuts` page is auto-generated from the shortcut registry at build time — see the Keyboard Shortcuts section above. Editing the markdown body has no effect; update the scope files instead.

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
