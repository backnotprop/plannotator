# Plannotator

A plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. Also provides code review for git diffs and annotation of arbitrary markdown files.

> **Reusing the document UI (theme / markdown / editor / settings / comments / layout) in the commercial Workspaces app? Read `packages/ui/README.md` FIRST.** It explains the published `@plannotator/ui` + `@plannotator/core` packages and the host-override seams a host plugs its own backend into via `configurePlannotatorUI()`. A prior from-scratch reimplementation of this UI broke the app and was reverted — do **not** rebuild it or recreate `packages/document-ui`. Add a seam to `@plannotator/ui` instead, keep Plannotator's app unchanged, and never delete working code until a human confirms parity in the browser.

## Project Structure

```
plannotator/
├── apps/
│   ├── hook/                     # Claude Code plugin (no commands/ — core skills installed to ~/.claude/skills act as slash commands)
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json      # PermissionRequest hook config + "modules" (the Claude Code mod)
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
│   ├── ios/                      # The Plannotator iPhone app (SwiftUI, bundle id ai.plannotator.app, iOS 26): project.yml for XcodeGen and the generated Plannotator.xcodeproj (both committed), Plannotator/ (the app), PlannotatorKit/ (local Swift package: the device-door client, models, event stream, pairing link, Keychain, markdown splitter), PlannotatorUITests/ (the XCUITest proof), scripts/proof.ts (runs it against a compiled Inbox) and scripts/gen-colors.ts (Colors.xcassets from packages/ui/themes/plannotator.css, `--check` for drift). Private; its own version line is MARKETING_VERSION in project.yml, outside the release-bumped files. See apps/ios/README.md
│   ├── review/                   # Standalone review server (for development)
│   │   ├── index.html
│   │   ├── index.tsx
│   │   └── vite.config.ts
│   ├── guides-show/               # guides.show — portable Guided Review viewer (multi-file CDN build) + Cloudflare Worker (viewer/, worker/, share/, build/); the Worker is the only host target, self-hosting = deploying it under your own account
│   ├── relay/                     # The Inbox relay (mobile steps R1, R2): a Cloudflare Worker + one Durable Object per mailbox (src/index.ts, src/mailbox.ts), holding only ciphertext and hashes: pushes, and the phone's reads and answers while it is away; src/apns-h2.ts is a standalone HTTP/2 client for APNs over connect(). Private, own version line, owner-deployed (never from CI; README.md has the deploy); its proof (test/) runs `wrangler dev` in the relay workflow and is skipped by the root `bun test`
│   ├── vscode-extension/         # VS Code extension — opens plans in editor tabs
│   │   ├── bin/                   # Router scripts (open-in-vscode, xdg-open)
│   │   ├── src/                   # extension.ts, cookie-proxy.ts, ipc-server.ts, panel-manager.ts, editor-annotations.ts, vscode-theme.ts
│   │   └── package.json           # Extension manifest (publisher: backnotprop)
│   └── skills/                    # Agent skills (agentskills.io format)
│       ├── core/                  # CORE skills (single-sourced) — installed to ~/.claude/skills and ~/.agents/skills (Codex)
│       │   ├── plannotator/           # Knowledge layer: model-invocable CLI reference (subcommands, flags, exit codes) an agent loads on generic "use Plannotator" intent; freshness-guarded against apps/hook/server/cli.ts by plannotator-skill-reference.test.ts. Unreleased subcommands (`HIDDEN_SUBCOMMANDS` in cli.ts, empty today; `inbox` was the last, until the Inbox launched) still run and keep `<sub> --help`, but stay out of `plannotator --help`, "Did you mean" suggestions and this skill (the test requires their absence); un-hide by deleting from that set, adding the top-level usage lines and documenting it here
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
│   │   ├── inbox-mcp.ts          # The Inbox's MCP tools (send_message, read_thread, resolve_message, wait_for_reply, list_decisions, record_decision, get_guide_brief, submit_guide)
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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` / `true` for remote mode, `0` / `false` for local mode, or leave unset for SSH auto-detection. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. Remote ready messages also render a terminal QR code of the advertised URL when stderr is a TTY and the advertised host is overridden away from localhost (a QR of a localhost URL scans to nowhere), so another device can join without retyping the URL. |
| `PLANNOTATOR_AGENT_TERMINAL_REMOTE` | Set to `1` / `true` to enable the annotate-mode agent terminal while `PLANNOTATOR_REMOTE` is active or the session is published with `--tailscale`. Off by default in both cases because the session is reachable by network peers and the PTY token is not an auth boundary. |
| `PLANNOTATOR_RELAY_URL` | The Inbox relay a new mailbox is made at (`packages/server/inbox-relay.ts`). Default `https://relay.plannotator.ai`. Proofs point it at a `wrangler dev` relay; tests at a closed loopback port. A mailbox, once made, stays at the URL `inbox/relay.json` names. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. The Plannotator Inbox ignores it (and `PLANNOTATOR_REMOTE`): it always binds `127.0.0.1` on its last port or a random one; see "Plannotator Inbox". |
| `PLANNOTATOR_URL_HOST` | Display-only hostname for advertised session URLs (issue #657), e.g. a Tailscale MagicDNS name or tailnet IP, so remote-mode links are reachable from another device instead of `http://localhost:<port>`. Host only — bare hostname, IPv4, or bracketed IPv6 (`[fd7a::1]`); the runtime-chosen port is always appended, and anything carrying a scheme, port, path, credentials, or whitespace warns once on stderr and falls back to `localhost`. Strictly display-only and remote-only: binding stays governed by `PLANNOTATOR_REMOTE`; a local session ignores the override (localhost is advertised and opened, since only loopback is bound) with a once-per-process stderr warning to set `PLANNOTATOR_REMOTE=1`, and spawned agent-review jobs keep a pinned `http://127.0.0.1:<port>` API URL so a tailnet-only hostname cannot break local jobs. The sentinel `auto` resolves the host from Tailscale once per process, at first use in a remote session: `tailscale status --json` → `Self.DNSName` (trailing dot stripped), falling back to the single `tailscale ip -4` CGNAT (100.64.0.0/10) address; detection failure warns once on stderr and falls back to `localhost`, and detection never changes binding — `auto` is as display-only as any explicit host. Can also be set via `~/.plannotator/config.json` (`{ "urlHost": "host" }` or `{ "urlHost": "auto" }`); the env var takes precedence, and an empty-but-set env var (`PLANNOTATOR_URL_HOST=`) suppresses a config-file `urlHost`. Default: unset (`localhost`). |
| `PLANNOTATOR_ALLOWED_HOSTS` | Extra hostnames the servers answer on, for the Host allowlist every plan, review, annotate, archive and goal-setup server (and the Plannotator Inbox) applies to every request (see "Host allowlist" under Server API). Comma list of hostnames; a leading dot (`.example.com`) also matches subdomains; `*` turns the check off. For proxies and tunnels that forward their own hostname (a reverse proxy, a Docker service name, a LAN DNS name in remote mode). Not needed for GitHub Codespaces or VS Code dev tunnels (their forwarders present `Host: localhost:<port>`) or for a code-server / Coder port proxy (recognized from `VSCODE_PROXY_URI`). Read once per server start. Default: unset. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_AI` | Set to `disabled` to disable Ask AI and the Review Agents / Guided Review execution surfaces, including provider and agent-job endpoints. Persisted guide data is retained and its server APIs remain available, but the in-app history browser is hidden while AI is disabled. External agents can still open reviews and submit annotations. The explicit annotate-mode agent terminal is separate and remains controlled by its own settings. Default: enabled. |
| `PLANNOTATOR_SHARE` | Set to `disabled` to turn off URL sharing entirely, including Guided Review share links (the review UI hides "Create share link", `POST /api/guide/:jobId/share` answers `403 { error: "sharing disabled" }`, and `plannotator guide share` refuses with exit 1). Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "share": "disabled" }`); the env var takes precedence. |
| `PLANNOTATOR_SHARE_URL` | Custom base URL for share links (self-hosted portal). Default: `https://share.plannotator.ai`. |
| `PLANNOTATOR_PASTE_URL` | Base URL of the paste service API for short URL sharing. Default: `https://plannotator-paste.plannotator.workers.dev`. |
| `PLANNOTATOR_CLAUDE_MOD` | Switch for the Claude Code mod (non-blocking plan review, annotate, code review and annotate-last, the `plannotator` tool, the take-over of agent-run Bash `plannotator` commands, plus Ask this session; see "Claude Code mod"). **Default: on** wherever Claude Code runs hooks modules (2.1.287+, interactive CLI sessions; the mod still stands down by itself in `-p` / SDK sessions and where `/bin/sh` is missing, i.e. Windows). Set to `0` / `false` / `off` / `disabled` to turn it off, which leaves the module inert (every hook passes through, no command or tool is registered, no Bash command is taken over, no environment is set) so the classic PermissionRequest hook and `/plannotator-*` skills run exactly as before; `1` / `true` / `on` force it on, and empty or unrecognized counts as unset (on). Can also be turned off via `~/.plannotator/config.json` (`{ "claudeCodeMod": false }`, read from the data dir); the env var takes precedence (`resolveClaudeCodeMod` in `packages/shared/config.ts`, mirrored by `apps/hook/hooks/mod/enabled.ts` because a hooks module can import only its own files; `enabled.test.ts` keeps them in step). Read once when Claude Code starts, so a change applies to the next session start. Set it in the shell that starts Claude Code or in Claude Code's `settings.json` `env`. The plugin installs from the repo and the `plannotator` binary updates separately, so the mod also runs against older binaries; see "Version skew" in the mod section for what degrades. |
| `PLANNOTATOR_AGENT_TOOL` | Switch for the `plannotator` agent tool (`packages/shared/plannotator-tool.ts`) on the hosts that register it. **Default per host** (owner's call, one table: `AGENT_TOOL_DEFAULTS` in `packages/shared/config.ts`): **on for the Claude Code mod** (the tool is deferred behind tool search there, so it costs about its name until used), **off on Pi and OpenCode 2** (a full tool definition in every request). `1` / `true` / `on` turn it on and `0` / `false` / `off` / `disabled` turn it off on every host, overriding the host default in both directions; empty or unrecognized counts as unset. Off removes ONLY the tool: the `/plannotator-*` slash commands, plan review, Ask this session and (Claude Code) the take-over of agent-run Bash `plannotator` commands, which adds nothing to the model's context, are unchanged, and an agent that wants Plannotator runs the CLI. Can also be set via `~/.plannotator/config.json` (`{ "agentTool": true }` / `false`, read from the data dir; allowlisted, boolean only, on `POST /api/config` in both runtimes, which refuses a cross-origin write with `403` on every plan, review and annotate server: `isSameOriginOrNoOrigin` in `packages/shared/request-origin.ts`, the guard the other state-changing endpoints use (review progress, guide share links, the CallDiff install), since a page on another site can send a preflight-free `text/plain` POST. It passes a request with no Origin, an Origin naming the request host, or the browser's own `Sec-Fetch-Site: same-origin`, and refuses `Origin: null`, `same-site` and `cross-site`. The `Sec-Fetch-Site` leg is what lets the VS Code panel write: its cookie proxy serves the page from `http://127.0.0.1:<proxy port>` and rewrites Host to the server, so Origin and Host differ. Before it, `/api/review-progress` and `/api/call-flow/install` were already refused in the VS Code panel (silently: the client ignores the failure); they work there now too. `cookie-proxy.ts` additionally re-anchors an Origin equal to its own origin onto the upstream, for browsers without Fetch Metadata; `vscode-proxy-writes.test.ts` (Bun and Pi) covers both shapes); the env var takes precedence (`resolveAgentTool(config, env, host)` in `packages/shared/config.ts`; the mod's mirror `resolveAgentToolEnabled` lives in `apps/hook/hooks/mod/enabled.ts`, kept equal to the claude-code row by `enabled.test.ts`). `getServerConfig(gitUser, agentToolIntegration)` advertises it for a later Settings toggle / one-time "turn it on" offer, but only where the integration that started the server registers the tool: `agentToolHost` is the session-bridge host, not the agent origin (Bun: `agentToolHostForServer` in `packages/server/ai-runtime.ts`, an in-process bridge's host, else `launchingSessionHost()`, the `PLANNOTATOR_SESSION_BRIDGE_HOST` the Claude Code mod / OpenCode 2 plugin hand the CLI, read once at startup and kept in remote mode and after the `--tailscale` discard, where Ask this session is off but the integration still started the session; Pi: always `pi`, since its servers run inside the extension). With no such integration (the classic Claude Code hook, the mod off, `-p`, Windows, OpenCode 1, a person at a shell) every `agentTool*` field is absent except an `agentTool` config.json sets. Known gap: OpenCode 2's embedded plan review passes its bridge only when the host has `session.generate`, so on an older V2 host that one review advertises nothing. Fields: `agentTool` (the config value, or the host default while unset), `agentToolConfigured` (config.json holds an explicit choice), `agentToolEnv` (present when the env var overrides the file) and `agentToolEnabled` (the effective value, for the NEXT session). **Read once per session start and never mid-session**, because the tool list is part of every request's prompt prefix and changing it would miss the prompt cache: a change applies to the next session (Pi: the next session or `/reload`; OpenCode 2: the next OpenCode start; Claude Code: the next Claude Code start). |
| `PLANNOTATOR_INBOX_TOOL` | Switch for the Plannotator Inbox's `plannotator_inbox` agent tool and its reply wake on the hosts that register it (the Claude Code mod, see "The Plannotator Inbox" in the mod section; Pi and OpenCode, see "Agent connections" in "Plannotator Inbox"; OpenCode 1 gets the tool without the wake). Only ever on where `inbox/inbox.json` exists in the data dir (the person ran the Inbox once); otherwise nothing is registered and nothing polls. Default per host `INBOX_TOOL_DEFAULTS` (= `AGENT_TOOL_DEFAULTS`: on for the Claude Code mod, off on Pi and OpenCode 2). `1` / `true` / `on` and `0` / `false` / `off` / `disabled` decide every host; empty or unrecognized counts as unset. Also `~/.plannotator/config.json` `inboxTool`: a boolean for every host, or one per host (`{ "inboxTool": { "pi": true } }`), which the Inbox's own Settings writes (`POST /api/inbox/settings`). The env var wins (`resolveInboxTool(config, env, host)` in `packages/shared/config.ts`; the mod's mirror `resolveInboxToolEnabled` in `apps/hook/hooks/mod/enabled.ts`, kept equal to the claude-code entry by `enabled.test.ts`). Independent of `PLANNOTATOR_AGENT_TOOL`. Read once per session start and never mid-session (the tool list is part of the prompt prefix), so a change applies to the next session: Pi, the next session or `/reload`; OpenCode, the next OpenCode start; Claude Code, the next Claude Code start (the mod decides at the process's first `session.start`). Documented for users in `apps/marketing/src/content/docs/reference/inbox.md`. |
| `PLANNOTATOR_HOST_RESULT_FILE` | Set by a host that starts the CLI detached (the Claude Code mod): when a review, annotate, annotate-last or `claude-mod-plan` session settles, the CLI writes one JSON decision record there atomically (mode 0600), with the agent message composed from the configured prompts. Only a path named `result.json` inside `<data dir>/claude-code-mod/` is accepted (`isAllowedHostResultPath`); anything else is ignored with a stderr warning, so the variable cannot make the CLI create or replace an arbitrary file. Taken at startup and removed from the environment. Stdout is unchanged. See "Claude Code mod". |
| `PLANNOTATOR_HOST_MESSAGES_FILE` | Set by the Claude Code mod for `annotate-last --stdin` (ignored without `--stdin`): a `messages.json` inside `<data dir>/claude-code-mod/` (`isAllowedHostMessagesPath`; anything else is ignored with a stderr warning) holding `{ v: 1, messages: [{ messageId, text, timestamp? }] }`, newest first, which the CLI shows as the message picker instead of the single stdin message. Validated fail-closed (1..25 entries, string fields, unique ids, 2 MiB per message, 8 MiB file); a malformed file exits 1 with the reason. Taken at startup and removed from the environment. A CLI that predates it ignores it and opens the stdin text. See "Claude Code mod". |
| `PLANNOTATOR_SESSION_TAG` | Set by the Claude Code mod in its session's environment (`claude-code:<session id>`), so processes the session starts can be matched to it; recorded as `hostSession` in the `sessions/` registry. Not meant to be set by hand. |
| `PLANNOTATOR_HOST_REVIEW_ID` | Set per launch by the Claude Code mod and the OpenCode plugin to the review's `pn-` id; the CLI takes it at startup (validated `pn-` + 6 hex, scrubbed from the environment) and records it as `reviewId` in the `sessions/` registry, which `plannotator sessions` (and `--json`) prints beside each session's full `target`. Not meant to be set by hand. |
| `PLANNOTATOR_MOD_DEBUG` | Set to `1` before starting Claude Code to have the Claude Code mod write `claude-code-mod/debug.log` in the data dir (launches, results, turns, bridge commands). Default: off. |
| `PLANNOTATOR_ORIGIN` | Explicit agent-origin override at the top of the detection chain. Valid values: `claude-code`, `amp`, `droid`, `opencode`, `codex`, `copilot-cli`, `gemini-cli`, `kiro-cli`, `mistral-vibe`, `pi`, `oh-my-pi`. Invalid values silently fall through to env-based detection. Unset by default. |
| `PLANNOTATOR_JINA` | Set to `0` / `false` to disable Jina Reader for URL annotation, or `1` / `true` to enable. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "jina": false }`) or per-invocation via `--no-jina`. |
| `PLANNOTATOR_ANNOTATE_HISTORY` | Set to `0` / `false` to disable ALL annotate-session writes to the data dir: per-file version history (no copies of annotated files are written; the annotate version diff is unavailable) AND the durable submitted-feedback records (#678) that single-local-file annotate sessions otherwise write to `history/{project}/{slug}/submissions/` before deleting the draft on submit. Disabling it keeps annotate sessions fully stateless but also gives up that submit crash-recovery record. URL and annotate-last sessions never write either kind of data regardless of this flag. Folder sessions write no submitted-feedback records, but they do participate in per-file version history: the first time a session serves a file through /api/doc it snapshots that file (lazily, memoized per resolved path for the life of the server), which is what powers the per-file version diff when a folder file is reopened later; setting this flag to 0 disables those folder snapshots too. A review of several files (bundle) snapshots each of its text files when it opens, through the same pipeline, governed the same way. Setting it to 0 additionally suppresses **feedback archive** records for every annotate surface (single file, folder, URL, live app, annotate-last), so "fully stateless annotate session" stays literally true regardless of `PLANNOTATOR_FEEDBACK_HISTORY`, with one exception: annotation drafts (`drafts/`, including the path-keyed copies described under "Annotate drafts follow the file") are crash recovery and are still written; they are deleted when the review is decided. Raw-HTML and live-app pinpoints write their element context (selector, ancestor path, allowlisted attributes, visible text, a collapsed HTML skeleton, and the live route) into the submission records and drafts too; form values and inline handlers are never captured. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "annotateHistory": false }`); the env var takes precedence. |
| `PLANNOTATOR_FEEDBACK_HISTORY` | Set to `0` / `false` to stop archiving submitted feedback under `~/.plannotator/feedback/` (or `PLANNOTATOR_DATA_DIR`). Default: enabled, which appends one record per submission at decision-settlement time on all three surfaces and in both runtimes: plan approve/deny, code review Send Feedback / Approve (LGTM) / Close, and every annotate submit / approve / close. A review posted straight to GitHub, GitLab or Bitbucket with `POST /api/pr-action` is delivered to the platform and is not archived locally yet. **Note that this writes the user's own feedback text, the document and code excerpts it quotes, and per-annotation metadata to disk, and nothing prunes the directory** (same policy as `plans/`, `history/`, and `guides/`); delete `~/.plannotator/feedback/` or a project subdirectory to forget, or set this to 0 to never write. Code-review records carry diff IDENTITY only (vcsType, diffType, base, gitRef, snapshotId, cwd, PR metadata, changed-file count, patch byte count), never the patch bytes; plan records carry the decision text plus a reference to the `history/{project}/{slug}/NNN.md` version the decision was made on, never a second copy of the plan. Externally sourced annotations (linters, review agents, WebMCP browser agents) are included but keep their `source` / `author` tags, so `source == null` selects the reviewer's own comments; agent job outputs (guides, tours) are not archived. This knob governs only the new archive: the `planSave` decision snapshots in `plans/` and the #678 annotate submission records under `history/` are unaffected. Annotate surfaces honor `PLANNOTATOR_ANNOTATE_HISTORY` as well. Can also be set via `~/.plannotator/config.json` (`{ "feedbackHistory": false }`); the env var takes precedence. |
| `PLANNOTATOR_GUIDE_VIEWER_URL` | Base URL of the portable Guided Review viewer that exported guides pin (default `https://guides.show/v1/`). Must be `https:` (or `http:` on localhost for local viewer builds — `bun run --cwd apps/guides-show serve:local`); anything else is ignored. Read by the export endpoints of both servers and by `plannotator guide export` (which also accepts `--viewer-url`). |
| `PLANNOTATOR_GUIDE_SHARE_URL` | Base URL of the guide host that Guided Review share links are created on: the review UI's "Create share link", `plannotator guide share`, and `plannotator guide unshare` upload to and delete from it (default `https://guides.show`; the origin of your own deployment of its Cloudflare Worker otherwise, see the `apps/guides-show` README). Must be `http(s)`; credentials, query and fragment are dropped and a trailing slash is trimmed; an invalid value warns once on stderr and falls back to the default so a share setting can never break a server launch or CLI run. An empty-but-set env var counts as unset. Can also be set via `~/.plannotator/config.json` (`{ "guideShareUrl": "https://guides.example.com" }`); the env var takes precedence; there is no per-invocation flag. Resolved by `resolveGuideShareUrl` in `packages/shared/config.ts`. Whether sharing is allowed at all is `PLANNOTATOR_SHARE` (`disabled` turns guide share links off entirely). Removal always goes to the host a saved guide's record names, never merely the currently configured URL, so changing this after sharing does not strand a link. |
| `PLANNOTATOR_BITBUCKET_TOKEN` | Atlassian API token for Bitbucket Cloud PR review (`plannotator review https://bitbucket.org/<workspace>/<repo>/pull-requests/<id>`). Bitbucket has no gh-like CLI, so the provider (`packages/shared/pr-bitbucket.ts`, vendored to Pi) calls the REST API 2.0 with `fetch`. Scopes needed: `read:user:bitbucket`, `read:repository:bitbucket`, `read:pullrequest:bitbucket`, `write:pullrequest:bitbucket` (app passwords are deprecated by Atlassian and not supported). A missing, rejected or under-scoped token fails `checkAuth` with a message naming these env vars and scopes; the token is never logged, echoed in an error, or sent to the browser (`getServerConfig` allowlists its keys). Can also be set via `~/.plannotator/config.json` (`{ "bitbucketToken": "..." }`, plain text, so prefer the env var); the env var takes precedence, and the token and email always come from the same source (`resolveBitbucketCredentials` in `packages/shared/config.ts`). |
| `PLANNOTATOR_BITBUCKET_EMAIL` | The Atlassian account email that owns `PLANNOTATOR_BITBUCKET_TOKEN`; with it the token goes out as HTTP basic auth, without it as a Bearer token. Config key `bitbucketEmail`. |
| `PLANNOTATOR_BITBUCKET_API_URL` | Testing / proxy knob: base URL of the Bitbucket Cloud REST API (default `https://api.bitbucket.org/2.0`). The fake API in `tests/test-fixtures/bitbucket/fake-bitbucket.ts` is reached through it. Only `https:` or loopback `http:` is accepted (credentials are sent there); anything else warns once and uses the default. Redirects (the PR `/diff` and `/diffstat` endpoints answer with one) and pagination `next` links are followed only within this origin. |
| `PLANNOTATOR_GUIDE_HISTORY` | Set to `0` / `false` to disable persisting successful Guided Reviews (no guide copies are written to the data dir; the "Previous guides" list is then never populated, though already-saved guides remain readable and listed). **Note that a persisted guide includes a full copy of the diff it was generated against** — `history/.../guides/{id}.patch` beside the `{id}.json` envelope, uncapped, as large as the diff — because that patch is what a later portable export or share link renders (the diff is captured when the guide job launches, never re-read from the working tree). Deleting a guide removes both files; nothing prunes the directory otherwise. Turning this flag off skips the patch copy too, at the cost of exports and share links for guides from that session once the server exits. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "guideHistory": false }`); the env var takes precedence. |
| `PLANNOTATOR_REVIEW_PROGRESS` | Set to `0` / `false` (also `off` / `disabled`) to stop code review remembering which files you marked viewed across review sessions. Default: enabled, which writes one small JSON record per file you mark viewed or unviewed under `review-progress/{scopeHash}/{pathHash}.json` in the data dir (`~/.plannotator` or `PLANNOTATOR_DATA_DIR`), for local Git and PR reviews. **Each record carries the repo-relative file path in plain text** (plus a content fingerprint and the viewed flag; the scope directory name is a hash of the worktree root, branch and comparison, or of the PR URL). Nothing prunes the directory; delete `review-progress/` to forget, and `plannotator uninstall --purge` removes it (a plain uninstall keeps it). With the knob off the review server neither reads nor writes these records: `/api/review-progress` answers `{ available: false }` and viewed marks ride the annotation draft instead, exactly as in workspace, non-Git and piped-patch reviews. Records already on disk are left alone. Can also be set via `~/.plannotator/config.json` (`{ "reviewProgress": false }`); the env var takes precedence, and an empty or unrecognized env value counts as unset. Resolved by `resolveReviewProgress` in `packages/shared/config.ts`, read on every review snapshot in both runtimes. |
| `PLANNOTATOR_AUTO_UPDATE` | Opt-in background auto-update (#1634). Set to `1` / `true` / `on` to enable, `0` / `false` / `off` / `disabled` to force off; empty or unrecognized counts as unset. **Default: off**; nothing changes for anyone who has not opted in. Can also be set via `~/.plannotator/config.json` (`{ "autoUpdate": true }`) or Settings → General → "Keep Plannotator up to date" (allowlisted on `POST /api/config` in both runtimes; `getServerConfig` always sends the config-file value plus `autoUpdateEnv` when this env var overrides it, and the toggle is disabled with a note in that case); the env var takes precedence (`resolveAutoUpdate` in `packages/shared/config.ts`). The whole mechanism is "run the normal install script": the compiled CLI (`apps/hook/server/index.ts`, `registerCliSession`) calls `scheduleAutoUpdateCheck` (`packages/server/auto-update.ts`) each time a session registers, which returns immediately and runs on a later, unref'd tick, so it is never awaited and adds no latency to any hook, review, annotate or CLI command. The check is skipped for dev/source runs (no `__CLI_VERSION__`), when the running executable is not the file the install script manages (`~/.local/bin/plannotator`, `%LOCALAPPDATA%\plannotator\plannotator.exe`), and is throttled to once per 24h (`lastCheckAt` in `update-state.json` in the data dir). It asks GitHub `releases/latest` (stable only, strictly newer, never a downgrade); if another Plannotator session is open (a live pid other than ours in the `sessions/` registry) it logs, does NOT spend the 24h window, and retries on the next session start. Otherwise it takes `update.lock` (stale after 1h) and spawns a detached wrapper that downloads `https://plannotator.ai/install.sh` (Windows: `install.ps1`) and runs it with `--version vX.Y.Z --non-interactive` (`-Version … -NonInteractive`), all output to `update.log`; the wrapper writes the exit code to `update-result.json` and releases the lock. The script applies the user's own `skipInstall` config and saved install prefs as a manual run would, and install flags are remembered: after a successful run each installer (`install.sh`, `install.ps1`, `install.cmd`, including the `--minimal` early exit) writes the install-affecting choices it took from its COMMAND LINE to `install-flags.json` in the data dir as neutral ids (`{"v":1,"flags":["minimal","skip-codex"]}`; the set is `minimal`, `no-minimal`, `verify-attestation`, `skip-attestation`, `with-call-flow`, `skip-codex`, `skip-gemini`, `skip-kiro`, `skip-vibe`, `skip-opencode`, `skip-skills`; never raw argv, paths or secrets), and a manual run with none of them overwrites it with an empty set, i.e. back to defaults. Auto-update reads it (`readInstallFlags`), keeps only allowlisted ids (unknown entries and a mutually-exclusive pair are dropped and logged), and passes them re-spelled per installer (`--skip-codex` / `-SkipCodex`): as argv after the `sh -c` wrapper (`"$@"`) on POSIX, and on Windows as the `PLANNOTATOR_UPDATE_FLAGS` env var that the `-EncodedCommand` wrapper re-checks against the same allowlist and splats as an array. A missing or malformed file means no flags (today's behavior) plus an `update.log` line. Inside the script the flag still beats the env var, which beats config. The OpenCode and Pi runtimes never arm the trigger. The next UI load (plan, annotate, review) shows a one-time toast from `autoUpdateNotice` on `/api/plan` / `/api/diff` (Bun servers only, and only when the compiled CLI enabled it): "Updated to vX" once the running binary is that version, or "Auto-update failed" with the log path when the script exited non-zero; "seen" is the `plannotator-auto-update-notice-seen` cookie. Install scripts replace the binary safely for this: `install.sh` stages next to the target and renames over it (a running process keeps its inode), `install.ps1` / `install.cmd` rename a running `plannotator.exe` aside to `plannotator.exe.old*` and sweep those on a later run. `plannotator uninstall --purge` removes the four `update*` files and `install-flags.json`. |
| `PLANNOTATOR_CURSOR_SANDBOX` | Set to `0` / `false` / `disabled` to stop passing `--sandbox enabled` when launching Cursor's `agent` CLI for review jobs — the flag pair is omitted entirely, deferring to the user's own Cursor Agent sandbox configuration. For systems where Cursor's sandbox cannot start (NixOS, AppArmor-restricted Linux). Default: enabled (`--sandbox enabled` is passed). Can also be set via `~/.plannotator/config.json` (`{ "cursorSandbox": false }`); the env var takes precedence. Note: opting out means the review job's write protection relies on `--mode ask` plus the user's own Cursor configuration. |
| `PLANNOTATOR_CLAUDE_SANDBOX` | Set to `0` / `false` / `disabled` to turn Claude Code's own sandbox OFF for Claude-engine agent jobs (code review, Code Tour, Guided Review) by passing `--settings '{"sandbox":{"enabled":false}}'` (#1627). For Linux systems where the sandbox cannot start (no bubblewrap/socat, AppArmor-restricted user namespaces) while `~/.claude/settings.json` enables it: jobs run with `--permission-mode dontAsk`, so Claude's unsandboxed fallback is refused and every Bash call fails. Default: enabled, meaning Plannotator passes nothing and the user's own Claude Code sandbox setting applies. Opting out runs the job's commands without OS containment, the same as for any user who never enabled Claude's sandbox (Claude Code's default). `--tools`, the `--allowedTools` prefixes, the `--disallowedTools` list and `dontAsk` are unchanged, but the command rules limit what the model can run rather than containing it (Claude Code matches rule text, so a deny rule covers the spellings a model normally writes, not every spelling a program accepts), so treat the opt-out as removing the only OS-level boundary. Managed (enterprise) settings still outrank `--settings`. When a Claude job finishes with no shell command that ran and at least one refused command its own `--allowedTools` admits outright — a plain invocation with no operators, substitutions or variables, which `dontAsk` never refuses unless the shell itself cannot run (`detectClaudeShellBlocked`), the job carries a `warning` pointing at this knob, shown in the Agents tab and the job detail panel; the sandbox is never turned off automatically. Independently of this knob, every Claude agent job passes `--strict-mcp-config` (no `--mcp-config`, so none of the user's MCP servers load into a job) and an `--append-system-prompt` telling the model to run one simple command at a time, since `dontAsk` refuses compound commands (`$(...)`, `&&`, pipes) as a whole (`claudeJobIsolationArgs` in `packages/server/claude-review.ts`, vendored to Pi), plus `--setting-sources user`, so the user's own settings (auth, env, sandbox preference) and managed policy apply but the job directory's project/local `.claude/settings*.json` (a PR checkout is someone else's branch) cannot add allow rules or hooks to a job. Side effects: Claude auth or provider env kept only in a repo's `.claude/settings.json` / `.claude/settings.local.json` does not apply to jobs, and neither does a sandbox setting or `permissions.deny` set only in project settings; managed settings still apply. All three job kinds share ONE command allow/deny definition (`CLAUDE_JOB_ALLOWED_TOOLS` / `CLAUDE_JOB_DISALLOWED_TOOLS` via `claudeJobToolArgs`, same file): exactly the read-only commands the prompts instruct (git status/diff/log/show/blame/merge-base/rev-parse/ls-files/ls-tree, `git branch --show-current`, `git remote -v` / `get-url`, the read-only jj commands, `gh pr view|diff` / `gh issue view` and the glab equivalents, `wc`), with deny rules for git `--output` and `-c` / `--config-env`, jj `--config*` / `--tool`, and `git grep`, `git ls-remote`, `gh api`, `glab api`. There is no `git -C`: workspace prompts send the combined diff inline and point the model at the folder-prefixed files. `claude-job-isolation.test.ts` reads the commands out of the real prompt text and fails if the allowlist stops admitting one. `detectClaudeShellBlocked` also takes the job's `--disallowedTools`, so a refusal a deny rule issues by design never reads as a blocked shell. Can also be set via `~/.plannotator/config.json` (`{ "claudeSandbox": false }`); the env var takes precedence. |
| `PLANNOTATOR_GIT_REMOTE_CHECK` | Set to `0` / `false` / `disabled` to stop code review contacting the git remote (issue #1553). Default: enabled, which runs `git ls-remote --symref origin HEAD` to discover the remote default branch and to compare the remote tip against the local tracking ref for the "Baseline is behind GitHub" banner. That probe is **not** on a timer: it runs at startup (the compare-target detection plus the staleness probe), on `/api/diff` page load, on `/api/diff/switch` (the diff-type/base pickers and the "Diff out of date · Refresh" button), and on the explicit `/api/fetch-base`, each rate limited to once per 60s per session, with the interval DOUBLING on failure up to a 15-minute cap and resetting to 60s on the next success (`nextRemoteBaseCheckInterval` in `packages/shared/review-core.ts`, shared by both runtimes). It is deliberately absent from `/api/diff/fresh`, which the client polls every 5s for as long as the page is open — hanging the probe there made an idle review query the remote once a minute forever, which on a smartcard-backed SSH setup is one hardware-key touch prompt per minute with nothing on screen to explain it. With the check off the session makes **zero** `ls-remote` calls, startup probes included: the compare target stays whatever LOCAL ref discovery resolved (`getDefaultBranch`: `origin/HEAD` → `origin/main` → `main` → …), `baseBehindRemote` never rides any payload so the banner never shows, and `POST /api/fetch-base` stays available because an explicit Fetch is the user asking for the network — note that with the banner gone so is its one-click Fetch button, which lives in that banner, so the endpoint matters to API callers rather than to the reviewer, and its post-fetch `refreshRemoteBaseInfo()` is a no-op under the opt-out. Only plain local git sessions are affected (PR, jj, GitButler, P4, workspace and static-patch sessions never ran the check). Can also be set via `~/.plannotator/config.json` (`{ "gitRemoteCheck": false }`); precedence is `review --no-git-remote-check` flag > env var > config (`resolveGitRemoteCheck` in `packages/shared/config.ts`). The flag is parsed by the shared `parseReviewArgs`, so it works on every host that forwards review arguments — Claude Code, OpenCode, and Pi — not just the Bun CLI. |
| `PLANNOTATOR_TODO_PROVIDER` | Set to `off` / `0` / `false` / `disabled` to stop mirroring the approved plan checklist into an editable todo provider during execution. Default: enabled, which syncs only when a provider is detected (currently pi-todos: detected when its todo directory exists — `<cwd>/.pi/todos` by default, or wherever `PI_TODO_PATH` redirects it when set). The repo-implied `<cwd>/.pi/todos` must realpath to a location inside the project or the provider reads as absent and never writes, so a symlink committed into a hostile repo cannot redirect todo writes out of it; an explicitly set `PI_TODO_PATH` is the user's own choice and is honored verbatim, including outside the project. The mirror is additive — the progress widget is unaffected either way — and sync is one-way, so provider-side edits never feed back into plan execution. Can also be set via `~/.plannotator/config.json` (`{ "todoProvider": "off" }`); the env var takes precedence. |
| `JINA_API_KEY` | Optional Jina Reader API key for higher rate limits (500 RPM vs 20 RPM unauthenticated). Free keys include 10M tokens. |
| `PLANNOTATOR_DATA_DIR` | Override the base data directory. Supports `~` expansion. Default: `~/.plannotator`. When unset, an existing `~/.plannotator` always wins; if it doesn't exist and `$XDG_DATA_HOME` is set to an absolute path, `$XDG_DATA_HOME/plannotator` is used; otherwise `~/.plannotator` (the XDG spec's implicit `~/.local/share` default is deliberately not applied). All data (plans, history, drafts, config, hooks, sessions, debug logs, IPC registry) is stored under this directory. |
| `PLANNOTATOR_FILE_BROWSER_MAX_FILES` | File-discovery limit: regular files inspected by CLI markdown/folder resolution and startup code-file warming, supported files returned by the file browser, and directories scanned during multi-repo workspace discovery (symlinks may point outside the workspace, so the budget — not the root — bounds that walk). Must be a positive integer; invalid, zero, or negative values use the default of `5000`. |
| `PLANNOTATOR_GLIMPSE` | Set to `0` / `false` to disable the Glimpse native window even when `glimpseui` is installed. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "glimpse": false }`). |
| `PLANNOTATOR_GLIMPSE_WIDTH` | Width in pixels for the Glimpse native window. Default: `1280`. |
| `PLANNOTATOR_GLIMPSE_HEIGHT` | Height in pixels for the Glimpse native window. Default: `900`. |
| `PLANNOTATOR_VERIFY_ATTESTATION` | **Read by the install scripts only**, not by the runtime binary. Set to `1` / `true` to have `scripts/install.sh` / `install.ps1` / `install.cmd` run `gh attestation verify` on every install. Off by default. Can also be set persistently via `~/.plannotator/config.json` (`{ "verifyAttestation": true }`) or per-invocation via `--verify-attestation`. Requires the `gh` CLI, but not a login: the attestation bundle is fetched from GitHub's public attestations API (single unauthenticated attempt, never retried; the endpoint allows 60 requests/hour per IP) and verified with `--bundle`; the extraction needs one JSON tool on PATH (node, python3, or jq). gh's authenticated fetch is the fallback whenever the bundle path is unavailable or does not complete (missing extractor, fetch failure, or a gh that cannot verify the fetched bundle, e.g. an older gh without `--bundle`). Verification still needs network on every run because the Sigstore TUF trust root is fetched per-run; that failure is reported as connectivity, distinct from a real provenance failure, and both fail closed. |
| `PLANNOTATOR_SKIP_CODEX_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip writing the Codex integration (`hooks.json` / `config.toml` under `CODEX_HOME`, and the Codex-home stale-skill cleanup) even when Codex is detected. The installer reports the honest state ("Codex: detected, skipped (...)" vs installed; an agent that was not detected gets no closing-summary section at all, so the summary lists only the agents the machine has) and never removes an integration a previous install wired. Also settable via `~/.plannotator/config.json` (`{ "skipInstall": { "codex": true } }`); precedence is `--skip-codex` flag > env var > config. Off by default. |
| `PLANNOTATOR_SKIP_GEMINI_INSTALL` | **Read by the install scripts only.** Same opt-out shape for the Gemini CLI integration (`~/.gemini` policy file, settings hook, slash commands). Config key: `skipInstall.gemini`; flag: `--skip-gemini`. Off by default. |
| `PLANNOTATOR_SKIP_KIRO_INSTALL` | **Read by the install scripts only.** Same opt-out shape for the Kiro CLI integration (`~/.kiro` skills and agent, including the `~/.kiro` stale-skill sweep). Config key: `skipInstall.kiro`; flag: `--skip-kiro`. Off by default. |
| `PLANNOTATOR_SKIP_VIBE_INSTALL` | **Read by the install scripts only.** Same opt-out shape for the Mistral Vibe integration (`$VIBE_HOME` skills and the managed plan-review hook block in `$VIBE_HOME/hooks.toml`, plus the `~/.vibe` stale-skill sweep). Hooks are stable in Vibe 2.25+ (no config flag), so the installer writes only the `hooks.toml` block; its `command` is argv-only (absolute binary path, no env prefix) because Vibe's hook executor may be shell-free, and plannotator detects the Vibe origin from the hook payload (`pre_tool` + `exit_plan_mode`), with `PLANNOTATOR_ORIGIN=mistral-vibe` as the manual override. The hook is macOS/Linux-only, so the Windows installer never writes `hooks.toml` — it prints manual setup instructions, mirroring Codex-on-Windows. The Windows installers also skip the Vibe-specific skills (their `PLANNOTATOR_ORIGIN=mistral-vibe plannotator …` env-prefix only runs when Vibe's Windows shell tool resolves Git Bash, not on its PowerShell fallback), so they write nothing under `$VIBE_HOME`. Vibe still reads the shell-neutral core skills from `~/.agents/skills`, so `/plannotator-review` and `/plannotator-annotate` work there without a Vibe origin label; `/plannotator-last` is **not** supported for Vibe on Windows yet (with no `PLANNOTATOR_ORIGIN` it takes the Claude Code transcript path, so it fails or could read a Claude session in the same project). On Windows, Vibe counts as detected only when `$VIBE_HOME` exists, as in `install.sh`. Config key: `skipInstall.vibe`; flag: `--skip-vibe`. Off by default. |
| `PLANNOTATOR_SKIP_OPENCODE_INSTALL` | **Read by the install scripts only.** Do-not-write switch for the OpenCode integration (command stubs under `~/.config/opencode/commands`, the OpenCode plugin cache clear, and the stale command-stub sweep). OpenCode has no detection leg, so there is no detected/not-detected reporting, just a skip note. Config key: `skipInstall.opencode`; flag: `--skip-opencode`. Off by default. |
| `PLANNOTATOR_SKIP_SKILLS_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip the skills/slash-command sparse checkout entirely — no `git clone` of the release tag, so nothing is written to any skill or command scope (`~/.claude/skills`, `~/.agents/skills`, the OpenCode command stubs, the Gemini `.toml` commands, `~/.kiro`), the extras are not offered, and the skill-scope cleanup sweeps stay suspended (skip means do-not-write, never remove). The binary, sem sidecar, agent-terminal runtime, hooks, and per-agent config still install, and git stops being a hard requirement. The installer reports `Skills: skipped (...)` and the closing banner stops claiming the `/plannotator-*` commands are ready. Unlike the per-agent opt-outs this is not one agent's home — it covers every scope the checkout writes. Config key: `skipInstall.skills`; flags: `--skip-skills` (bash/cmd), `-SkipSkills` (PowerShell); precedence is flag > env var > config. Used by the `install-script-smoke` CI job, which installs a synthetic `v9.9.9` whose tag has no GitHub counterpart. Off by default. |
| `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL` | Set to `1` / `true` to skip installing the managed Node/WebTUI runtime used by compiled Bun builds for the annotate-mode agent terminal. Read by `plannotator install-runtime agent-terminal`, which the installers call automatically. |
| `PLANNOTATOR_MINIMAL` | **Read by the install scripts only**, not by the runtime binary. Set to `1` / `true` / `yes` to have `scripts/install.sh` / `install.ps1` / `install.cmd` install **only** the `plannotator` binary, skipping the sem sidecar, the agent-terminal runtime, all per-agent skills, hooks, slash commands, and config, and the CallDiff runtime even when its opt-in is set. Equivalent to the `--minimal` (aliased to `--binary-only`) flag; `--no-minimal` overrides it. Off by default. |
| `PLANNOTATOR_SKIP_SEM_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip installing the optional `sem` semantic-diff sidecar (used by code review). Off by default. |
| `PLANNOTATOR_INSTALL_CALLDIFF` | **Read by the install scripts only.** Set to `1` / `true` / `yes` to ALSO install the optional pinned, pruned CallDiff core used by code review's Call Flow analysis (about 5 MB on macOS arm64, Node.js 22+). The runtime is strictly opt-in and is NOT installed by default. The normal path is in-app: enabling Call flow consents to one background install of core plus exactly the language packs required by the current changed files; later missing languages install automatically under the same consent, while the Languages list supports install-ahead. Each target gets one automatic attempt per review session; a failed target then requires an explicit Retry in that session. Equivalent to `--with-call-flow` (PowerShell: `-WithCallFlow`) or `{ "installCallFlow": true }` in `~/.plannotator/config.json`; precedence is flag > env var > config. `--minimal` always excludes it. Off by default. |
| `PLANNOTATOR_CALLDIFF_PATH` | Development override for a built CallDiff `0.4.1` package root containing `dist/run.js`; the exact pinned Tree-sitter core and any desired optional grammars must already exist under its `node_modules`. Managed language-pack installation is disabled for overrides. Normal installs use the selective managed core and grammar cache under the Plannotator data directory. |

**Config-only settings (`~/.plannotator/config.json`)**: Some settings have no env-var equivalent and are toggled by editing the config file directly:

- `markdownExtensions` (array of strings, default none) — extra file extensions the **annotate** path treats as markdown, e.g. `{ "markdownExtensions": [".livemd"] }` for Livebook notebooks (#1307). A listed extension is accepted everywhere `.md` is on that path: CLI target resolution (`plannotator annotate notes.livemd`), folder discovery and the file browser, `/api/doc` plus relative and wiki-link navigation between sibling docs, the 2MB `MAX_ANNOTATABLE_FILE_BYTES` cap, and per-file version history. Listed extensions render as **markdown** (frontmatter stripped), never as raw HTML, and they only widen the set: nothing built in is removed. Entries must start with a dot and be free of path separators, globs, and whitespace (`".livemd"`, not `"livemd"` or `"*.livemd"`); invalid entries are dropped silently, built-in extensions are deduplicated, and the dotenv family can never be registered: `.env` itself plus any entry ending in `.env` or starting with `.env.` (such as `.prod.env` or `.env.local`) is denied, because annotate copies file contents into the data dir (the same reason `.env` is excluded from the built-in set). The value is read from `config.json` once per process. Predicates stay pure in `packages/core/annotatable.ts`, which is browser-safe and cannot read config; the node-side resolver that threads the normalized list into them is `packages/shared/markdown-extensions.ts` (vendored to Pi), and the annotate `/api/plan` payload ships the same list to the renderer so it can linkify links to sibling documents. Not applied to plan write (`ALLOWED_PLAN_EXTENSIONS` in `apps/pi-extension/tool-scope.ts`) or to Edit Mode source save (`SOURCE_SAVE_FILE_REGEX` in `packages/core/source-save.ts`), which keep their own narrower allowlists.
- `agentTerminalSide` (`"left"` / `"right"` / `"hidden"`, default `"left"`): which edge the **annotate-mode** Agent TUI docks against, or `"hidden"` to keep it out of the layout entirely (#1050). Type and guard live in `packages/core/agent-terminal.ts:63-83`, the config declaration in `packages/shared/config.ts:116`. Unrecognized values are silently ignored rather than warned about: `getServerConfig()` omits the key behind `isAgentTerminalSide` (`packages/shared/config.ts:374`) and `resolveAnnotateAgentTerminalSide` independently falls back to `"left"` (`packages/core/agent-terminal.ts:90-94`). `"hidden"` is a default, not a lock: the terminal can still be opened for the session from the sidebar rail, the Shift-Shift shortcut, or a message routed to the agent, none of which rewrite the preference, and an opened `"hidden"` terminal docks left (`packages/core/agent-terminal.ts:101-105`). Settings is the only way back from `"hidden"`. Two UI surfaces write the key (the terminal's own Display popover Position control and Settings → General → "Agent TUI Position"), and the Display popover's reset button restores `"left"`. The side only decides where the terminal docks when opened; it never auto-opens (`packages/editor/App.tsx:523`), it is not rendered below 1024px or in wide mode (`packages/editor/agentTerminalLayout.ts:14`, `:73`), and `"right"` visually displaces the annotations/AI right panel while preserving its state (`packages/editor/agentTerminalLayout.ts:53-57`).
- `agentTerminalDefaultAgent` (string agent id, e.g. `"claude"` or `"codex"`, default `""` meaning no recorded choice): which agent the annotate-mode Agent TUI preselects when the panel opens (#1050). Validation is `typeof === "string"` only, with no enum and no check against installed agents, so an unknown or currently unavailable id is inert rather than an error: `resolveAnnotateAgentId` uses the saved id only when it appears among the available agents and otherwise takes the first available one (`packages/ui/utils/annotateAgentTerminal.ts:45-54`). It is written only by the "save as default" checkbox in the terminal's agent picker (`packages/editor/components/AnnotateAgentTerminalPanel.tsx:257`); there is no Settings control for it. An empty string deletes the cookie and reads as unset, though the server allowlist will still write `""` into `config.json`, where it is then ignored.
- Precedence for both agent-terminal keys follows the settings registry (`packages/ui/config/settings.ts`) and its resolver (`packages/ui/config/configStore.ts:3-5`): **server config file > cookie > built-in default**. `config.json` is the durable, cross-browser store; the cookie (`plannotator-annotate-agent-terminal-side`, `plannotator-annotate-agent-terminal-default`) is the browser-local fallback. There is no one-time cookie-to-config migration: those two cookie names were deliberately kept unchanged so a pre-registry cookie stays readable, and its value only reaches `config.json` if the user changes the setting again. The sync runs one direction at startup, with `init()` stamping a valid config value back into the cookie (`packages/ui/config/configStore.ts:157-161`). Neither key has an env-var equivalent, and only the annotate servers allowlist them on `POST /api/config` (`packages/server/annotate.ts:726-727`, mirrored in `apps/pi-extension/server/serverAnnotate.ts:690-691`), so setting them has no effect on plan or review sessions.
- `pfmReminder` (`true` / `false`, default `false`) — when enabled, a Plannotator Flavored Markdown reminder is injected at plan-time describing the renderer's extensions (code-file links, callouts, tables, diagrams, task lists, question blocks, hex swatches, wiki-links). The text is one static constant (`PFM_REMINDER`, `packages/shared/pfm-reminder.ts`, vendored to Pi) with no per-request part, so it never breaks a prompt-cache prefix. Lets the planning agent enrich plans with PFM features without having to discover them. Composes cleanly with the compound-skill improvement hook. Supported across all three runtimes: Claude Code (`improve-context` PreToolUse hook in `apps/hook/server/index.ts`), OpenCode (`experimental.chat.system.transform` in `apps/opencode-plugin/index.ts`), and Pi (`before_agent_start` in `apps/pi-extension/index.ts`).
- `inboxNotifications` (`{ enabled?, dismissed?, allowedOrigin? }`, default: on, not dismissed, no origin) — the Plannotator Inbox's browser notifications (see "Notifications" under "Plannotator Inbox"). Written by the Inbox page (its one-time ask and Settings) through `POST /api/inbox/settings` `{ notifications: { enabled?, dismissed?, allowed_origin? } }`, never localStorage, because the browser's permission is per origin and the Inbox's port can change; `allowedOrigin` is the page origin where the person last turned them on, so a page on a new port asks again. No env-var equivalent. `inboxTool` (the Inbox tool switch) is in the `PLANNOTATOR_INBOX_TOOL` row.

**Legacy:** `SSH_TTY` and `SSH_CONNECTION` are still detected when `PLANNOTATOR_REMOTE` is unset. Set `PLANNOTATOR_REMOTE=1` / `true` to force remote mode or `0` / `false` to force local mode.

**Devcontainer/SSH usage:**
```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999
```

**Compressed app page for network sessions (#1617):** remote-mode and `--tailscale` sessions serve the single-file app HTML compressed, negotiated on `Accept-Encoding` (brotli q5, else gzip 6), with `Vary: Accept-Encoding`. Browsers advertise `br` only to HTTPS and localhost origins, so direct plain-http remote mode is served gzip and `--tailscale` (HTTPS) brotli; each server prewarms that likely encoding at start and compresses the other lazily, cached per process (bounded to 4 bodies, which persist for the life of long-lived Pi/OpenCode hosts). Plain local sessions serve the page exactly as before, because on loopback compression only added latency. One shared helper, `packages/shared/app-html.ts` (vendored to Pi), serves every app-HTML route in both runtimes; API responses are never compressed. The single-file builds also drop KaTeX's `woff`/`ttf` fallbacks (`build/katex-woff2-only.ts`); every supported browser loads `woff2`.

**Tailnet sessions (`--tailscale`):** `plannotator review --tailscale` (also `annotate` and `annotate-last`/`last`; other subcommands reject the flag with a clear error; Bun CLI only, not mirrored to Pi) publishes the session over the user's tailnet instead of remote mode: the server stays **loopback-bound** and the CLI orchestrates `tailscale serve --bg --https=<port> http://127.0.0.1:<port>`, so devices on the tailnet reach the session over HTTPS while nothing listens beyond localhost and nothing is ever public (serve, never funnel). The advertised HTTPS URL prints on stderr with a terminal QR code (TTY only), and a publishing failure exits `1` — or `2` under a strict annotate gate (`--require-approval` / `--result-file`), where `1` is reserved for "the reviewer did not approve" and a publish failure is a startup failure like any other — with an actionable message instead of leaving the loopback server hanging (CLI missing, daemon down or logged out, unparsable `serve status` output — which fails closed, or no serve URL matching the session port). A pre-existing serve mapping on the chosen port — background or foreground session, which Tailscale prefers — aborts rather than being stolen, and mappings on other ports are never touched. Mappings the process creates are cleaned up on normal exit and on SIGINT/SIGTERM/SIGHUP (all routed through `process.exit` so exit handlers run; the SIGHUP route is installed by `enableTailscaleServe` only once a mapping exists — an unconditional SIGHUP listener would override the ignored disposition `nohup` depends on, so plain non-tailscale sessions keep no SIGHUP listener and `nohup plannotator review &` survives terminal close); a failed teardown retries once and then warns with the exact manual command, and a hard kill (SIGKILL) or reboot can leave the mapping — `tailscale serve --bg` state persists — so remove it with `tailscale serve --https=<port> off`. Combined with `PLANNOTATOR_REMOTE`/SSH detection, `--tailscale` wins and forces local mode with a stderr notice — the wide `0.0.0.0` bind would only broaden exposure (`urlHost` is also suppressed for the run; the advertised URL comes from serve). `tailscale serve` forwards the browser's own Host header (the MagicDNS name), so the CLI adds the serve hostname to the server's Host allowlist once serve reports it (see "Host allowlist" under Server API). The annotate agent terminal is **off by default** in `--tailscale` sessions, exactly like remote mode, because the session is reachable across the tailnet and the PTY token is not an auth boundary; enable it with `PLANNOTATOR_AGENT_TERMINAL_REMOTE=1`. Orchestration lives in `packages/server/tailscale-serve.ts` on shared parsers in `packages/shared/tailscale.ts`.

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

### Pi plan review does not block

On Pi, `plannotator_submit_plan` returns as soon as the review server is up
("submitted for review … end your turn and wait", `terminate: true`) instead of
holding the tool call until the reviewer decides, so the session stays usable
during review and "Ask this session" works there. The decision is delivered
later by `deliverPlanDecision` (`apps/pi-extension/index.ts`) as a
`pi.sendUserMessage(..., { deliverAs: "followUp" })`, the same delivery review
and annotate feedback use: approval switches to the executing phase first
(tools, model, `plannotator-execute` entry) and sends the approved /
approved-with-notes prompt, which starts the execution turn and its framing;
deny and answers-only send `composePlanDeniedMessage`; external execution mode
hands off and records a non-triggering `plannotator-handoff` message. Nothing
is implemented before approval because the phase stays `planning` while the
review is open, so the planning write gate still holds. The open review is
closed (and its decision dropped) when plan mode is left, when a `/tree` path is
not planning, and on `session_shutdown`; a plan decision is never re-targeted to
a replacement session. The Esc-aborts-the-review behavior of the old blocking
tool is gone: leaving plan mode is how to abandon a review.

**Revisions while a review is open update the same tab**: a resubmission while a review is pending calls the Pi plan
server's `updatePlan`, which saves a new history version (slug from the revised
heading, `previousPlan` from that slug's prior version) and bumps a revision
counter. `/api/plan` carries `planRevision`; the plan editor polls
`/api/plan/revision` every 2s only when that field is present
(`packages/editor/hooks/usePlanRevisions.ts`) and loads the revision in place
through `applyEditedDocument` (annotations re-anchor by text, the diff base
re-seeds through `usePlanDiff`'s docKey). It waits while Edit Mode is open or
holds direct edits, or a linked document is open. Approve/deny bodies echo
`planRevision`, and the server answers `409 { code: "plan_revised" }` to a stale
one, so a reviewer cannot approve text the agent replaced; the tab then loads
the revision and the reviewer decides again. Both plan servers implement it (`updatePlan` on the
server result, `/api/plan/revision`, the 409) but advertise `planRevision` only
when the caller passes `planRevisions: true`; today only Pi's
`plannotator_submit_plan` and the Claude Code mod's `claude-mod-plan` do, so
classic Claude Code, OpenCode and the Pi event-API `plan-review` action keep a
tab that never polls and sends unchanged bodies.
A decision claims the review right after the revision check (before the note
integrations are awaited), so `updatePlan` refuses from then on; a Pi
resubmission that hits that refusal tells the agent to wait for the decision
instead of opening a second review. The tab also holds a revision while a
comment composer or annotation popover is open.

**Execution works from the approved text, not the file.** The Pi plan
server's approve decision carries `plan`, the exact text on screen when the
reviewer approved. `deliverPlanDecision` appends it to the approval message
under "## Approved plan", records it on the `plannotator-execute` entry
(`approvedPlan`), and executes from it: the checklist, the per-turn framing
and resume (`resyncPhaseFromSession`) read the snapshot instead of re-reading
the plan file, and checkmarks are written back to the file only while its
checklist still matches the approved one. If the file differs from the
approved text at approval, the message says so and tells the agent not to
execute the unreviewed edits (to keep them, the user returns to plan mode and
the agent resubmits). Auto-approved plans (no UI) keep the file as their
source.

### Pi: the `plannotator` tool

The extension registers the shared tool contract
(`packages/shared/plannotator-tool.ts`, vendored as
`generated/plannotator-tool.ts`) with `pi.registerTool`: name, description,
validation (`parsePlannotatorToolInput`), argument mapping and result text all
come from it, and `parameters` is `PLANNOTATOR_TOOL_INPUT_SCHEMA` itself
(plain JSON Schema, which Pi validates without a TypeBox Kind since 0.79.1,
the peer floor; `plannotator-tool.test.ts` runs the installed Pi's
`validateToolArguments` against it). `executionMode: "sequential"` (#1622: an
"edit, then open" batch opens the edited file).

**Registration and activation are decided once per session.** The tool is
OFF by default on Pi and registered only when the agent tool switch turns it on
(`PLANNOTATOR_AGENT_TOOL=1` / `{ "agentTool": true }`, `resolveAgentTool(...,
"pi")` read once when the extension instance loads; Pi builds a new instance
per session and per `/reload`). Off, nothing is registered and the slash
commands are unchanged. It is registered with
`defaultActive: false` (Pi 0.99+ then leaves it inactive; older Pi ignores the
key and activates every registered tool), and the first `session_start`
(`settleAgentToolActivation`) makes it active when `ctx.hasUI`, inactive in
print/JSON mode, before the session's first request, and never touches it
again. Plan mode's `setActiveTools` calls add and release only the tools they
own, so `plannotator` stays in the tool list (and the prompt prefix) through
planning, execution, completion, leaving plan mode, `/tree` and `/reload`:
`agent-tool-stability.test.ts` drives that whole lifecycle over a fake Pi that
models both activation rules and fails on any request without the tool or any
`setActiveTools` that flips it after the start; it also pins the registered
description/parameters to the shared constants, no `promptSnippet` /
`promptGuidelines` on any Plannotator tool, and no `systemPrompt` from
`before_agent_start`.

**The bundled knowledge skill is user-invoked only.** `vendor.sh` adds
`disable-model-invocation: true` to the vendored copy's frontmatter (the
source `apps/skills/core/plannotator` stays model-invocable for the installers
that ask, #1377), so an npm-only Pi install keeps the #842 promise of no
Plannotator skill in Pi's system prompt; `/skill:plannotator` still loads it,
and the model learns the tool from the tool's own description. A CLI install's
`~/.agents/skills` copy still wins when present (#1642) and carries the
installer's model-invocation choice.

**One launch path.** `/plannotator-review`, `/plannotator-annotate`,
`/plannotator-last` and the tool share `launchCodeReview` / `launchAnnotate` /
`launchLastMessage` in `apps/pi-extension/index.ts` (in-process server,
"Ask this session" bridge, decision as a `followUp` message). The commands
notify a launch error; the tool throws it, which Pi reports as an error
result. Tool differences: the annotate target is ONE argument, so the #1182
tolerant word split never runs on it (`tolerant: false`); an opened review
returns `plannotatorToolOpenedText` with `terminate: true`, so the turn ends
and the session is idle for Ask; a gated session the tool opened delivers a
bare Approve as a message (`deliverApproval`, the mod's rule). The tool's
`last` skips the assistant entry holding the calling tool call
(`isAssistantEntryForToolCall` in `assistant-message.ts`): Pi saves an
assistant message at message_end, before its tools run, so otherwise the
agent's own "opening it now" message would open, and would head the picker.
On one fixed port (remote mode or a single `PLANNOTATOR_PORT`, read from
`getServerPorts`) a second open is refused while any review is open
(`fixedPortBusyText` names it), because the new server would otherwise
self-preempt the open one silently. A list target opens ONE `annotate-bundle`
review through the same `launchAnnotate` the slash command uses: the list goes
to the shared `selectAnnotateTokenTarget` as pre-split tokens (paths with
spaces survive), only the `bundle` selection opens (a missing entry answers
`buildMissingAnnotateFilesMessage`; a folder, URL or bare name refuses, so the
tool never opens fewer files than named), `resolveAnnotateBundleFiles` checks
types and size, and the subject is `plannotatorBundleSubject` (`2 files:
spec.md, notes.md`) in the result, list, close and decision heading; feedback
names every file (`Files:` + `annotateBundleTargetText`). A session without
UI (print/JSON mode) never has the tool active (see above), and a call that
reaches it anyway is refused, since nothing could deliver the decision later.

**Sessions, list and close.** Every review the extension opens (tool,
commands, `plannotator_submit_plan`) is recorded in ONE process-wide registry
(`getProcessPiReviewRegistry` in `apps/pi-extension/plannotator-tool-host.ts`,
on `globalThis`) with a `pn-` id until its decision settles. Process-wide
because Pi builds a new extension instance on `/reload` and `/resume`, and a
per-instance map would forget the open reviews of a session that merely
reloaded. `list` and `close` see only entries whose owner is the calling ctx's
`sessionManager.getSessionId()`, so another session's reviews (including the
previous one after `/new`) are never in reach; the global `sessions/` registry
is never read. `unsent` and `decided` come from the server's
in-process `hostControl.status()`; `close` calls `hostControl.close()` (the
reviewer's Close marked `closedBy: "agent"`, draft kept, tab told), so it
works in remote mode too, where the HTTP endpoints are off. A review the agent
closed delivers nothing: its decision handler notifies "the agent closed …"
instead (user-facing notices name a last-message review "the agent's last
message"; agent-facing texts say "your last message"). Plan reviews are listed
as `Plan vN` (the history version, read from `updatePlan`'s no-op answer for
the same text, and from each revision) and never closed.
Review, annotate and last decisions (commands included) now start with
`plannotatorDecisionHeading` (`Plannotator: notes.md (pn-3f2a9c) — Feedback ·
2 comments.`); outcomes follow the mod: a code review that is not an approval
is `Changes requested` (` · N comments` when it carries annotations), and the
PR-platform status post, which the review server marks `platform: true`
(#1719, `classifyReviewOutcome` in `apps/pi-extension/review-outcome.ts`), is
`Review posted` (`PLANNOTATOR_OUTCOME_REVIEW_POSTED`, shared with OpenCode 2) and delivered verbatim, without the verification
suffix. Every review decision whose feedback has content is delivered,
zero annotations included (PR description, PR comment and editor notes ride
only in the feedback text); nothing is inferred from the annotation count.
Plan decisions are unchanged. Pi cannot take over an agent's
shell `plannotator` command: its `tool_call` event can only block a call, which
the model reads as an error, so the skill's "use the tool" line is what steers
it.

### Claude Code mod: non-blocking plan review, annotate, review and last

Where Claude Code runs hooks modules ("Claude Mods": function hooks, CLI only,
2.1.287+), the plugin's `hooks/hooks.json` also loads `apps/hook/hooks/mod/register.ts`
(`"modules": ["./mod/register.ts"]`). No Plannotator session then holds a tool
call open: the mod starts the CLI detached, returns at once, and delivers the
reviewer's decision later as a plugin turn (`$.prompt.submit`, read by Claude
as a message from the `plannotator` plugin). UX spec:
`.product/drafts/claude-code-mod/UX-SPEC.md` (owner-reviewed draft; its open
questions are not answered yet, and the conservative choices below are the
ones taken).

**On by default; opt out with `PLANNOTATOR_CLAUDE_MOD=0` or `{ "claudeCodeMod": false }`.**
The owner's call: every Claude Code that runs hooks modules (current Claude Code
loads them even with `CLAUDE_CODE_ENABLE_FUNCTION_HOOKS` unset) gets the
non-blocking flows, the `plannotator` tool and the Bash take-over of
agent-run `plannotator` commands (below). With the knob off `session.start` stops before doing
anything (no `$.command.register` or `$.tool.register`, no `$.env.set`, no
`$.store`, no process) and every other hook passes straight through with
`next(e)`, so the classic PermissionRequest hook and the `/plannotator-*`
skills run as they do without mods. See the env table row.

**Inert without mods.** Checked live: Claude Code 2.1.150 (no hooks modules)
validates and loads the plugin with the `modules` key, ignores it, and runs the
classic PermissionRequest command hook (the blocking review) exactly as before;
2.1.288 with modules on runs the mod and never reaches that command hook. The mod
also stands down by itself (every hook passes through) in `-p` / SDK sessions
(`isInteractive` false: a later plugin turn would have no session to land in)
and where `/bin/sh` is missing (Windows), leaving the classic hook and the
`/plannotator-*` skills in charge. A mods-capable Claude Code whose rollout
switch is off could not be reproduced locally; the engine only inserts modules
into the hook chain when they load, so it should behave like 2.1.150.

**Files.** `register.ts` holds every `$` call (`claude plugin validate` follows
`$` only through top-level functions and inline hooks) and builds a `Host` of
closures; `controller.ts` (`PlannotatorMod`) is the per-session state machine;
`launch.ts` (detached launcher, launch-directory layout, command table, copy),
`delivery.ts` (turn vs log, 12 KB inline limit), `plan.ts` (ExitPlanMode
decisions and deny copy), `turns.ts` and `bridge.ts` (Ask this session),
`shell-words.ts` (argument splitting), `tool.ts` (the `plannotator` tool contract, a copy of `packages/shared/plannotator-tool.ts`), `take-over.ts` (agent-run Bash `plannotator` commands answered through the tool), `inbox.ts` and `inbox-contract.ts` (the Plannotator Inbox connection, below; the contract a copy of `packages/shared/inbox/connection.ts`). The mod is self-contained: a plugin
installed from the marketplace is only `apps/hook/`, and a hooks module may
import only its own files.

**Detached launch.** `$.process.run` is one-shot (10 minutes at most) and a hook
has a 10 s budget of its own time, so the mod runs a tiny `/bin/sh` wrapper
(`LAUNCH_SCRIPT`) that starts `plannotator <subcommand> <args>` in the
background with stdin/stdout/stderr on files and returns in milliseconds. The
launch directory is `${PLANNOTATOR_DATA_DIR or ~/.plannotator}/claude-code-mod/<session id>/<launch id>/`:
`stdin`, `ready` (`PLANNOTATOR_READY_FILE`), `result.json`
(`PLANNOTATOR_HOST_RESULT_FILE`), `stdout`, `stderr`, `pid`, `exit` (written
after the CLI exits), `revision.json` + `.ack` (plan revisions),
`messages.json` (`PLANNOTATOR_HOST_MESSAGES_FILE`, `last`'s picker list),
`watcher.json` and `settled/by` (see "Two processes on one session" below) and
`feedback.md` (oversized feedback). Waiting inside a hook (for the ready file, a
revision ack) happens in a `$.process.run` shell loop (`waitForAny`), never a
`$.clock` wait, which would spend the hook's budget and let the engine run the
call on without the mod. Once a review is open, a 1 s `$.clock.every` timer
(the mod has no listener) reads `result.json`, notices an `exit` with no result
("the review server stopped … your draft is saved"), and every 15 s checks the
pid with `kill -0`. Open launches and a pending plan approval persist in
`$.store` and reattach on `session.start` for the same session id
(`--resume`, `--continue`, a restart; on 2.1.290 `--continue` keeps the session
id). The fork paths do NOT reattach: `--fork-session` and `/clear` start a new
session id, so the reviews stay with the old id and come back only when that
session is resumed (re-adopting them across a fork is a follow-up).
`session.start` does not fire for
`/clear` or an in-process resume (the process goes on under another session
id), so `session.end` disposes the instance (timer and bridges stop; nothing is
delivered into the next session) and the next hook that needs the mod makes a
new one for the current id, restoring that session's open reviews. The launch
directory is created owner-only (`umask 077`, `chmod 700`) before `stdin` is
written; once a decision is delivered its files are removed (`cleanupArgv`),
except `feedback.md`, which Claude reads afterwards. A launch whose server
crashed keeps its directory (its `stderr` explains why). Servers outlive Claude Code on purpose:
the wrapper ignores SIGHUP and starts the CLI under `nohup` (a closing terminal
otherwise took the server with it), so closing the terminal does not lose a
review; verified live, `claude --continue` reattached and delivered it.

*Two processes on one session.* `claude --continue` while the first process
still runs gives two Claude Code processes the same session id, and both
reattach the same launches. One of them watches each launch: `watcher.json` in
the launch directory is a lease (`{ owner, at, touchedAt }`, the owner a random
id per mod instance) renewed every 5 s. The process the person works in wins
it: restoring a launch, a prompt typed in that process (origin `composer`), a
slash command, Claude's `plannotator` tool and ExitPlanMode all touch that
process's launches and take the lease at once; a live holder keeps it against
an older or equal touch, and anyone takes it once it is 20 s old
(`LEASE_STALE_MS`: the holder exited, slept or hung). A disposed instance
(`session.end`) releases it at once. Only the watcher runs the bridge (so the
two never supersede each other) and delivers, re-reading the lease right
before it settles, so a decision follows the person within a tick. Plan
approvals live in `$.store` and every ExitPlanMode re-reads them, so an
approval received (or already used) by the other process is honored once;
ExitPlanMode and the tool also adopt this session's launches the other process
started, so a revision goes into the open review instead of opening a new one.
Delivery is claimed once per launch, whichever file settles it (`result.json`,
`exit` with an older CLI's stdout, or a dead `pid`): `claimArgv` makes the
launch's `settled/` directory (mkdir has exactly one winner) and writes the
claimant's id to `settled/by`, so a claimant whose process call timed out wins
again on the next tick, while every other process loses. A process that loses,
or finds a `settled/` claim naming someone else or the launch's `stdin` gone
(cleaned up after the other delivered), forgets the launch quietly, so its
status line no longer says "waiting for you". A per-launch in-flight flag keeps
the 1 s timer, which never waits for a slow check, from checking one launch
twice at once. Residual window: `$.prompt.submit` resolves only once Claude
is idle, so a claimed decision can wait for the whole of Claude's current turn,
and a process that quits or dies in that time takes the delivery with it
(nobody else delivers a claimed launch: the claimant may still be waiting to
deliver it, so a second delivery could never be ruled out). It is not lost
silently: the claimant keeps the launch's record in the store and renews its
lease while it waits, writes `settled/delivered` once `$.prompt.submit`
returns, and releases the lease at `session.end`. A restore of the session
(and any process that watched the launch and saw the claim) checks a claimed,
undelivered launch whose decision is still on disk: while its claimant's lease
is fresh it waits; once the lease is released or 60 s stale
(`UNDELIVERED_AFTER_MS`) it logs once, with a toast, "A decision for <subject>
arrived but wasn't delivered — it's saved in <dir>/result.json" (`stdout` for an
older CLI) and writes `settled/reported`, so it is said once.
`cleanupArgv` removes `stdin` first and keeps `settled/` while `feedback.md`
keeps the directory, so a claim made after cleanup started loses.
`persist` keeps this session's records it does not know (the other process
launched them) unless it settled them. After restore, off the session-start
path (5 s cap), the stored launch records older than a minute are pruned
(`pruneArgv`): any cleaned up (no `stdin`) or settled for good (`settled/`
marked delivered or reported, or with no decision on disk; a claimed,
undelivered decision stays for its session to report); for other
sessions, any whose server died without a decision (`kill -0` fails, no
`result.json`, no `exit`); and for other sessions older than 14 days
(`LAUNCH_EXPIRED_MS`, a session nobody resumed), any whose server is gone, decision
or not. A live server always keeps its record; this session's dead servers are
left to the timer, which reports them. The store is read again before the
write, so a record another process added meanwhile is kept.
The debug log (`PLANNOTATOR_MOD_DEBUG=1`) is appended (`debugAppendArgv`,
O_APPEND) with a per-process tag on every line, because rewriting the whole
file from each process's own buffer clobbered the other's lines and left NUL
bytes. Past 1 MiB it is rotated to `debug.log.1` under a lock
(`debug.log.rotating`, mkdir; one older than a minute is a dead writer's) with
the size checked again inside it, so two writers never rotate twice and move a
fresh log over the old one.

**Host result file (`PLANNOTATOR_HOST_RESULT_FILE`).** New CLI side channel
(`apps/hook/server/host-result.ts`), taken from the env at startup and scrubbed
like the bridge token: when a review, annotate, annotate-last or
`claude-mod-plan` session settles, the CLI writes ONE JSON record there
atomically (temp + rename): `{ v: 1, surface, decision, message, noop,
annotationCount?, platform?, withNotes?, approvedPlan?, permissionMode?,
documents?, target? }` (`documents`: a review of several files names each file with its
comment count, in review order).

**Decision targets.** Every decision a host delivers names its FULL target, as
the server that took the decision resolved it, never the words the agent typed
(a real report: a bare approval headed only `QUESTIONS.md` was acted on as an
earlier decision about a different `QUESTIONS.md`). The CLI writes `target`
(absolute file or folder path, URL, a bundle's files in order, the reviewed
directory, patch file or PR URL, the plan file; none for annotate-last) into
the host result record, the ready line (`ServerReadyMetadata.target`, set once
per process by `setServerReadyTarget`), the `--json` annotate record and the
`opencode-review` record (additive), and the `sessions/` registry
(`apps/hook/server/decision-target.ts`). Hosts put it on the line after the
heading (`plannotatorDecisionHeading(subject, id, outcome, target)` →
`Target: <path>` / `Targets:` + `- <path>` lines; `plannotatorTargetLines`), and
the tool's opened text carries the same line. The mod stores the target on its
`LaunchRecord` (from the ready line, else its own resolution of the words
against the session directory, for a CLI older than the field), names the
record's target when there is one, and logs a line when the two differ. Pi sets
it from its in-process resolution; the OpenCode bridge reads the ready line and
the JSON records, and uses the CLI's resolved path in its `File:` line too.
Same-named open reviews are told apart in headings, status and toasts by
`plannotatorDistinctSubjects` (shortest distinct path tail:
`releases-2026-10-04/QUESTIONS.md`). Plain CLI stdout ("The user approved.")
and the strict-gate record are unchanged. A code review's target is taken at DECISION time,
not at launch: both review servers put `target` on the decision (the active PR's URL after an
in-place `/api/pr-switch`, the workspace root, or the working tree the active diff reads), and the
CLI record, the `opencode-review` record and Pi use it (a static patch keeps the patch file the CLI
named); a decision about a different PR than the launch opened is headed with that PR
(`plannotatorDecisionSubject`). The mod's own fallback for an older CLI never guesses: only a URL or
PR URL, an absolute path, or a review with no words (the session directory) counts; a bare or
relative name, or review prose, gets no Target line rather than a confidently wrong one.
`message` is composed from the configured prompts exactly as other hosts do
(review: the CLI's own output; annotate: the file/message feedback and
approved-with-notes prompts OpenCode and Pi use; plan: `composePlanDeniedMessage`
/ the approved prompts), so the mod never re-implements prompts. Stdout is
unchanged for every caller. `noop` marks what never starts a turn: Done with
nothing to send, review LGTM, Close, a truly empty review submit (no feedback
text and no annotations), and a review posted straight to the PR platform
(`platform: true`, logged plus a `$.prompt.suggest` to address the comments).
**The platform post is marked explicitly, never inferred from zero
annotations:** the review editor puts only code comments in `annotations`, while
PR description comments, PR comment notes and VS Code editor comments ride only
in the feedback markdown, so a review made only of those has an empty
`annotations` and is ordinary feedback (delivered, `noop: false`,
`annotationCount: 0`, and given the request-changes suffix). The platform path's
status post sends `platform: true` in its `/api/feedback` body; both review
servers carry it onto the decision only when it is boolean `true`, and every
consumer decides on that flag: `reviewHostResult` (noop + `platform`),
`buildReviewOutput` (CLI stdout and `--json`, which Amp reads; the status line
gets no suffix), OpenCode's embedded `/plannotator-review`, the OpenCode CLI
bridge (`opencode-review` always emits `platform` as a boolean; a missing field
means an older CLI and falls back to the old `isPRMode` rule), Pi
(`classifyReviewOutcome`, `apps/pi-extension/review-outcome.ts`; the event API's
`code-review` result carries the same field). Client and server ship together
in each binary and package, so the flag is always present where it is needed.
The mod's `legacyResult` (an older CLI's stdout) never inferred the platform
post; there a status line arrives as a feedback turn, as before. The feedback
archive does not classify the platform post either: its decision comes from
`approved` and whether the body has content. Introduced in 0.28.0, where zero
annotations read as the platform post and the mod sent nothing (fixed 0.28.4;
the mod also guards records from those CLIs, see "Version skew").
An annotate Done with nothing to send still posts the legacy
zero-state sentence ("User reviewed the document and has no feedback.") as
`feedback`, because plain stdout, `--json` and the OpenCode/Pi consumers print
or deliver those bytes; the editor additionally marks that body
`nothingToSend: true`, which both annotate servers carry onto the decision only
alongside empty `annotations`/`codeAnnotations` (`isNothingToSendFeedbackBody`,
`packages/shared/annotate-decision.ts`), and `annotateHostResult` turns it into
a `noop` record. Every plugin host that turns a decision into an agent message
skips it the same way: Pi's
`classifyAnnotateOutcome` reads it as "Annotation closed (no feedback).", the
OpenCode embedded handlers (`commands.ts`) send no prompt (on OpenCode 1 the
command's own message still runs its one empty turn, the known OC1 limit; no
second turn is added), and the OpenCode CLI bridge (OpenCode 1 CLI runtime and
OpenCode 2 native commands) reads the additive `nothingToSend: true` the CLI
adds to its `--json` / `opencode-annotate-last` record in that case only, as do
the Amp plugin (`formatAnnotationFeedback`) and the Droid plugin
(`emitAnnotateDecision`), which also read `annotate --json`. Skill-run hosts
(the classic Claude Code skill, Codex, Gemini, Copilot, Vibe, Kiro) still hand
the model the plain-stdout sentence, which is the unchanged stdout contract. The
feedback archive still records a bare Done as `feedback` with the sentence.
Multi-message annotate-last merges SSE external (agent / WebMCP) comments into
the current message's entry (`mergeExternalsIntoMessageEntries`), so they reach
the exported feedback, the submit body and the nothing-to-send check. The mod's `legacyResult` recognizes the two zero-state
sentences printed by a CLI older than the result file (#1701). The submit
body's `annotations` carries every document's comments (folder sessions,
linked documents, every message in multi-message annotate-last;
`collectSubmittedAnnotations` in `packages/editor/feedbackDocuments.ts`), so
`annotationCount` matches the feedback text.

**Version skew.** The plugin installs from the repo's main branch and the
binary updates separately, so with the mod on by default it routinely runs
against an older CLI. Verified by running the real mod controller against the
released 0.27.25 and 0.27.10 binaries as processes:
- ExitPlanMode: an old CLI has no `claude-mod-plan` (0.27.11+ prints `Unknown
  command: claude-mod-plan`; older CLIs read the unknown subcommand as the
  classic hook and print `No plan content in hook event`), exit 1 within
  ~0.3 s. The mod recognizes either (`cliLacksModPlan` in `plan.ts`), lets the
  call through to Claude Code's own flow, where the plugin's classic
  PermissionRequest hook runs the familiar blocking review, logs ONE line
  telling the user to update the CLI, removes the launch directory, and sends
  every later ExitPlanMode straight to the classic flow without probing again.
  The flag lives on the mod instance, not in `$.store`, so a restart or
  `--resume` probes once more (and picks up a CLI updated in between). An old
  CLI that refuses only after the hook stopped waiting (15 s) is caught by the
  timer: same fallback, plus a plugin turn asking Claude to call ExitPlanMode
  again, since it was told a review was open. While the hook waits, the timer
  leaves the launch alone (`starting`), so only one of the two reports it. Any
  other startup failure also falls back, with the CLI's error logged. Plan
  review is therefore blocking, not broken.
- Review, annotate, last, the `plannotator` tool and taken-over Bash runs (the
  same launch as the tool): work. The old CLI writes
  the ready file (0.19.24+) and no result record; a decision that exits 0 is
  delivered from its stdout (`legacyResult` in `delivery.ts`), with the default
  review approval prompt read as an LGTM (logged, no turn) and the
  approved-with-notes prompt as "Approved with notes" (a user-customized
  approved prompt cannot be told apart and arrives as feedback). Close and an
  empty Done log only.
- Review platform flag (0.28.0 to 0.28.3 CLIs): those CLIs wrote `platform:
  true, noop: true` for ANY request-changes review with zero code annotations,
  so feedback made only of PR description, PR comment or editor comments would
  be logged and never delivered. The mod carries a narrow old-CLI guard
  (`misreadAsPlatformPost` in `delivery.ts`): a review record is treated as the
  real platform post only when its message is one of the editor's status lines
  (`isPlatformStatusLine`: `Pull request|Merge request approved|reviewed on …`
  or `Changes requested on …`, the shapes `statusMessage` in
  `packages/review-editor/App.tsx` builds); any other non-empty `platform`
  record is delivered as review feedback (without the request-changes suffix,
  which those CLIs never added to it). A fixed CLI sets `platform` only on the
  real status post, which always matches, so it never takes this path. If the
  editor's status-line wording changes, update the pattern and its test.
- `last`: the old CLI ignores `PLANNOTATOR_HOST_MESSAGES_FILE` and opens the
  newest message from stdin (no picker), though the command line still says
  "N messages, newest first".
- Ask this session: the old server answers `404` on `/api/ai/bridge/poll`, the
  mod's bridge stops, and Ask AI offers only its providers.
- A CLI before 0.19.24 writes no ready file: commands wait their full 45 s /
  15 s and say "Starting…", and decisions still arrive at exit.
- The tool's `list` and `close` (contract v2): a CLI without
  `/api/host/status` lists its reviews with `unsent: unknown`. `close` counts as
  closed ONLY a JSON answer with a numeric `unsentAnnotations`
  (`classifyHostCloseAnswer` in `controller.ts`): 0.24–0.28.3 answer a JSON
  `404` and 0.19.24–0.23.x (before the `/api/*` 404 guard, #748) their app page
  with `200 text/html`, and both read as "an older Plannotator", never as
  closed. A CURRENT CLI with host control turned off (remote mode) answers
  `404 { code: "host_control_disabled" }` instead, which the mod never TERMs:
  the close reports that the review runs in remote mode and should be closed
  from the tab. Only for an older CLI does the mod TERM the process
  (`STOP_SCRIPT`), and only if the launch's `result.json` / `exit` is still
  absent and the pid still names a `plannotator` process (`ps -o args=`);
  nothing answering on the port (a stale or reused pid after a reboot) is never
  signalled, and where `ps` cannot verify a pid (missing, as on Debian slim
  without procps, or without `-p`, as BusyBox's) the script signals nothing
  and the close says the review was left running. In every such case the close
  reports failure. After a TERM close, a decision record without `closedBy` (or an
  older CLI's exit 0) is the reviewer's and is delivered as usual. **Remaining
  window:** these CLIs publish a decision only after a 1.5 s post-decision
  sleep and nothing on their HTTP surface says a decision is pending, so a
  decision the reviewer makes in the ~1.5 s before the TERM is lost (and those
  CLIs had already deleted the draft on submit; the feedback archive record
  survives where it is on). A CLI with the endpoint has no such window: its
  close is refused with `409` once the reviewer decided.

**Commands.** `/plannotator-review`, `/plannotator-annotate` and
`/plannotator-last` keep their names (spec open question 7, conservative): when
the user's core skills hold the names (Claude Code refuses
`$.command.register` for a user skill's name), the mod's `command.run` hook
answers the skill's command itself, so the skill's blocking bang line never
runs; a name nobody holds is registered (`immediate: true`). Arguments are split
like the skill's shell line (`splitShellWords`: quotes and backslashes, no
expansion) and passed to the same CLI parsers (`review`, `annotate`; `last`
runs `annotate-last --stdin`, see the next paragraph). The command returns
"Opened <subject> in Plannotator · <url>" once the ready file appears (up to
45 s for review, 15 s otherwise), or the CLI's own startup error. Under the mod
the CLI's tolerant annotate handoff (several unresolvable words) is shown to
the user as that error, not handed to Claude.

**`last` and its message picker.** The classic path reads up to 25 recent
assistant messages from the transcript file and shows a picker (newest open by
default). The mod has no transcript file to hand over, so it builds the same
list from `$.session.messages()` (`recentAssistantTexts` in `launch.ts`: newest
first, at most 25, text-less rows skipped, consecutive assistant rows joined as
one response, the way the transcript path groups chunks by message id) and,
when there is more than one, writes `messages.json` `{ v: 1, messages:
[{ messageId, text }] }` and sets `PLANNOTATOR_HOST_MESSAGES_FILE` to it. stdin
still carries the newest text. `$.session.messages()` rows carry no id or
timestamp, so ids are derived from the text (`cc-` + 16 hex of its SHA-256, a
`-n` suffix for repeats), stable as newer messages arrive; there is no
timestamp. The CLI (`apps/hook/server/host-messages.ts`) honors the variable
only with `--stdin`, only for a `messages.json` under the data dir's
`claude-code-mod/`, takes it at startup and scrubs it from the env, and
validates fail-closed (v 1, 1..25 entries, string fields, unique ids, 2 MiB per
message, 8 MiB file); a malformed file is a startup error (exit 1). The mod
(`pickerFile`) budgets the SERIALIZED file, 256 KiB under that cap, because
JSON escaping inflates text (ESC becomes `\u001b`): older messages that do not
fit are left out, and when the newest alone does not fit no file is written
(stdin only). Why a
variable and not a flag: a CLI that predates it ignores the variable and opens
the stdin text exactly as before, while an unknown flag to `annotate-last` is
silently ignored (it would fall through to the transcript lookup) and a changed
`--stdin` payload would be shown as the message. Old mod + new CLI: no
variable, `--stdin` unchanged. With a picker the subject is "Claude's recent
messages" (status line, open text, the plugin turn's first line), since the
feedback may be about an older message; the feedback itself carries an excerpt
of each message it covers. What `$.session.messages()` returns is the engine's
live conversation: after `/rewind` that is the rewound conversation (inferred
from the API docs, not checked live), and after `/compact` only the
post-compaction messages, so the picker can be shorter there than on the
classic path, which falls back to the pre-compaction file.

**The `plannotator` tool (agent-initiated opens).** When the user tells Claude
"open this in plannotator", Claude used to run the CLI through Bash, which
blocks and gives Ask AI a separate AI. The mod registers a real tool instead:
`$.tool.register({ name: "plannotator", description, inputSchema })` at
`session.start`, right after the commands, and only when the mod is on (the
knob not turned off, an interactive session, `/bin/sh` present) and the agent tool
switch is on (on by default here; `PLANNOTATOR_AGENT_TOOL=0` / `{ "agentTool": false }` turn it off; `resolveAgentToolEnabled`
in `hooks/mod/enabled.ts`, read with the mod switch at the first `session.start`
of the process, never re-read); with either switch off, in `-p`/SDK runs and on
Windows nothing is registered and Claude keeps the CLI through the `plannotator`
skill. With only the agent tool off, the rest of the mod runs: the slash
commands, non-blocking ExitPlanMode, Ask this session, and the Bash take-over
below, which stays because it adds nothing to Claude's context (it changes only
what a `plannotator` command Claude already chose to run does). The engine names it `mcp__plannotator__plannotator`
(the register call returns the full name, which `register.ts` keeps) and serves
it through a loopback MCP server; the mod's `tool.call` hook answers every call
itself (`{ result }` / `{ deny }`), so no other hook or permission prompt runs
for it. Input: `{ action: "annotate" | "review" | "last", target?, gate?
(annotate only), options?: { base? (review --base), markdown? (annotate
--markdown) } }`, validated strictly (unknown keys, a target or base that would
read as a flag, control characters, a field the action does not take; a `false`
default is tolerated). The call becomes the words the slash command would carry
(`plannotatorToolArgs`, one argument per element, never re-split) and goes
through the SAME launch as the commands (`PlannotatorMod.open`: detached CLI,
result file, bridge token, session tag, cleanup), so Ask this session works and
the decision arrives later as a plugin turn. The tool result returns at once
("Opened <subject> in Plannotator: <url> … End your turn now and wait"); a bad
call or a CLI startup error is an error result. A gated tool session
(`gate: true`) is the one delivery difference: a bare Approve is submitted as a
turn (`deliverApproval` on the launch record), because Claude was told to wait
for the sign-off; the slash command's bare gated approval still only logs. Done
and Close send nothing, as for the commands. A subagent may call the tool (its
decision lands in the main session as a plugin turn), except `action: "last"`,
which is refused there because it reads the main session's transcript. The contract (name, schema,
description, validation, argument mapping, result text) lives once in
`packages/shared/plannotator-tool.ts` for every host; the mod keeps a byte-for-byte
copy of its CONTRACT section in `hooks/mod/tool.ts` and `tool.test.ts` fails
when they differ (edit the shared file, then paste). The core `plannotator`
skill carries one host-neutral line: use a `plannotator` tool when the agent has
one. Plan review stays on ExitPlanMode. Checked live on 2.1.288: the tool is DEFERRED behind tool
search (no `alwaysLoad` is possible through `$.tool.register`), so Claude sees
only its name until it searches; with the updated skill it searched and called
the tool for "open notes.md in plannotator", while a profile still holding the
older installed skill text loaded that skill and ran the CLI instead.

**Contract v2: session ids, `list` and `close` (agent sessions, 0.29).** Every
review the mod opens has a session id, `pn-` + the six hex digits that end its
launch id (`sessionIdOf` in `controller.ts`; unique among the session's open
launches). The tool result's first line is `Session: pn-3f2a9c`, and every
decision turn's first line names it (`plannotatorDecisionHeading`:
`Plannotator: notes.md (pn-3f2a9c) — Feedback · 3 comments.`); slash-command
output is unchanged. `action: "list"` reports the reviews opened in THIS Claude
session, by the tool or by the user's `/plannotator-*` commands (the launch
store is already per session id; the global `sessions/` registry is never
read): id, kind, subject, url, age, state and `unsent: N` from the server's
`GET /api/host/status` (`unknown` for an older CLI). `unsent` counts only the
reviewer's own draft comments (`countUnsentDraftComments`: entries without a
`source`, so review-agent, WebMCP and linter findings are not counted, plus
code review's PR description and PR comment notes).
`action: "close"` takes `session: "pn-…"` or `"all"` and calls
`POST /api/host/close` (see "Host session control" under Server API): the
reviewer's Close, marked `closedBy: "agent"`, with the draft KEPT and the open
tab told over the external-annotation SSE (`session-closed`, which the editor
and review app show as "Closed by the Agent" with the unsent count). The result
reports how many unsent comments stay saved as a draft. The copy promises no
restore beyond each surface's own draft key (`agentClosedSubtitle`: annotate
drafts come back for the same unchanged document, code review drafts for the
same changes; path-keyed annotate drafts are #1710). Nothing is delivered for
that review afterwards (the launch is marked `closedByAgent` and settles with
one log line), except a decision record WITHOUT `closedBy`, which is the
reviewer's and is delivered. Plan reviews are listed but never closed (`close
all` skips them, a plan id is refused). An id this session did not open is "not
found". Against an older CLI the mod falls back to `TERM` under the checks
described in "Version skew" above (`stopArgv`), which ends the server without a
decision and never deletes a draft. The contract also
accepts `target` as a list for annotate (validated, duplicates dropped, a
one-item list is the plain call): a review of several files (a bundle, see
"Several files in one review" under the Annotate Flow). `plannotatorToolArgs`
passes the paths as the CLI's arguments, one each, in order (a bare list entry
such as `README` is passed as `./README`, so a missing one fails the whole list
instead of being read as prose), and the session is
named `plannotatorBundleSubject` ("3 files: spec.md, mock.html, notes.md"), in
the opened text, the session list and the decision heading. The tool
description says "Pass a list as `target` to review several files together, in
the order you want them read." Version skew: a CLI that predates bundles answers
several paths with its ambiguity error WITHOUT the bundle hint line
(`isOlderCliBundleRefusal`, which compares against `PLANNOTATOR_BUNDLE_HINT_LINE`,
a copy of `ANNOTATE_BUNDLE_HINT` pinned equal by `annotate-target.test.ts`); the
mod then answers `PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT` ("update Plannotator
to open several files at once") for the tool, and for `/plannotator-annotate`
when every word reads as a file path (`isSeveralFilePaths`). There is no
`reply` action: it was reserved for live comments and always errored, so it
was taken out of the schema; it comes back with the comment loop. Design:
`.product/drafts/agent-sessions-0.29/DESIGN.md`.

**Agent-run CLI commands are taken over (Bash).** Because the tool is deferred
and the skill also documents the CLI, Claude sometimes runs
`plannotator annotate x.html --gate --json` in Bash anyway; that blocked the
session and started a server with no bridge token, so Ask AI offered separate
SDK agents instead of "Ask this session". With the mod on, the `tool.call` hook
on the MAIN LOOP's `Bash` parses the command with the host-neutral
`plannotatorCommandToToolInput` (CONTRACT section of
`packages/shared/plannotator-tool.ts`, so it is in the mod's copy too) and, when
it returns a tool input, answers the call itself through the SAME `runTool` →
`open` launch the tool uses (`hooks/mod/take-over.ts`): the command never runs,
the Bash result is the Bash tool's own record `{ stdout: <the tool's opened
text>, stderr: "", interrupted: false }` (a startup error is a `deny`), and a
gated take-over delivers its bare approval as a turn exactly like a gated tool
call. A subagent's Bash command always runs as written: a subagent may work in
its own cwd or worktree, while the mod launches in the session's cwd, so its
`review` or `annotate notes.md` would open the wrong diff or file. Taken over: ONE simple command (no
`; & | < > ( )`, line break, `$`, backtick, unquoted glob/brace, comment, `~user`, unterminated
quote; quoting follows `splitShellWords`, nothing is expanded) whose program is
exactly `plannotator` (the binary on PATH; a path such as `./plannotator` or
`/tmp/dev/plannotator` is a dev build and runs for real), subcommand
`annotate` (one target, or several that all read as file paths, `looksLikeFilePath`: a separator, a leading `~` `.` `@`, or a file extension; they become `target: [...]`, a review of several files; plus `--gate`, `--markdown`), `review` (at most one target, `--base <ref>`),
or `annotate-last` / `last` (no arguments); `--json` is accepted and dropped
(the decision arrives as a message), and the result must pass
`parsePlannotatorToolInput`. Everything else runs as written: other
subcommands, every other flag (`--require-approval`, `--result-file`, `--hook`,
`--tailscale`, `--static`, `--app`, `--no-jina`, `--render-html`,
`--diff-type`, `--local`, `--patch-file`, `--stdin`, `--help`, ...), repeated
flags, several targets that are not all file paths (prose, which the CLI's
tolerant resolution reads) or several review targets, environment prefixes, and any compound command
(`cd x && plannotator ...`, pipes, redirects, substitutions), so scripted
strict gates keep the real CLI and its exit codes. With the mod off, in `-p`/SDK
runs and on Windows nothing is taken over. The CLI the mod launches runs in the
session's cwd (`$.process.run`'s default), the same as for the tool. Pi and
OpenCode do not take over shell runs: there an agent-run `plannotator` command
still runs the CLI (Pi registers the tool itself; see "Pi: the `plannotator`
tool").

**Plan review.** The `tool.call` hook on the main loop's ExitPlanMode resolves
the plan (the plan file when it is an absolute `.md` regular file within the
2 MB cap, else the inline `plan`: the #1667 rule), then:
1. no review open: starts `plannotator claude-mod-plan` (internal subcommand,
   `apps/hook/server/claude-mod-plan.ts`; stdin `{ plan, planFilePath,
   revisionFile }`; the plan server with `planRevisions: true`) and answers
   `{ deny }` with the waiting text (`waitingDenyText`). ExitPlanMode never runs,
   so plan mode stays on.
2. a review open: writes `revision.json` `{ seq, plan }`; the subcommand polls it
   every 500 ms, pushes it with `updatePlan` and acks; the deny text says
   "Plan vN replaced vN-1" (or, when a decision is already being recorded,
   to wait for it). Spec open question 2 resolved like Pi: revisions go into the
   same tab.
3. the plan's SHA-256 (trailing whitespace ignored) equals an approval's: the
   call passes (`next(e)`), and `classic.PermissionRequest` answers `allow`
   with `updatedInput.plan` = the approved text (#1670's "execute what was
   approved") and `setMode` to the reviewer's permission mode. Modules sit above
   the settings hooks in that chain, so the plugin's own PermissionRequest
   command hook never runs: no second review. A different plan opens a new
   review instead.
Decisions: deny and answers-only submit the denied / answered prompt; approval
submits the approved (or approved-with-notes) prompt plus
`PLAN_APPROVAL_NEXT_STEP` ("Call ExitPlanMode once more …"), the two-hop
approval of spec open question 1 (the one-hop `$.tool.call` path is untested).
The claim the subcommand records (`currentPlan` after each accepted revision) is
what `approvedPlan` carries. If the plan server cannot start, the call falls
back to Claude Code's own flow (and the classic hook). A subagent's
ExitPlanMode keeps the classic flow. Not built: the edit guard (spec: deny
Edit/Write while a plan is in review after the user leaves plan mode), the
`AbovePrompt` band with Send now / Hold, the `/plannotator` sessions pane, the
`UserMessage` / `ToolUse` render hooks, and `tab-closed` detection; a decision
is always sent (`$.prompt.submit` waits for idle; draft text in the composer
is left alone).

**Delivery.** Each decision is one plugin turn, in arrival order, prefixed
`Plannotator: <subject> — <outcome>.`; a message over 12 KB is written in full
to the launch's `feedback.md` and Claude is told to Read it (the feedback
archive may be off, so the mod writes its own copy). Status line
(`$.ui.status`): `<subject> · waiting for you` / `N open · …`; toasts for a plan
waiting or replaced and for feedback received; `$.ui.log` for no-op decisions,
stopped servers and reattachment.

**Session tag.** `session.start` sets `PLANNOTATOR_SESSION_TAG=claude-code:<session id>`
with `$.env.set`, so every process the session starts (Bash calls, hooks, the
detached servers) inherits it; `registerCliSession` records it as
`hostSession` in the `sessions/` registry.

**Ask this session.** Every launched server gets a 32-byte hex token
(`PLANNOTATOR_SESSION_BRIDGE_TOKEN`, `_HOST=claude-code`, `_MODES=turn`). Once
the ready file names the port, the timer starts `createBridge` (`bridge.ts`, the
pull-bridge client over `$.http.fetch` to `http://127.0.0.1:<port>`, no Origin):
an `ask` is submitted as a real turn (`$.prompt.submit`), identified at
`turn.start` by its header and last line (Claude Code frames a plugin prompt as
"The plannotator plugin sent a message: …", seen live), streamed back from
`turn.step` text/tool chunks, and finished from `turn.complete`'s `answer`.
`busy` = a turn is running (pushed on `turn.start` / `turn.complete`, not only
at the next poll); `interrupt` aborts the running turn (`$.turn.abort`);
cancel aborts our own turn, or, while it is still queued, confirms at once and
aborts its turn the moment it starts. Claude Code never raises a plugin's own hooks
for a prompt its code submitted (the debug log says "skipped: re-entry"), so the
mod's `prompt.submit` hook sees every OTHER prompt (the user's Enter, a
notification, another plugin); a turn whose text is exactly one of those is
never claimed, so a prompt the user typed can neither be streamed to
Plannotator nor aborted by a cancel, whatever it says. Another plugin's prompt
reaches `turn.start` inside the engine's "The <name> plugin sent a message:"
frame while `prompt.submit` saw it bare, so the match also strips that frame.
**Take-over** (`turns.ts`): a prompt typed or delivered while a turn runs fires
`prompt.submit` at Enter with that turn's `turnId`, and the engine folds it
into the turn's next model request. When that turn is our question's and the
origin is on an ALLOWLIST of messages the model must now answer (`composer`,
`bridge`, `slack-ping`, `channel`; never `peer` (owner's call: a peer
session's reply streaming into the panel is better than losing the reviewer's
answer), `task-notification`, `peer-send-message`, `scheduled-trigger`,
`observer*`, `coordinator`,
`projects-relay`, `auto-continuation`, `unclassified` or a kind added later),
streaming stops the moment the prompt reaches the mod's `prompt.submit` hook,
BEFORE `next(e)` runs the hooks beneath (a slow one cannot let the next step
through); the take-over is confirmed when `next(e)` resolves with the prompt,
and a prompt a hook beneath drops releases the hold. The step in flight was
requested before their prompt, so its output is held and released when the
question settles: at the turn's next `turn.step` (that request carries their
prompt) as `done` when the response before it ended the answer (`stop` chunk
`end_turn`, no tool call) and some answer text was shown, else as `taken_over`
(a thinking-only final response would otherwise settle an empty answer); or at `turn.complete` when no
step followed, as `done` with the turn's answer (their prompt then runs as a
turn of its own). The note reads "You typed into this session…" for
`composer` / `bridge` and the neutral "Another message entered this session…"
otherwise. From the take-over on, a cancel closes only the question and an
interrupt answers `ok: false`; Plannotator never aborts that turn. Plan review does not block the session
under the mod, so the status is never `blocked` and plan review gets real turns
too (verified live). Polls ask for 15 s (750 ms while our question streams, so
deltas flush), and stop for good on 401/403/404/405/503 (`404` = an older CLI
without the bridge), `closing`, or once the review settles. A loop that stops
because the server stopped answering (six failures in a row; `$.http.fetch`
gives up after 30 s, so a sleeping laptop or a paused server gets there in
about three minutes) is not the end: `run()` reports why it ended
(`BridgeEnd`), the controller clears the handle, and the timer starts a new
loop with the same token after 5 s, doubling to 60 s while the server stays
silent (`BRIDGE_RETRY_MS`), so Ask AI comes back once the server answers again.
A poll answered `superseded: true` (another client polled the server after us)
waits 10-15 s before polling again, instead of taking the server back at once
and starting a busy loop with the other client.

**The Plannotator Inbox (`plannotator_inbox` and the reply wake, `inbox.ts`).** Where `inbox/inbox.json` exists at the first `session.start` and `PLANNOTATOR_INBOX_TOOL` / `inboxTool` allows it (on by default here), `register.ts` reads the Inbox's tool list once (`discoverInboxTools`: `tools/list` on its `/mcp`; a stopped Inbox is described by the list it last answered with, kept in `$.store` as `inboxTools`; with neither, no tool) and registers `plannotator_inbox` (`inboxAgentTool`), a SEPARATE tool, never actions on `plannotator`. No registry: nothing is registered and nothing polls. The session's `PlannotatorMod` owns an `InboxLink` (one per session id, so `/clear` and an in-process resume follow the new id: the old link is disposed at `session.end` and the next hook makes one for the new id). A call (`tool.call`, answered by the mod) re-reads the registry, checks health against its `serverSession`, starts a stopped Inbox with `plannotator inbox --background` (a one-shot that detaches the Inbox into its own session and waits for it; never a browser tab), and proxies to `/mcp` with `project_path` = `$.session.cwd()` and `agent_session` = the host's real session id; `wait_for_reply` is held to 25 s through the tool (`$.http.fetch` gives up at 30 s). The wake: a 1 s `$.clock.every` tick long-polls `/api/inbox/bridge/poll` (20 s) with a 5 to 60 s backoff that never gives up; a reply waits in the mod until the session has been idle for two ticks (a pending `$.prompt.submit` cannot be withdrawn, so a prompt the person typed, or a `/clear`, queued during a turn goes first), is checked once more with the Inbox (an agent may have read it meanwhile), claimed once across processes (`INBOX_CLAIM_SCRIPT`: mkdir of `claude-code-mod/<session>/inbox/claims/<reply id>`), submitted (`inboxWakeText`), and acknowledged (`delivered`, retried until the Inbox answers). A prompt typed into the reply's own turn takes it over as Claude Code folds it in; the mod never aborts it and never delivers the reply again. Two processes on one session: the session's inbox lease (`claude-code-mod/<session>/inbox/watcher.json`, the rules of the review watcher lease: the person's last process wins, 20 s stale) picks the one that polls and delivers, and the claim makes a lease race harmless; a claimant writes `alive` while its turn waits, and a reply whose claimant stopped for 60 s without `delivered` is reported once with a toast (the only toast the connection raises); one marked `delivered` whose acknowledgement was lost is acknowledged by the other process. Nothing touches the system prompt; the tool list is fixed per process. Version skew: an Inbox without the bridge route (404) just leaves the poll backing off; an action the running Inbox lost answers "update Plannotator"; a `plannotator` without the `inbox` subcommand answers that the binary has no Inbox.

**Tests.** Bun: `apps/hook/hooks/mod/*.test.ts` (controller flows over an
in-memory `Host`, delivery, shell words, and `bridge.test.ts` against the REAL
server half `createPullSessionBridge`), `apps/hook/server/host-result.test.ts`,
`apps/hook/server/claude-mod-plan.test.ts` (the subcommand as a process:
revision → tab → approval carries the revised text; answers-only),
`apps/hook/server/host-messages.test.ts` (`annotate-last --stdin` as a process:
the messages file yields the picker, a malformed one exits 1, plain `--stdin`
unchanged). Engine
harness: `apps/hook/tests/register.test.ts` via `scripts/test-claude-code-mod.sh`
(stages the plugin without the CLI, whose bun tests `claude plugin test` would
otherwise try to load; bun skips `apps/hook/tests/` through `pathIgnorePatterns`).
Typecheck: `apps/hook/hooks/mod/tsconfig.json` (no DOM, no Node; `globals.d.ts`
declares the few web APIs a hooks module has). `PLANNOTATOR_MOD_DEBUG=1` writes
`claude-code-mod/debug.log` in the data dir. The Inbox connection is proved against a REAL Inbox in `apps/hook/hooks/mod/inbox.test.ts`: `plannotator inbox --background` under a temp data dir (the compiled binary when `PLANNOTATOR_INBOX_TEST_BINARY` names one, as `.github/workflows/inbox-claude-code.yml` runs it; the CLI from source otherwise) and the mod's own code on a Host of real processes, HTTP and files (`testing/claude-session.ts`, which simulates the conversation the way `register.ts` feeds it): no registry stays silent, the tool carries what the Inbox's `/mcp` offers, `send_message` lands a thread, the window's Send arrives once as a turn with the stable header and the reply verbatim (delivered, then replied), a typed prompt goes first and takes the reply's turn over, `/clear` follows the new id, two processes deliver once, and a dead Inbox is started by the first call with no browser tab. `INBOX_PROOF_DIR=<dir>` keeps a transcript per proof. The engine harness (`apps/hook/tests/register.test.ts`) covers the wiring with the engine's own `$`.

### OpenCode 2: the `plannotator` tool

The OpenCode 2 plugin (`apps/opencode-plugin/server.ts`, `registerPlannotatorTool`)
registers the same `plannotator` tool the Claude Code mod does, through
`ctx.tool.transform` → `tools.add`, with the shared contract itself
(`PLANNOTATOR_TOOL_NAME` / `_DESCRIPTION` / `_INPUT_SCHEMA` and
`parsePlannotatorToolInput` from `packages/shared/plannotator-tool.ts`, never a
copy; `plannotator-tool.test.ts` checks the registered schema IS the shared
object). It is OFF by default on OpenCode 2; turned on (`PLANNOTATOR_AGENT_TOOL=1`
/ `{ "agentTool": true }`, `resolveAgentTool(loadConfig(), process.env,
"opencode")`, read once at plugin setup; a change applies when OpenCode
restarts) it is registered for every workflow (`manual` included), and not at
all where the decision could never come back: a tool draft without `add` (an
older V2 host, probed inside the callback like the native commands' draft) or
a session domain without `prompt`. OpenCode 1 gets no tool in 0.29 (design
decision; its `plugin.tool` route is feasible).

**Open (annotate, review, last).** Each call runs the SAME launch the native
slash commands use (`runNativeCommand` → `handleCliCommand`: a `plannotator`
CLI child, the pull-bridge token so "Ask this session" works, the ready file,
the decision delivered later to the calling session with `session.prompt`),
and the tool returns as soon as the ready file names the url (up to 45 s for
review, 15 s otherwise, then the "starting" text): `Session: pn-…` plus
`plannotatorToolOpenedText`. A refused argument or the CLI's startup error is
the result text (`Plannotator could not start: …`; results are always text,
since the promise adapter turns a rejected `execute` into a defect). The
annotate target is passed as ONE argument (`toolLaunchRequest` builds
`ParsedAnnotateArgs` instead of re-parsing a string, so `my notes.md` stays one
path); review words are quoted for `parseReviewArgs`' string form
(`quoteReviewWord`). A gated tool session delivers its bare approval
(`Plannotator: notes.md (pn-…) — Approved.`), like the mod; a slash command's
bare gated approval still sends nothing. A list of files (two or more after the
contract drops duplicates) opens ONE bundle review through the same launch:
`handleCliCommand`'s `annotateBundle` passes each entry as its own CLI argument
in the agent's order (never re-split, and a single tool target is never read as
several words), the subject is `plannotatorBundleSubject` (`2 files: a.md,
b.html`) in the result, `list` and the decision heading, and the feedback is
framed under `Files: …` as the slash command's bundle is. An older CLI's
several-paths ambiguity error (`isOlderCliBundleRefusal`) makes the result
`PLANNOTATOR_TOOL_BUNDLE_UNAVAILABLE_TEXT`. When a launch
answered "starting" and its CLI then fails before the page opens, the session
gets one message (`plannotatorLateFailureText`: `Plannotator: notes.md (pn-…) —
Did not open.` plus the CLI's error), delivered with `session.prompt`
(`queue`), so neither the agent nor the person waits for a decision that never
comes; OpenCode 2's plugin context has no toast surface, so that transcript
message is the visible signal. A command that merely ends without a ready file
sends nothing (a CLI older than 0.19.24 writes none and delivers its decision
at exit). Subagents work as on the mod: a subagent's (child) session resolves
to its root session (`resolveRootSession` walks `parentID`), which owns the
review, gets its decision and lists or closes it; only `last` is refused from a
subagent (`PLANNOTATOR_TOOL_SUBAGENT_LAST_TEXT`, the mod's wording), since it
reads the main session's messages. Ask this session for such a review asks the
root session. Not verified live: delivery to the root while it still waits on
the subagent relies on `queue` delivery. A tool launch posts its session-URL
notice into the CALLING session (a subagent's own session, never the root that
receives the decision) and only while the tool call is still open
(`createV2BridgeClient`'s `notice: { sessionID, open }`, closed the moment
`runPlannotatorTool` answers), so the notice is always promoted inside the
caller's running turn; the tool's answer already carries the URL, and a server
that comes up after a "starting" answer posts no notice (the URL is in `list`
and the log). Posting it into the root was a leak (0.28.5 smoke, live on
2.0.22): a background subagent's root, or the parent of an API-created child
session, is idle, so the pending steer sat there and was promoted ALONE as a
model turn when the root next woke (the queued decision promotes one row at a
time), and the model answered "Plannotator session ready: <url>". With the
notice always inside a running turn, tool launches always queue their decision
(`alwaysQueue`; co-promotion is also only attempted for a notice in the
decision's own session), since the slash commands' co-promoting steer (#1515)
would push a late decision into a running turn. No
shell take-over: nothing in the OpenCode 2 plugin API can answer a shell call.

**Session ids, list and close.** `OpenCodeLaunchRegistry` (one per plugin
instance) records every review a session opens: tool calls, its slash commands
(`runNativeCommand` with `launches`), and its `submit_plan` review (listed,
never closable). Every recorded launch's decision message starts with
`plannotatorDecisionHeading` (`withDecisionHeading` in `cli-bridge.ts`), slash
commands included, so `list` and the decision name the same id. Its outcome
uses the mod's words: `Feedback · N comments`, `Approved with notes · N
comments`, `Approved`, and for code review (local or PR) `Changes requested ·
N comments`. The count comes from the CLI's additive `annotationCount` on the
`annotate --json`, `opencode-annotate-last` and `opencode-review` records (an
older CLI omits it and the heading has no count). A PR-platform status post
reads `Review posted` (`PLANNOTATOR_OUTCOME_REVIEW_POSTED`, the same words as Pi) and is decided by the record's `platform` flag (#1719;
`isPlatformPost`, falling back to `isPRMode` only for a CLI without the flag),
never inferred from zero annotations, so description-only PR feedback is
`Changes requested`. `list` and
`close` see only the calling OpenCode session's launches (never the global
`sessions/` registry; another session's id is "not found"). `list` reads
`GET /api/host/status` with the launch's token for `unsent` and `decided`
(`readHostStatusAnswer`; `unknown` for an older CLI). `close` posts
`POST /api/host/close` and reads the answer with `classifyHostCloseAnswer`
(`packages/shared/host-control.ts`, the mod's rule): closed (draft kept, the
tab told, nothing delivered, since the CLI's record is then `dismissed`),
decided (the reviewer's decision is on its way), refused, turned off (left
running; the text says remote mode only when the ready file did, and otherwise
names a server started without a host token), or not answering (left
running). `close all` skips plan reviews silently; only an explicit plan id
gets the "not closable" line. A close that stopped an older CLI is logged as
the agent's close, not as a CLI failure (`isClosedByAgent`). Only a server that
answered as an older Plannotator without the endpoint (an uncoded JSON `404`
or its app page) is stopped instead: SIGTERM to the plugin's own child process
(`terminate` from `runPlannotatorCli`'s observer), which never deletes a
draft; a decision such a CLI is still publishing is lost, as on the mod.

Tests: `apps/opencode-plugin/plannotator-tool.test.ts` (registration against
older drafts and without `prompt`, refusals, and the real launch path against a
stub CLI that serves the real host-control guards: open → url and id → list →
decision heading in the right session, gated bare approval, close with the
token, turned-off close leaves the server up, older CLI stopped, startup
error, a slash command listed). Checked live on OpenCode 2.0.22 with a fake
model: the model's tool call opened annotate and review, `list` showed the
server's count, the reviewer's feedback and a gated approval arrived as new
turns headed with the id, `close all` closed a review holding 2 draft comments
with no turn delivered, and Ask AI showed "Ask this session". A list target
(`["notes.md", "mock.html"]`) opened one `annotate-bundle` session in that
order, `list` named it `2 files: notes.md, mock.html`, its feedback arrived
headed `— Feedback · 2 comments.` under `Files: notes.md, mock.html`, and
`close all` closed a second bundle.

### Codex Stop hook: which turn the plan belongs to

Codex has no `ExitPlanMode`, so plan review rides its experimental `Stop` hook:
the hook reads the session rollout and returns the plan **the turn that just
stopped** produced. Anchoring on a turn is what keeps an older, already-decided
`<proposed_plan>` from being reopened (#1169), and the turn is resolved in
`resolveCodexStopPlan` (`apps/hook/server/codex-session.ts`) in two tiers:

1. **The payload's own `turn_id`** when the Stop JSON carries the field.
2. **The rollout's own turn markers** when it does not: the id of the LAST
   id-carrying `turn_context` / `task_started` marker in the newest rollout
   segment. A turn still in flight owns the last markers by construction, and
   when Stop fires at turn end the last marker is that turn's own, so one rule
   covers both shapes. The scan then still anchors on that turn's **first**
   marker, so a mid-turn compaction (which re-emits `turn_context` with the same
   id) cannot hide a plan the turn produced before it.

Tier 2 exists because `StopCommandInput.turn_id` only landed in Codex
**rust-v0.117.0** (`rust-v0.116.0-alpha.12`), while the hooks engine itself
shipped in **rust-v0.114.0**: stable `rust-v0.114.0`, `v0.115.0` and `v0.116.0`
fire the Stop hook with no `turn_id` at all. Their rollouts do record the id on
every turn marker (`TurnContext::to_turn_context_item` writes
`turn_id: Some(sub_id)`), which is what the fallback reads. Using it writes one
unconditional line to **stderr** (`logCodexStopTurnIdFallback`; stdout is the
hook's JSON decision channel, and Codex only reads a Stop hook's stderr on
exit code 2, which this hook never uses).

Fail-closed cases are unchanged: a payload that carries `turn_id` as a blank
string — or as anything that is not a string — is truncated or foreign, not an
old Codex, and is refused **before the rollout is read**; a rollout with no
id-carrying turn marker at all skips too. Both skips stay silent unless
`PLANNOTATOR_DEBUG` is set.

The deny→resubmit guard follows the same two shapes. When `stop_hook_active` is
set, the plan is served only if it changed across the boundary the previous
blocking Stop left in the turn. Codex >= 0.117 records that boundary as a
`<hook_prompt>` **user** message (`build_hook_prompt_message`); `rust-v0.114.0`,
`v0.115.0` and `v0.116.0` record it as a **developer** message
(`DeveloperInstructions::new(continuation_prompt)`), so the rollout-fallback
path — and only that path, which keeps every `turn_id`-carrying Codex
byte-identical — also accepts the last developer message in the turn as the
boundary. Without it the guard is inert on exactly the versions the fallback
enables, and an unrevised denied plan is re-served on every Stop of the turn.

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
Approve → approved prompt sent to agent session (with the note/annotations when approving with notes)
```

### Color-free VCS output (#1661)

Every git command the review servers parse goes through `prepareGitCommand`
(`packages/shared/review-core.ts`, both runtimes), which prepends
`GIT_COLOR_FREE_ARGS`: `--no-pager` plus `-c color.<key>=never` for `ui`,
`diff`, `status`, `branch`, `grep`, `showBranch` and `interactive`.
`color.ui=never` alone is not enough, because an explicit `color.diff = always`
in the user's config wins over it and colors a piped diff, which used to parse
to 0 files and 0 viewed-file identities. jj gets `JJ_COLOR_FREE_ARGS`
(`--color=never --no-pager`, `packages/shared/jj-core.ts`) in both runtimes'
`runJj`, `gh pr diff` gets `--color=never`, and agent jobs inherit the same git
settings as `GIT_CONFIG_*` variables (`gitColorFreeEnvironment`). As a backstop,
`parseDiffToFiles` strips ANSI codes from a patch whose `diff --git` headers are
colored (`stripPatchColor`, `packages/core/diff-files.ts`); a normal patch is
returned byte for byte. A new git/jj spawn that bypasses these runners must add
the same options. `packages/server/review-git-color-config.test.ts` runs both
servers against a sandboxed config that forces color on.

### Review directory targets

`plannotator review [DIRECTORY | PR_URL]` (and `/plannotator-review` on OpenCode
and Pi) accepts one local repository/worktree or multi-repo workspace directory.
The shared `parseReviewArgs` + `resolveReviewTarget` resolve it against the
invoking terminal/session cwd, validate it before discovery, and reject multiple
targets or a directory combined with `--patch-file`. Prose stays tolerated
(#1483, the annotate-target precedent): a sole word or any path-shaped word is a
directory candidate (path-shaped typos and files error), every other word is
ignored with a notice and the invoking cwd is reviewed. Hosts pass the resolved cwd
through existing VCS/workspace discovery and project detection; never use
`process.chdir()` in a plugin host. Explicit targets inside a repository normalize
to its detected VCS root. OpenCode uses the internal `opencode-review-directory`
command for these targets so an older CLI rejects them rather than silently
reviewing the caller's repo; ordinary reviews keep `opencode-review`.
Feedback still goes to the invoking agent
session, with `withReviewDirectory` naming the active directory at submission when feedback has content
(a bare approval stays bare). File operations, AI jobs and persistence continue
using the resulting `gitContext.cwd` / workspace root.

### Review header decision control (agent mode)

The agent-destination review header uses the same adaptive split control the annotate surfaces
adopted: a ghost-X Close plus `DecisionControl` (`packages/ui/components/DecisionControl.tsx`)
rendered from the pure `buildDecisionSpec` mapping — `Approve` with no annotations,
`Send Feedback` otherwise, with `Request changes…` / `Send with a note…` and the explicit
`Approve, discard n annotations…` confirm behind the caret. One `submitPrimaryDecision()`
callback serves the header primary, the global `Mod+Enter` handler, and the compact primary row.
Transport routing is pure in `packages/review-editor/reviewDecision.ts` and single-endpoint:
every decision POSTs `/api/feedback` with `approved` as the only fork; a change-request note
becomes a `scope:'general'` `CodeAnnotation` (sentinel `filePath ''`/0/0, riding the export's
`## General` section) with a one-render deferred submit — zero server change. Approve-carrying
menu items (`Approve with notes`, `Approve with a note…`) are capability-gated on the
server-sent `approvalNotesSupported` advert, which rides every diff payload (`/api/diff`,
`/api/diff/switch`, `/api/pr-diff-scope`, `/api/pr-switch`, both runtimes) and reads as false
when absent, so an old server renders no approve-carrying items. For the OpenCode CLI bridge
the advert additionally requires the plugin's own `supportsApprovalNotes: true` declaration on
the `opencode-review` stdin JSON (the binary and plugin version independently; an old plugin
omits it and the advert fails closed, so a new binary can never hand an old bridge a note it
would discard). A capable session's approvals post `buildReviewApprovalBody`: bare approve
sends `feedback: ''` (the old `'LGTM - no changes requested.'` placeholder is gone — a bare
approval now archives as `lgtm` with no sidecar), "Approve with a note…" sends the note as the
feedback, and "Approve with notes" sends the live annotations plus their export (a note, if
both are ever present, is folded in ahead of the export — never dropped). The four agent-facing
decision consumers (Claude Code CLI, OpenCode native + CLI bridge, Pi) emit approvals through
the shared `composeReviewApprovedMessage` (`packages/shared/prompts.ts`, vendored to Pi):
a bare approval is the plain approved prompt; an approval carrying feedback uses the
approved-with-notes framing (`prompts.review.approvedWithNotes`, default
`DEFAULT_REVIEW_APPROVED_WITH_NOTES_PROMPT` — "non-blocking guidance, do not revise or
reopen"), because the bare prompt plus a change-request-shaped export would read as a
contradiction. The legacy placeholder is filtered there so a stale built client cannot get
filler framed as guidance. The standalone dev server (`apps/review/server`) is the exception:
it emits the raw decision JSON with the feedback unfiltered and does not route through the
composer. Compact/touch rows are generated from the same spec, so a visible positive decision
exists in every state; composer rows open `DecisionNoteDialog`. Platform (PR) mode renders the
same ghost-X + `DecisionControl` shape from `buildDecisionSpec`'s platform arm, with **no
composer items ever**: every menu action opens the existing `ReviewSubmissionDialog` (per-target
state, retry, "leave PR open" toggle — whose general-comment textarea is the only note field on
that side), and the self-approval mute is preserved — muted primary/items with the "You can't
approve your own {PR/MR}" reason.

**Request changes is a real review event (#1611).** `PRReviewAction` (`packages/shared/pr-types.ts`)
is `'approve' | 'comment' | 'request_changes'`, carried end to end: `resolvePlatformDecisionAction`
returns `{ action, chooseEvent }`; `Post comments, then…` opens the dialog with a Comment /
Request changes choice (Comment selected) and the empty-state `Request changes…` preselects
Request changes, while the primary `Post Comments` keeps the plain comment flow with no choice.
`POST /api/pr-action` validates `action` with `parsePRReviewAction` in BOTH runtimes (anything
else is `400`, never a silent COMMENT), and `submitGhPRReview` maps it to `REQUEST_CHANGES` on the
single create-review call AND on the pending-review → `/events` submit path (#1600), with the
same `See inline comments.` placeholder COMMENT gets when the body is empty (GitHub requires a
body on both). GitLab has no request-changes review: `request_changes` posts exactly what
`comment` posts, the menu subtitles say so (`requestChangesSupported: false` on the spec's
platform input), and the dialog's Request changes option is disabled with that reason. GitHub
refuses REQUEST_CHANGES on your own PR like APPROVE, so with `requestChangesSupported: true` and
`selfAuthored` the empty-state `Request changes…` mutes with its own reason and a live
`Comment…` row (`note-with-feedback`, compact id `comment`) keeps the state from being a dead
end; `Post comments, then…` stays live with the dialog option disabled. The spec field is
optional and absent keeps the pre-#1611 copy for hosts. In a stacked multi-PR submission every
target posts the same event; the choice locks once any target may have been posted
(success/partial/blocked) so retries and the tab-scoped recovery (which stores `action`) keep
that event, while after a plain failure (nothing posted) it can still change. A refusal GitHub
answers anyway surfaces its own reason through the #1600 `githubErrorDetail` path.

**PR platforms are providers (#1583).** GitHub, GitLab and Bitbucket Cloud each implement one
`PRProvider` (`packages/shared/pr-provider.ts`: `checkAuth`, `getUser`, `fetchPR`, `fetchContext`,
`fetchFileContent`, `fetchFileBytes`, `submitReview`, plus optional `fetchViewedFiles` /
`markFilesViewed` / `fetchStack` / `fetchList`); the dispatch functions look the provider up by
`PRRef.platform`, and an absent optional method is the neutral answer (no viewed state, no stack,
empty PR list). What the UI shows comes from `getPRPlatformCapabilities` (`packages/shared/pr-types.ts`,
browser-safe): `requestChanges`, `selfReviewBlocked`, `fileLevelComments`, `viewedSync`, `artifacts`,
`reviewBodyRequired`, `agentCliAccess`, labels and the CLI. Pure helpers replace the old
`platform === "github" ? number : iid` ternaries: `getPRNumber`, `getDisplayRepo`, `getPRHeadFetchSpec`
(where a local checkout fetches the head: `refs/pull/N/head`, `refs/merge-requests/N/head`, or
Bitbucket's source branch, from the fork URL when `sourceRepo` is set) and `getPRCloneCommand`.
GitHub/GitLab outputs of all of these are pinned byte-for-byte (`pr-platforms.test.ts`, including the
draft target keys). Bitbucket specifics: REST API 2.0 over `fetch` (`packages/shared/pr-bitbucket.ts`,
vendored to Pi), credentials per the `PLANNOTATOR_BITBUCKET_*` rows above; the PR object's 12-char
hashes are resolved to full SHAs and the merge base comes from `/merge-base` (the PR diff is
three-dot); existing inline threads get a GitHub-shaped `diffHunk` cut from the PR diff (`bitbucketDiffHunk`), since Bitbucket comments carry none; a review posts each line comment as an inline comment
(`inline: { path, to | from, start_to | start_from }`), THEN the body as one general comment (the
Activity feed lists newest first, so this puts the summary above the inline comments, #1583), then
`POST /approve` or `POST /request-changes` (so `requestChangesSupported` is true, and an author may approve their own PR,
so nothing is muted); it follows GitLab's partial contract, with `retry.action` naming the failed
decision (`request_changes` included) and `retry.body` carrying the general comment when that is the
part that failed after inline comments landed (`buildPRActionRequest` resends exactly it). File-level comments fold into the body, there is no viewed sync
and no stack discovery, the PR Artifacts panel is hidden (`artifacts: false`), and agent review, Code Tour and
Guided Review prompts carry the diff inline when no local checkout is ready (`agentCliAccess: false`: no CLI a job may run can read the PR). The portable
guide format names only github/gitlab, so a Bitbucket guide omits `source.pr.platform`. Recorded
(anonymized) API responses and a fake API server live in `tests/test-fixtures/bitbucket/`;
`scripts/bitbucket-live-smoke.sh` runs the real flow against a throwaway repo.

Interaction-model changes worth knowing (F8 and siblings): the agent-mode `Approve` primary
follows the `FeedbackButton` responsive pattern and is **icon-only below the `lg` breakpoint**,
where the old `ApproveButton` showed a compact `OK` label — the `title` carries the accessible
name, and compact/touch rows keep full labels. Approving despite annotations is now two clicks
(caret → `Approve, discard n annotations…` → `Discard & approve`) instead of the old dimmed
one-click Approve with its warning dialog, and `Mod+Enter` never stacks with the removed
approve-warning dialog — an open confirm dialog owns `Mod+Enter` outright (the
`data-plannotator-confirm-dialog` sentinel guard in the app's keydown effect; without it one
keystroke over the discard confirm would post two contradictory decisions). Accepted edge: the
compact `DecisionNoteDialog` keeps its draft locally and discards it if the item behind it leaves
the live spec (the dialog closes), while the desktop popover composer keeps drafts keyed by item
id — an intentional asymmetry, not a bug.

The review sidebar carries the durable human producer for review-level comments:
**"+ General comment"** renders in the Annotations tab's General section header (even with zero
general comments) AND in the all-empty state, opening the shared `DecisionNoteField` in a small
anchored popover whose width clamps to the resizable panel (200-600px persisted) so it never
clips inside the sidebar's `overflow-x: hidden` scroll area. Composer state (open + draft) lives
in `ReviewSidebar`, shared by both placements: the draft survives a dismissal, a placement flip
(an external annotation arriving mid-sentence moves the button from the empty state to the
section header), and a tab switch; collapsing the sidebar discards it. The producer is
deliberately present in platform (PR) mode too — a session-level comment there rides the posted
review body through the pre-existing `scope:'general'` handling in `buildFileScopedBody` /
`ReviewSubmissionDialog`. Unlike the header composer's submit note (one-submit lifetime), a sidebar
general comment goes through `addCodeAnnotationsWithHistory` — undoable, draft-persisted,
deletable — and both producers share one shape factory, `createGeneralReviewComment` in
`reviewDecision.ts`: `scope:'general'`, sentinel `filePath ''`/0/0, `review-note-` UUID id, and
deliberately **no PR context**, so the comment passes every PR scope predicate and survives an
in-place PR switch. Creating one raises `totalAnnotationCount`, which is what flips the header
control to `Send Feedback` — the control is state-driven, not wired to the button. The
feedback archive records each annotation's `scope` (additive `scope?: string` in
`packages/shared/feedback-archive.ts`'s normalizer, vendored to Pi), so a review-level general
comment stays distinguishable from a line comment in `index.jsonl`.

### Since-main default review view

The default code-review diff is **`since-base`** — a composite of `merge-base(base, HEAD)` vs the working tree plus untracked files ("everything a PR would show if you committed and pushed now"). It can render as a three-section **git status** panel (Committed / Changes / Untracked) via `SectionsPanel`, with a `Tree | Git status | Commits` toggle (`PanelViewToggle`). The Commits segment (local git and jj sessions; not GitButler, P4, workspace or PR mode) is a linear `--first-parent` history rail (`CommitsPanel`): clicking a commit opens its own diff (`commit:<sha>`, vs its first parent) as the all-files view headed by the commit message rendered as markdown. In a jj session the same rail and contract run over the jj family (`listJjCommitHistory` / `getJjCommitDiffInfo` in `packages/shared/commit-history.ts`, vendored to Pi): the rail is `first_ancestors(@) ~ root()` (jj >= 0.33), dropping `@` when it is the usual blank working copy (empty, no description, exactly ONE parent: a blank merge `jj new A B` stays, since its first-parent diff is real), `isHead` marks `@` (badge `@`, not `HEAD`), `shortSha` carries the short CHANGE id while `sha` stays the full commit id, and the divider is the jj compare target (`resolveJjCommitRailBase`: the session base, except an Evolution-diff base, which is not a line base, falls back to the context's line base; labeled by its bookmark). A click opens `jj-commit:<commit id>` — a separate family because providers claim diff types by prefix and git owns `commit:` (a pure jj repo has no git work tree), always addressed as `commit_id(<id>)` so a hex-named bookmark cannot shadow it — diffed `--from <first parent> --to <id>` (never `jj diff -r`, which compares a merge against all its parents), with hunk expansion, image previews, the fingerprint and the analysis snapshot going through the same per-VCS tables as every other jj type (`resolveJjSideRevs`, `getJjSnapshotRevsets`). jj REWRITES a mutable revision on every edit (the working copy on every snapshot) while the old id keeps resolving as a hidden commit, so the jj-commit fingerprint is visibility-aware (`commit_id(X) & ::visible_heads()`: `visible` / `hidden` / `gone`) — an opened `@` goes "Diff out of date" on the next save — and both servers' `/api/diff/switch` pass jj types through `canonicalizeJjCommitDiffType` (`packages/shared/jj-core.ts`), which maps a hidden id to its change's single current version (`change_id(<change>)`; divergent or abandoned changes stay put). Refresh therefore lands on the new `@`, and the client adopts the returned commit-family `diffType` even on an in-place (`preserveFile`) refresh. The feedback export labels a jj revision by its short change id (`commitShortId` from the `commitInfo` sidecar); git keeps the 7-char sha. Client code asks one question for both families: `commitShaFromMode` / `isCommitDiffType` (`packages/review-editor/utils/`), server code `commitFamilyId` (`packages/shared/review-core.ts`). The Commits view is a self-contained detour: entering it memoizes the previously active diff, exiting to Tree restores that diff verbatim (exiting to Git status resets to `since-base` as always), the memo clears whenever any non-commit diff is applied, and a reload that serves a commit-family diff with a non-Commits panel view snaps once to the session default so the commit diff cannot outlive the visit. The toggle never writes the persisted `reviewPanelView`/`defaultDiffType` pair (no server writes from a toggle click), but it does record a cookie-only last-used memo (`reviewPanelViewLastUsed`, `sections` | `tree` — never `commits`; the Commits view is session-only). A review OPENS on caller-pinned flags (`plannotator review --base <ref>` / `--diff-type <id>`, session-only: `openStatePinned` on `/api/diff` disables the panel-pair self-heal and never persists anything) ?? session choice ?? last-used memo ?? persisted `reviewPanelView` ?? the registry default, which is **`tree`** (cookie-only, written only by Settings through `setReviewPanelView()`, which also syncs the memo so an explicit choice is never shadowed by a stale one — except the App self-heal, which passes `recordLastUsed: false` to repair the diff half of a conflicted pair without touching the memo). There is no first-run chooser: a profile with no `reviewPanelView` cookie opens on Tree, which renders every diff type, and the `Tree | Git status | Commits` toggle plus Settings → Git are the two ways to change it. The persisted pair is coupled: the Sections view only renders `since-base`, so choosing a classic diff default snaps the persisted view to Tree and vice-versa (enforced in the Settings Git tab and by the coupled setters in `packages/ui/config/reviewView.ts`); with `tree` as the default the pair is trivially consistent for a reviewer who has chosen neither, so the App self-heal only ever fires for a profile whose `reviewPanelView` cookie already reads `sections` — chosen in Settings, or seeded by a build whose registry default was still `sections`.

**Staging display invariant:** `useGitAdd`'s `stagedFiles` is the EFFECTIVE staged set (sections-sidecar snapshot + session stage/unstage overrides) and is the only source any surface may render staging state from. The sidecar entry's `staged` flag is a snapshot — ORing it back in makes files unstaged mid-session render as staged (and inverts the next toggle).

`since-base` is only offered when the base ref actually resolves — on a repo whose trunk isn't discoverable (`trunk`, no `origin/HEAD`) `getGitContext` omits it and the default falls through to `uncommitted`, so committed branch work is never silently hidden. The since-base patch/sections/fingerprint/file-content paths all degrade to `HEAD` together when merge-base fails for a resolvable-but-unrelated base. There is no first-run review-setup dialog (`ReviewSetupDialog` was removed, as `DiffTypeSetupDialog` was before it): the panel view simply defaults to Tree and the panel toggle / Settings → Git change it. The one-time dialog chain is guide intro → look-and-feel → Edit Mode → token hover cards → the terminal-tools announcement; none of the dialogs stack. The token hover announcement is last and additionally skips a session where hover cards cannot run at all (no live workspace), WITHOUT consuming its cookie, and never shows to a reviewer whose trigger is already non-default (which after the boolean-to-trigger migration is exactly the early adopter who turned cards off). Analysis layers no longer add a startup dialog: Semantic Changes retains its enabled default, while Call Flow remains disabled until the user explicitly enables it in Settings, which is also consent for its managed runtime installation.

### First-run terminal-tools announcement

A one-time panel announcing Plannotator's two terminal clients, **Plannotator
TUI** (`plannotator/plannotator-tui`) and **Herdr Annotate**
(`plannotator/herdr-annotate`). One cookie covers every surface —
`plannotator-announce-tui-herdr-seen`, value `'1'`, read and written by
`needsTerminalToolsAnnouncement()` / `markTerminalToolsAnnouncementSeen()` in
`packages/ui/utils/terminalToolsAnnouncement.ts` — so dismissing it in plan
review retires it in annotate and code review too, and vice versa. It is a
plain storage key rather than a settings-registry entry for the same reason
`lookAndFeelAnnouncement.ts` is: `configStore.ensureLoaded` seeds every
registry default into a cookie on first access, so a registry-backed flag could
never tell "never seen" from "seeded default".

The component is `packages/ui/components/TerminalToolsAnnouncementDialog.tsx`
(shared shell: portal, `z-[100]`, hand-rolled Escape + Tab wrap + focus
restore, `data-terminal-tools-announcement-dialog`). It is video first: the
real demo footage fills the top of the panel edge to edge, and the text under
it is one headline and one sentence, then one action row (star the two repos,
"Watch on X", "Got it"). There is no mock terminal, no install commands, no
feature list; the repo pages carry all of that. Two deliberate departures from
its siblings: the backdrop dismisses (the panel collects no decision, so there
is nothing to lose by closing it impatiently), and its keydown listener is
registered on the CAPTURE phase and swallows `Mod+Enter`, so a keystroke aimed
at the announcement cannot approve a plan or post a review behind it.

**Media is hosted, not bundled.** The two demos (`tui-herdr-full-demo` and
`tui-herdr-lite-demo`, mp4 + webm + poster jpg each, ~23MB together) live in
`apps/marketing/public/assets/` and are served from
`https://plannotator.ai/assets/` once the marketing deploy syncs them, the same
precedent as `GuideIntroDialog`'s hero image (the Edit Mode recording is small
enough to inline; these are not). The `<video>` is `muted playsInline loop`
with `preload="auto"`, mp4 first in source order, and `autoPlay` unless
`prefers-reduced-motion` matches, in which case the poster waits behind a
play button. A `Full | Lite` segmented switch (`role="tablist"`) swaps the
footage and the "Watch on X" link together; the panel is keyed per demo so
playback and load-failure state reset with it. If neither source can load
(offline), the frame keeps its place and shows a "Watch on X" link over it.
The panel's width follows the viewport HEIGHT as well as its width
(`min(1120px, 100%, (100dvh - 14rem) * 1280/806)`) so the video never
scrolls out of view on a short window. No CSP is involved: the app HTML ships
no `Content-Security-Policy`, and the servers only set one on sandboxed
artifact responses.

**Ordering: LAST in each app's chain, never first.** Code review gates it
through `terminalToolsAnnouncementCanShow` on guide intro, look-and-feel, Edit
Mode and token hover cards; the plan editor gates it on the
look-and-feel chooser, goal setup and permission-mode setup. The destination
spotlight and the auto-viewed toast were extended to defer behind it too, so
nothing stacks. Last rather than first because none of those dialogs consumes
this cookie: a session busy asking setup questions defers the announcement to
the next load instead of burning it, and that also puts it in front of the right
reader — someone opening Plannotator for the first time is still learning this
app, while the people who should hear that it now runs in a terminal are the
ones who already answered every setup question and see it on their next load.

Suppressed, never consumed, on: archive browsing and read-only shared plans
(which is also what the share portal serves, via `isSharedSession`), the
compact touch shell, and while the initial payload is still loading. The
guides.show portable viewer never mounts either App, so it is unaffected by
construction. `@plannotator/ui` exposes no first-run-suppression seam on
`configurePlannotatorUI`; a host that wants the announcement off installs its
own `storageBackend` (the documented escape hatch) and pre-seeds the key.

### First-run "Ask this session" announcement

A one-time panel for 0.28.0's integrated sessions: Ask AI answered by the agent session that opened
Plannotator, and reviews that no longer hold that session. Same shape as the terminal-tools
announcement above: `packages/ui/components/AskSessionAnnouncementDialog.tsx` (portal, `z-[100]`,
Escape / Tab wrap / focus restore, backdrop dismiss, capture-phase keydown that swallows
`Mod+Enter`, `data-ask-session-announcement-dialog`) and `packages/ui/utils/askSessionAnnouncement.ts`
(one plain cookie, `plannotator-announce-ask-session-seen` = `'1'`, shared by every surface; not a
settings-registry entry, for the same seeding reason).

**Who sees it:** only a plan review, annotate or code review session that is actually connected
right now: `/api/ai/capabilities` lists the session-bridge provider for `claude-code`, `pi` or
`opencode` and its status is not `gone` (`connectedAskSessionAgent`), and Ask AI is reachable on
the surface (the plan editor's `canUseAI` and not taken over by the annotate agent terminal; code
review's AI button). Everything else defers WITHOUT writing the cookie, so the reader sees it in a
session where it is true: no bridge (remote, `--tailscale`, Windows, the mod off, `-p`, Pi's
event-API path, OpenCode 1, an older CLI), a gone session, other origins, `PLANNOTATOR_AI=disabled`,
archive / shared / no-server sessions, the compact touch shell and the initial load. The headline
names the connected host and the footer always says "This session is connected"; there is no
setup variant. OpenCode's copy says "code review and annotate no longer hold the session" because
its plan review still does.

**Timing:** `useFirstRunAnnouncementWindow` (`packages/ui/hooks/`) lets it open only before the
reader's first pointer press, key press or focus into a text field, within 4 s of the initial load,
and never while a text field (a comment composer) or an iframe has focus. Work inside the raw-HTML
and live-app iframes never reaches the parent's listeners, so a window `blur` after the first
second (the viewer's own startup may focus its iframe) also closes the window. Capabilities can answer late (model
discovery), and a dialog that opened then would take focus mid-comment and be dismissed unread by
the next Space or Enter; instead it misses the load, cookie unwritten. Once open it stays until
dismissed.

**Ordering:** after the terminal-tools announcement and never on the same load
(`askSessionAnnouncementPendingThisLoad` is false while that cookie is unset), so a fresh browser
sees terminal tools first and this one on the next load; behind every chain dialog in both apps
(the permission-mode setup included). Code review's destination spotlight, auto-viewed toast and
history-shortcut guard defer behind it like they do behind terminal tools.

**Media:** real footage, hosted like the terminal-tools demos:
`apps/marketing/public/assets/ask-this-session-demo.{mp4,webm}` + `ask-this-session-poster.jpg`
(1280x800, ~35 s). Recorded from a real Claude Code 2.1.289 session (real plugin and mod, real
compiled CLI, real review app) whose model calls went to a scripted local stand-in for the
Messages API, so the question, the Read tool call and the streamed answer are real traffic with
scripted model text. Offline it says the video could not load; reduced motion waits on the poster.

### Agent tool switch: Settings row and first-run offer

The `plannotator` agent tool (off by default on Pi and OpenCode 2, on for the Claude Code mod)
has a switch in Settings → General on plan review, annotate and code review, and a one-time
offer on Pi and OpenCode 2. Both read `parseAgentToolSetting(serverConfig)`
(`packages/ui/utils/agentToolSetting.ts`): present only when the server reports
`agentToolHost` and `agentToolEnabled` (the integration that launched the server has the tool),
so OpenCode 1, Codex, the classic hook and `@plannotator/ui` hosts (which pass neither
`agentToolSetting` nor `onAgentToolChange` to `Settings`) get nothing. An OpenCode bridge
alone is not enough: the plugin also reports that its host can register the tool (a
`tool.transform` domain) as `PLANNOTATOR_OPENCODE_TOOL_CAPABLE=1` on the CLI it launches and
`opencodeToolCapable` on its in-process plan server (`agentToolHostForServer` in
`packages/server/ai-runtime.ts`), so an OpenCode host without the domain, or an older plugin,
gets no switch and no offer. The row says when a change applies: the next Pi session, the next
time Claude Code / OpenCode starts (the mod and the OpenCode plugin decide once per process).
Writes go through
`saveAgentToolSetting` (POST `/api/config` `{ agentTool }`, awaited, not the settings registry's
debounced best-effort write-back); the handlers answer 500 when the value did not reach
config.json (`agentToolSaveFailed`), and both surfaces show that. The row is locked with a note
when `agentToolEnv` is set. One `useAgentToolSetting` per App feeds both, so a change in one
shows in the other.

The offer (`AgentToolAnnouncementDialog`, `packages/ui/utils/agentToolAnnouncement.ts`, cookie
`plannotator-announce-agent-tool-seen`, a plain storage key for the registry-seeding reason)
follows the announcement shell (portal, `z-[100]`, Escape / Tab wrap / focus restore, backdrop
dismiss, capture-phase `Mod+Enter` swallow) but collects a decision. Approved design ("Loop",
`.product/approved/agent-tool-dialog/`): a theme-token SVG of the round trip over the question
"Do you use Plannotator as a skill?", two example requests, one line of why, the token cost,
and the buttons "No, I’ll just use slash commands" (initial focus) and "Yes, turn it on"; change
copy there first. The dialog cannot close while a save is in flight, a failure shows the reason
with "Try again", success says when it starts and offers Done. Declining, Escape, the backdrop
and a successful save write the cookie; a failed
save does not. It shows only for a Pi / OpenCode 2 host whose next-session value is off, never
chosen in config.json (`agentToolConfigured`), and not set by the env. Ordering: LAST in each
app's chain, after terminal tools (latched, `agentToolAnnouncementPendingThisLoad`) and after
"Ask this session" per load (`earlierAnnouncementMayShow`: that one was shown this load, or is
pending and its capabilities answer is outstanding or eligible), so never two announcements on
one load, while a reader who is never connected still gets the offer. Same deferrals as the
others (archive, shared, no server, compact, loading) and the same
`useFirstRunAnnouncementWindow`. Code review's destination spotlight, auto-viewed toast and
history-shortcut guard defer behind it.

### Review drafts and PR pushes (#1590)

Code-review drafts (`/api/draft`) are keyed by `contentHash(rawPatch)`, so a local review whose diff changes still starts without its old draft (unchanged, out of scope). **PR mode only** additionally stores the draft under a stable target key, `prDraftTargetKey(meta, scope)` = `pr-` + hash of platform + host + repo (`owner/repo` or GitLab `projectPath`, lower-cased) + PR number + diff scope (`layer` / `full-stack` are different patches). All of it lives in `packages/shared/review-draft.ts` (vendored to Pi); both review servers hold one `createReviewDraftSession()` and route `/api/draft`, `/api/feedback` and `/api/exit` through it (without a target key every call is the plain `draft.ts` call, including the historical always-`ok` save response).

- **Load** tries the patch key first and returns it unless the target copy is strictly newer by `draftGeneration`. The target copy is stamped server-side with the `patchKey` it was saved on plus `patchKeys` (every patch it was ever saved on); when served for a different patch the response carries `patchChanged: true`. Clients can forge none of these fields and never see the lists.
- **Delete** clears the patch key, the target key, and every remembered patch key, with or without a generation. A decision (`/api/feedback`, `/api/exit`) additionally clears every PR target the session saved to or restored from (an in-place `/api/pr-switch` or `/api/pr-diff-scope` moves the target, and a submit must not leave the earlier one behind); a client `DELETE` (clear-all, dismiss) touches only the target on screen.
- **Tombstones**: the target key's tombstone guards the whole logical draft — a save at or below it is rejected under BOTH keys (PR mode answers `409 { ok: false, found, draftGeneration }` instead of swallowing it), and a patch-key copy at or below it is not served.
- **In-place switches**: `/api/pr-switch` and `/api/pr-diff-scope` responses carry `draftState: { found, draftGeneration }` for the new keys. The client's `adoptDraftTarget` raises its generation to that floor (otherwise every save after switching onto a previously submitted target would be refused). When the target holds a draft, the hook loads it and AUTO-MERGES its items into the session through `onDraftTargetMerge` (skipping ids the session already holds or deleted this session; the app re-checks their anchors and shows a small non-blocking toast), then autosave saves the merge normally — no banner after a switch. The only wait: while that read is in flight, autosave skips writing under the new target (it would overwrite a draft it has not read). Each read is two attempts, each bounded by `TARGET_LOAD_TIMEOUT_MS` (5s), so a hung `GET /api/draft` fails instead of pausing autosave. If both attempts fail, the target counts as unreadable: autosave still never writes over it, and instead retries the read on each later save attempt, saving normally once a read succeeds. The next switch (or unmount) supersedes all of this, so nothing can stick. A per-switch counter makes a stale load from an earlier target a no-op. The page-load restore banner is unchanged.

Client side (`packages/review-editor`, `utils/codeAnnotationAnchor.ts`): in PR mode `withPRContext` records on each line comment `anchorText` (the anchored lines), `anchorContext` (two lines before and after on the same side plus the hunk header's function context, so a common line like `}` is not "still valid" by coincidence) and `anchorSnapshot` (the review snapshot id whose coordinates it uses). `reanchorCodeAnnotations` runs on restore (every in-scope line comment when `patchChanged`) and whenever the snapshot on screen changes: a comment whose text and context still match at the same side/lines is re-stamped; any other in-scope line comment, including one with no anchor fields, gets `outdated: true` and keeps its old line numbers (never dropped, never moved). File and general comments, and comments bound to another PR or scope, pass through. The app remembers the latest layer snapshot per PR, and `buildReviewSubmission` posts a line comment inline unless `canPostInline` refuses it: an outdated comment, or one stamped on a snapshot other than the one the page KNOWS for its PR. No evidence is not evidence of change: an unstamped comment, or one for a PR whose snapshot this page has not seen (after a reload only the PR on screen is known), posts inline. Refused comments go in the review body with the code they were written on; only a comment an anchor check marked outdated carries `OUTDATED_ANNOTATION_LABEL`. Restoring a draft whose patch changed does not restore Viewed marks on files still in the diff (`restorableViewedFiles`: the draft cannot tell which files the push touched), and every `/api/feedback` post, the platform path's status post included, carries `draftGeneration`. Outdated comments are not drawn on the diff (the review-state context filters them), show an "Outdated" chip and an Edit action in the sidebar, export under `OUTDATED_ANNOTATION_LABEL`, and a sidebar click opens their file without a scroll request.

### Image previews in code review (#1598)

A changed image whose patch chunk has no hunks (git's binary stub, our oversized stub, or a header-only GitHub/GitLab fallback chunk) renders as a Before/After preview (`packages/review-editor/components/ImageDiffPreview.tsx`) instead of the "Binary or oversized file" notice, in the single-file view and the all-files view, when the server advertises `imagePreviewSupported`. Added files show After only, deleted files Before only, identical bytes (pure rename, mode change) one pane plus "Contents unchanged"; panes stack under ~480px of width, in the compact shell, and for tall images. Cards fetch only once near the viewport (IntersectionObserver), abort on unmount, and keep a 64-entry object-URL LRU per snapshot; SVG is only ever shown through `<img src=blob:…>`. The notices stay the fallback: not an image → binary notice, an oversized stub over 10 MB → oversized notice. The all-files view takes the preview through a `renderImagePreview` render prop that only the review app's all-files panel sets, so the guide chain and the guides.show viewer keep the plain notice and never request images.

Freshness: the endpoint checks the snapshot id only, not a per-image VCS fingerprint (that probe per image would be expensive on a large PR). So for a working-tree side (uncommitted, unstaged, since-base, local-vs-remote, GitButler workspace) the After pane can show a file NEWER than the diff on screen if it changed after the snapshot; the "Diff out of date · Refresh" banner (the 5s `/api/diff/fresh` poll) covers that case, and a refresh re-binds every card to the new snapshot. Server reads run behind a 4-wide limiter that takes the request's abort signal (Bun `req.signal`, Pi the response `close`), so reads queued for cards the reviewer scrolled past are dropped before they run, and no platform API call starts for a request that is gone. The client cache holds at most 64 sides and 128 MB, never revokes an object URL a mounted `<img>` still uses, and ignores a response that arrives after the page moved to another snapshot.

Server side, every decision is in `packages/shared/review-image.ts` (vendored to Pi): eligibility via `findPatchFileEntry`, caps (`MAX_REVIEW_IMAGE_PREVIEW_BYTES` 10 MB, `MAX_REVIEW_IMAGE_PREVIEW_PIXELS` 50 MP, both in `packages/core/diff-paths.ts`), sniffing, header dimensions, error mapping and headers; both servers only say where the current mode reads a side, behind a 4-wide read limiter. Which object each side is comes from ONE table per VCS shared with hunk expansion: `resolveDiffSideSources` (git), `resolveJjSideRevs` (jj), `resolveGitButlerSideSources`; bytes come from `readDiffSideBytes` (`git cat-file --batch-check` then `cat-file blob <oid>`, never `show`; worktree reads refuse symlinks and require the realpath inside the repository toplevel) over the optional runtime methods `runGitBytes` / `readFileBytes` / `realPath` / `runJjBytes` (absent means unavailable). PR mode reads the local checkout at the fixed merge-base/head commits first and falls back to `fetchPRFileBytes` (GitHub contents API, then the blobs API for files over 1 MB after a size check; GitLab JSON files API), base64 in both cases so bytes survive the CLI's text stdout. Workspace mode delegates per child repo (`WorkspaceReviewSession.getFileBytes`). Off: static patch, P4, the guide chain and guides.show.

### Durable viewed-file progress (#1136)

Viewed marks are independent of annotation drafts and survive feedback submission,
server restarts, and reopening a review. `packages/shared/review-progress.ts` owns
fingerprinting, storage and request validation, mirrored into Pi by `vendor.sh`.
`GET/POST /api/review-progress?snapshot=<snapshotId>` loads or updates progress;
writes carry the server-issued scope key and displayed per-file fingerprints and
reject stale snapshots. The review UI restores automatically through
`useReviewProgress`; explicit viewed/unviewed mutations (including auto-view and
stage-to-view) save immediately, and pending saves flush before switches/decisions.

Storage is `${dataDir}/review-progress/{scopeHash}/{pathHash}.json`: atomic per-file
records prevent independent tabs/processes from overwriting unrelated marks.
Local Git scopes include canonical worktree root, branch and comparison selection
(base ref only for base-relative modes), never HEAD except when detached. PRs use
their URL and layer/full-stack scope. Workspace/non-Git reviews and piped patches
keep the existing draft behavior. Local Git carries a generation-time
`fileIdentities` sidecar: `--raw --patch --no-abbrev` supplies object IDs, paths and
modes without changing rendered patch bytes or existing annotation draft keys.
Bounded worktree hashes are checked against the displayed index line; no live
files are read at click time. This also covers mode-only changes and pure renames.
Files without reliable identities (including oversized untracked files) cannot
restore as viewed. Platform text patches use per-file patch hashes when full IDs
are absent; opaque binary/metadata-only patches without IDs cannot restore.
A mismatch is unviewed regardless of the auto-mark setting. Explicit unchecks
override platform seeds; in-session auto-view suppression survives content refresh.
Progress loading has explicit loading/ready/unsupported/error states: unsuccessful
loads preserve current marks and retain the legacy draft fallback, and a later
mutation or flush retries errors. Requests and the entire pre-decision/switch flush
each have a five-second limit, so stalled persistence cannot block review actions
indefinitely; a timeout warns and unsaved edits remain pending for a later retry.
Legacy draft viewed fields are ignored only on
progress-enabled surfaces (and deferred while capability detection is pending).
Purge uninstall removes `review-progress`; ordinary uninstall preserves it.
Opt-out: `PLANNOTATOR_REVIEW_PROGRESS=0` or `{ "reviewProgress": false }` (see the
environment table); the server then captures no progress snapshot and the client
falls back to draft-based viewed tracking.

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
| `mistral-vibe` | no dedicated provider; fallback to saved/server default |

Automatic resolution is session-only and never writes a preference. Explicit per-origin choices are persisted in cookies, so a user can override the automatic match for one agent without changing the default for another.

**"Ask this session" (session bridge).** A host can let Ask AI be answered by the agent session that opened Plannotator instead of a separate SDK agent. The host implements the small `SessionBridge` interface (`packages/ai/session-bridge.ts`, vendored to Pi: `host`, `status()` = `ready | busy | blocked | gone`, `modes { turn, transient }`, `ask(req, sink, signal)`, optional `interrupt()`) and passes it as `sessionBridge` to the server (`startReviewServer` / `startAnnotateServer` / plan `ServerOptions` on Bun; review, annotate and plan review on Pi), which then registers `SessionBridgeProvider` under id `session-bridge` as the ONLY Ask AI provider, behind the unchanged `/api/ai/*` endpoints: with a bridge (in-process or pull) the SDK providers go into a separate catalog-only registry (`catalogRegistry` on `createAIEndpoints`, set by `createAIRuntime` / `createPiAIRuntime`), so `/api/ai/capabilities` lists only the bridge under `providers` and makes it `defaultProvider`, and `/api/ai/session` answers `503` for any other provider id whatever the client saved. The catalog-only providers exist so the agent-job launchers (Review Agents, Code Tour, Guided Review) keep their discovered Claude / Codex model lists: `?activate=<id>` naming one runs its discovery and reports it under `catalogProviders`, which only `useModelCatalogs` reads; Ask AI never reads that field. Without a bridge (no mod, OpenCode 1, remote mode, `--tailscale`) the SDK providers register exactly as before. `/api/ai/capabilities` adds `label` ("Ask this session · Pi") and live `sessionBridge { host, status, modes }` for it, `models: []` (no model picker). The provider, not the host, enforces one question at a time across threads (`ask_in_flight`), sends no system prompt (the question carries the `SESSION_ASK_HEADER` line plus the surface), and never interrupts implicitly: a busy session answers `agent_busy`, and the client re-asks with `/api/ai/query` `busyPolicy: "wait"` ("Ask when it finishes", streams `status: waiting` until idle) or `"interrupt"` ("Interrupt and ask now", host `interrupt()` then ask). `session_gone` / `session_blocked` offer no other AI (there is none): the answer shows a plain note that the session that opened Plannotator is gone, or waiting on this decision, and Ask AI cannot reach it. Abort cancels only our question; the runtime `detach()`es the bridge before teardown so a decision/exit never stops a turn already running. **Take-over (every host):** once another message enters the turn answering our question (the person typing into the session, another extension's steer; never a background task's notification, an engine notice, a compaction, or on Claude Code a peer session's message), the rest of that turn answers THAT message, so the host stops streaming at once, keeps what it already sent, and settles with the bridge error code `taken_over` (`SessionBridgeErrorCode`; the provider maps it to `session_taken_over` with `SESSION_ASK_TAKEN_OVER_TEXT`, the neutral "Another message entered this session while it was answering, so the rest of the reply went to that message."; the Claude Code mod sends `SESSION_ASK_TAKEN_OVER_BY_PERSON_TEXT`, "You typed into this session…", when it knows the person typed it). When the answer had already finished before the other message entered (the turn's last model response stopped with no tool call: Claude `end_turn`, Pi `stop`, OpenCode `finish: "stop"` with no `session.tool.input.started` in that step, since some OpenAI-compatible providers report "stop" on a tool-calling step; and some answer text was shown), it settles `done` instead: a follow-up such as Plannotator's own decision never turns a complete answer into a cut one. From then on neither a Stop nor "Interrupt and ask now" stops that turn: Stop only closes the question, and `interrupt()` refuses (`SESSION_ASK_TAKEN_OVER_INTERRUPT_TEXT`) while the taken-over run lasts. The client (`useAIChat`) treats `session_taken_over` as a note, not an error: the partial answer stays and `SessionAskNote` renders the text under it (`response.notice`). Per host: Claude Code mod, `prompt.submit` with the question turn's `turnId` from an allowlisted origin (see "Claude Code mod"); Pi, a `user` message, or a custom message other than ours delivered right after a `turn_start` (a steer or follow-up), in the run answering our question; a non-triggering display-only custom message (e.g. `plannotator-handoff`) is appended at `turn_end`, outside that window, and takes nothing over; the run stays protected until `agent_settled` (idle on Pi without it), so an error retry of the person's run is covered; OpenCode 2, a `session.inbox.delivered` for another row whose kind, read from `session.inbox.enqueued` (`item.type`), is `user` (synthetic, compaction, move and unseen rows never take over), after ours was delivered AND the model began answering (`session.step.started` or any answer output), so a command's session-URL notice promoted in the same batch as the question is not a take-over. **Older servers:** the pull server advertises the codes it knows as `features` on every poll answer (`SESSION_BRIDGE_POLL_FEATURES`, today `["taken_over"]`). A pull host (the mod's `bridge.ts`, `runPullSessionBridgeClient`) talking to a server without `taken_over` settles a take-over as `done` with the partial answer plus the note as its last paragraph (`takenOverFallback`), because an older server reads the unknown code as `failed` and its UI would replace the partial answer with the error. Client (`resolveAIProviderSelection`): a bridge in the list is the selection in every status, ahead of any saved pick; without one the order is unchanged. The saved provider cookies are never rewritten for this, so a pick still applies to sessions without a bridge; with a bridge the Ask AI bars and Settings → AI show only its label (no provider or model picker). Code review sends the diff's identity (`buildSessionReviewIdentity`), never the patch. **Draft annotations (#1748):** the session is the agent the feedback is FOR, so the reviewer's unsubmitted annotations never reach it as feedback. `/api/ai/query` ignores `contextUpdate` (the feedback export a separate AI still gets on every question after the first) for a bridge session; the plan/annotate editor instead sends `draftAnnotations`, a plain one-line-per-draft list (`formatDraftAnnotationsForAsk` in `packages/ui/utils/parser.ts`: `Draft 2 (line 14): comment on "…" — …`, no export title, no "pieces of feedback", no "Feedback on" headings, no skill injection), which `useAIChat` sends only when it differs from what the agent session last RECEIVED (`draftAnnotationsToSend`; recorded once the stream shows delivery, so a busy or gone ask resends it; kept per page, not per Ask AI session, because a new thread or a document switch is a new Ask AI session on the same agent session), and `''` once when every draft was removed. A string in the list that reads like the end marker (any case or spacing) is neutralized, so a draft or page text cannot close the frame early. `formatSessionAskText` frames it between the surface and the question with `SESSION_ASK_DRAFTS_LABEL` ("…Do not act on them; the reviewer will send them when ready…") and `SESSION_ASK_DRAFTS_END` (or `SESSION_ASK_DRAFTS_CLEARED`), in turn and transient mode alike; the system prompt is untouched. The annotate agent terminal's Ask prompt uses the same list and frame (`buildTerminalAskPrompt`, deduplicated per terminal session). Code review sends no annotations to Ask AI at all. **Pi** (`apps/pi-extension/pi-session-bridge.ts`): review, annotate, last and plan review (plan review no longer blocks the session, see "Pi plan review does not block" below), off in remote mode; the question is a `pi.sendMessage({ customType: "plannotator-ask", display: true, details: { askId } }, { triggerTurn: true })` turn read back from `message_start` / `message_update` text deltas / `tool_execution_start` / `agent_end`; listeners register once at load because `pi.on` returns no unsubscribe before Pi 1.0. **OpenCode 2** (`apps/opencode-plugin/opencode-session-bridge.ts`): review, annotate and last ask a real turn — `ctx.session.prompt({ id, text, delivery: "steer", metadata: { source: "plannotator-ask" } })` under a message id generated in OpenCode's own ascending `msg_` format, streamed back from `ctx.event.subscribe()` (`session.inbox.delivered` with our id starts the answer, then `session.text.delta` / `text.ended` / `tool.input.started`, ended by `session.execution.succeeded|failed|interrupted`), with `session.wait` + `session.context` as the fallback when the event stream is missing (upstream #44788). Delivery is "steer", not "queue", on purpose: every V2 command leaves its session-URL notice as a pending steer row, and a queued question would wake the session with that notice promoted alone as its own model turn (seen live on 2.0.22). Busy comes from the execution events cross-checked by a single outstanding `session.wait` probe; abort and "Interrupt and ask now" use `session.interrupt` (whole execution), only on a turn that is ours or on the reviewer's explicit choice. Plan review answers from context only ("Quick answer from this session · OpenCode", `modes { turn: false, transient: true }`): `submit_plan` is a pending tool call, so a real turn cannot run until the decision (a prompt sent then waits for the tool result, verified live), and `markPlanReviewPending` makes EVERY bridge on that session report `blocked` so nothing can interrupt the review. The quick answer is `session.generate` (no transcript write; verified live on 2.0.22 with OpenAI during a pending `submit_plan`, and `@opencode/ai`'s `normalizeToolHistory` fills the unfinished call with an error result for every provider); it still offers the model its tools, so the question carries `SESSION_ASK_TRANSIENT_NOTE` and an empty answer (a tool call) is reported as a failure. The embedded plan server takes the bridge in-process; review/annotate/last and the CLI plan fallback run the `plannotator` CLI as a child and use the pull bridge below. **OpenCode 1** has no bridge (a second adapter over V1's different message/event model, not a small lift). **Claude Code** answers through its mod over the pull bridge below (review, annotate, last and plan review, all real turns; see "Claude Code mod"); without the mod Claude Code has no bridge.

**Pull bridge (host-neutral, `packages/ai/session-bridge-pull.ts` server half, vendored to Pi; `session-bridge-pull-client.ts` host half).** For a host that runs the Plannotator server as a SEPARATE process and must not open a listener of its own (the OpenCode plugin's CLI child and the Claude Code mod). The host generates a per-launch secret and starts the server with `PLANNOTATOR_SESSION_BRIDGE_TOKEN` (>= 32 chars), `PLANNOTATOR_SESSION_BRIDGE_HOST` (`opencode` / `claude-code` / `pi`) and optional `PLANNOTATOR_SESSION_BRIDGE_MODES` (`turn,transient`; default `turn`). The Bun CLI takes that config at its very first line (`takeEnvPullSessionBridgeConfig`, cached once per process; `createAIRuntime` reads the cache) and deletes the three variables, so nothing it spawns (git/gh before the server starts, agent jobs, terminals, the auto-update wrapper) inherits the token; `--tailscale` discards it outright (`discardEnvPullSessionBridgeConfig`). The runtime registers the same `SessionBridgeProvider` over it; it is off in remote mode and under `--tailscale` (and an in-process bridge wins). Pi's `createPiAIRuntime` accepts the same config as its `pullSessionBridge` option (no env takeover: Pi itself always bridges in-process). The host learns the port (OpenCode: `PLANNOTATOR_READY_FILE`) and then talks to two endpoints on `http://127.0.0.1:<port>`, both `POST` + JSON with `Authorization: Bearer <token>`: `/api/ai/bridge/poll` `{ status?, modes?, waitMs? }` long-polls (clamped to 25s; answers early when there is work) and returns `{ commands, closing?, superseded? }`, commands being `{ type: "ask", askId, text, mode }`, `{ type: "cancel", askId }` and `{ type: "interrupt", interruptId }`; `/api/ai/bridge/event` takes one event or `{ events: [...] }` — `started`, `delta`, `tool`, `done`, `error` (per question, `code` one of `busy|blocked|gone|aborted|failed|taken_over`; anything else reads as `failed`); every poll answer also carries `features` (optional protocol features the server knows, `SESSION_BRIDGE_POLL_FEATURES`), `status`, and `interrupted { interruptId, ok, message? }` — and answers `409 { code: "ask_not_active" }` for a question that is no longer running, which tells the host to stop it. Commands are re-sent every ~5s until acknowledged (any event for that question; `interrupted` for an interrupt), so hosts dedupe by id. Guards, in order: a loopback Host with the server's own port (the runtime's `authorizeSessionBridgeRequest`, `403 session_bridge_forbidden_host`), no `Origin` header (`403`, a browser is never the host), the bearer token (`401`); without a pull bridge both paths answer `404`, which an older-binary-aware host treats as "no bridge". Liveness: until the host's first request the bridge reports `ready` (a question waits for the first poll); no first request within 30s, or 30s with no open poll after that, is `gone`, and a running question then fails `session_gone`. The newest poll supersedes an open one. A reviewer's Stop drops a question the host never confirmed, else queues `cancel` and frees the slot when the host confirms (or after 15s); `detach()` (decision / shutdown) drops only unconfirmed questions, and `dispose()` answers the open poll `closing`. Both runtimes route the two paths through `createAIEndpoints` (`pullBridge` dep), and Bun lifts the idle timeout for the poll (`isLongLivedAIEndpointPath`). Tests: `packages/ai/session-bridge-pull.test.ts` (fake host over the real client: streaming, early question, busy wait / interrupt, abort before and after pickup, host disappears, never connects, transient, bad token / Origin / rebinding Host, supersede, dispose, detach), `packages/server/ai-runtime.sessionBridge.test.ts` (env takeover, scrub, remote-off), `apps/opencode-plugin/session-bridge-cli.test.ts` (plugin ↔ CLI child end to end).

**Model lists come from the installed tools, not hand lists.** Claude's list is the SDK's `supportedModels()` against the installed `claude` (a throwaway process with no prompt, `settingSources: []` so no user hooks run, no MCP servers, 10s cap, ~0.5s measured); Codex's is the app-server `model/list`. Both run lazily behind the provider initializer (`?activate=` or the first session), never at startup; a success is kept for the process, a failure may be retried after 60s (`createBestEffortOnce`), and the capabilities answer marks each such provider's list `modelsSource: 'fallback' | 'discovered'` so the client forgets a fallback answer and retries on its next load. The same discovery captures the tool version once (`claude --version` run alongside it; codex from the app-server initialize `userAgent`, via `cliVersionFrom`), kept even when discovery fails, and the answer carries it as an optional `toolVersion`; every Claude/Codex model picker (Agents tab launchers, Guided Review, Ask AI bars, Settings) shows a muted `ModelSourceHint` line ("From your installed Codex 0.155.1", or the built-in-list variant on `fallback`) only when `toolVersion` is present, so a host that omits it gets no hint. Both runtimes share `createDeferredModelDiscovery`: an `?activate=` probe waits for discovery, and so does a session for every provider except Claude, whose sessions resolve the model against the current list while discovery finishes in the background, so the first Ask AI answer does not wait on it — except when that list is still the fallback and lacks the requested pick (e.g. `opus[1m]`), where the session waits for discovery rather than silently running a different model once. One shape, `CatalogModel` in `packages/core/model-catalog.ts` (id, label, efforts + default effort, fast mode, `resolvedId`), serves Ask AI AND the review / Code Tour / Guided Review launchers: `useModelCatalogs` (`packages/ui/hooks/`) fetches the same `/api/ai/capabilities?activate=` answer for the ONE engine a launcher is set to, and `useAgentSettings` resolves saved picks against it at read time (the cookie is never rewritten). ONE resolver, `resolveModelChoice`, is used by the launchers, Ask AI's client (`aiProvider.ts`) and the AI session endpoint: exact id → the alias whose `resolvedId` covers it → the same family's alias (`claude-opus-5` → `opus`) → the surface default (Claude `opus` for review, `sonnet` for tour/guide; Codex `''` = the model the Codex list marks default, except Guided Review, which prefers `gpt-6-luna` when offered: `PREFERRED_GUIDE_CODEX_MODEL`) → the catalog default; it never moves a pick onto a `[1m]` id unless the pick was one. Efforts clamp to the model's own levels, launches wait until the catalog settles, and a loading row shows meanwhile. The Claude catalog drops the SDK's `default` pointer row and adds a bare latest alias per family offered, and always offers `opus` / `sonnet` / `haiku` (some CLIs, e.g. Claude Code 2.1.141, name Opus only through the `default` row, whose description then supplies the version); alias labels carry the version parsed from the row's `resolvedModel` (`claudeModelVersion`: "Opus 5.5 (latest)"), since the SDK's `displayName` has none. Codex fast mode is dropped when resolution replaces a saved model with a different one; changing Fast or reasoning then re-keys the section to the model shown. Codex fast support is read from `serviceTiers` (a `priority`/`fast` tier) as well as the deprecated `additionalSpeedTiers`. The only static lists are the small `CLAUDE_FALLBACK_MODELS` / `CODEX_FALLBACK_MODELS`, used when discovery fails.

> **Codex transport note:** the `codex-sdk` provider id is a stable identifier only — it no longer uses `@openai/codex-sdk` / `codex exec`. It drives a long-lived `codex app-server` process over JSON-RPC (`packages/ai/providers/codex-app-server.ts`), which respects the user's/enterprise-managed approval policy and supports interactive Allow/Deny approvals. The id stays `codex-sdk` to preserve saved cookie preferences, the `agents.ts` mapping, and the UI reasoning-effort gate.

> **OpenCode transport note:** the `opencode-sdk` provider spawns its own `opencode serve` per process on an OS-assigned port (`port: 0`) and never attaches to a server it did not spawn (an attached server can't be cleaned up by us, and opencode's per-directory instances accumulate in it without eviction). The spawned server is closed on dispose and on process exit. Model discovery is deferred behind the provider initializer (`?activate=` from the model picker, or the first opencode session) exactly like Codex — nothing spawns at server boot, so the picker lists opencode with an empty model list until first activation. Regression-pinned by `packages/ai/providers/opencode-sdk.test.ts`.

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
  .mmd/.mermaid → file read, rendered as ONE Mermaid diagram in the full
             diagram viewer (see "Diagram files" below) — not as text
  .dot/.gv   → same, through the Graphviz engine
  .html/.htm → file read, rendered as raw HTML by default (or converted to markdown with --markdown)
  https://   → fetched via Jina Reader (default) or fetch+Turndown (--no-jina)
  http://localhost:* (also 127.x and [::1])
             → LIVE app annotation by default when a quick probe returns HTML:
               the running app is mirrored through a loopback reverse proxy and
               annotated in place (see "Live app annotation" below). --static
               forces the classic conversion pipeline; --app forces live mode
               and fails loudly when it cannot apply.
  folder/    → file browser opened, files converted on demand
  a.md b.html c.md (several existing file paths)
             → ONE review of all of them, in that order (mode
               "annotate-bundle"; see "Several files in one review" below)
        ↓
Annotate server starts (reuses plan editor HTML with mode:"annotate")
        ↓
User annotates content, provides feedback
        ↓
Send Feedback → annotations sent to agent session
Done / Approve (gate) → positive decision recorded (see the decision control below)
```

### Annotate header decision control

Every annotate surface's header decision is one adaptive split control, `DecisionControl`
(`packages/ui/components/DecisionControl.tsx`), rendered from the pure `buildDecisionSpec`
state→spec mapping (`packages/ui/utils/decisionSpec.ts`) beside a ghost-X Close: `Done` (or
`Approve` in gate mode) with nothing to send, `Send Feedback` otherwise, with the alternate
decisions and the in-place note composer behind the caret. One `submitPrimaryDecision()` callback
serves the header primary, the global `Mod+Enter` handler, and the compact primary row, so
keyboard and header can never disagree. Transport routing is pure in
`packages/editor/annotateDecision.ts`: `Done` and every note post `/api/feedback` (a note becomes
a `GLOBAL_COMMENT` at submit time with a one-render deferred submit — zero server change), so
`formatAnnotateOutcome` shapes and strict-gate exit codes are byte-identical to the old
keyboard-only zero submit; only gate-mode approvals reach `/api/approve`. The non-gated empty
menu carries a single composer, "Send a note…" (maintainer ruling: the old "Done with a note…" /
"Request changes…" pair differed only by framing on the same transport and was collapsed into
one item); the approval-framing sentence (`buildCompleteAnnotateFeedback`'s `approvalFraming`)
now serves only the non-gated discard path, and the only confirm left is the
explicit `Done/Approve, discard n annotations…` menu item (plus the pre-existing
close-with-content warning). Compact/touch rows are generated from the same spec, so a visible
positive decision exists in every state; composer rows open `DecisionNoteDialog`. The header flip
predicate is `hasFeedbackToSend`, so feedback already delivered through the agent terminal shows
the positive primary rather than a stale Send Feedback.

The approve-carrying gate items (`Approve with a note…`, `Approve with notes`) follow the
`approvalNotesSupported` advert on `/api/plan`, the same on markdown, raw-HTML and live-app
surfaces. The Bun CLI sets it with `supportsAnnotateApprovalNotes` = `--gate` and not `--hook`
(`apps/hook/server/annotate-output.ts`): `--json` carries the note as `feedback`, plaintext prints
the configured `approvedWithNotes` prompt instead of `The user approved.` (a bare approval keeps
that line byte for byte), and the Claude Code mod's plaintext `--gate` launches deliver it from the
result file as an approved-with-notes turn. `--hook` has no message on approval, so the items stay
hidden there. Pi and OpenCode advertise it from their own servers. Non-gated annotate has no
approve channel: its only composer is "Send a note…" (feedback).

### Annotate Options menu and Settings parity

Annotate renders the same document app as plan review, so its Options menu and
Settings dialog match plan review item for item; only rows that describe a PLAN
decision stay plan-only. Settings `mode="annotate"` shows General, Theme,
Display (width reads "Document Width"), Saving, Labels, Vim, Shortcuts, Files,
Obsidian, Bear and Octarine — gated on the optional `annotateParity` prop,
which `AppHeader` passes and a `@plannotator/ui` host that omits it does not
(hosts keep the pre-parity annotate tab set; see `packages/ui/HANDOFF.md`).
The notes-app enable switches are the SAME cookies plan review's approve reads
(`body.obsidian`/`bear`/`octarine`), so enabling one from annotate also makes
plan review save every approved plan there; the annotate description says so
explicitly. Plan-only, and hidden in annotate: the **Hooks**
tab (plan-time hooks; `/api/hooks/status` exists only on the plan server),
**Save Plans** (decision snapshots in `plans/` are written on approve/deny),
the three **Auto-save on Plan Arrival** switches (the arrival auto-save effect
is gated `!annotateMode`), **Permission Mode**, and OpenCode **Agent
Switching** (annotate decisions never send `agentSwitch`). The Archive sidebar
tab stays plan-only too (the annotate server has no `/api/archive/*`).

**Agent Instructions** (Options menu) is offered in every annotate session.
`buildAnnotateAgentInstructions(origin, surface)`
(`packages/ui/utils/annotateAgentInstructions.ts`) is the annotate twin of
`buildPlanAgentInstructions` (plan text is unchanged): same endpoint and
plan-mode validator, "document" not "plan", no deny/resubmit loop, and one
section per surface picked by `resolveAnnotateInstructionsSurface` — its own
read command (`.plan`; `.rawHtml` for raw HTML; `.targetUrl` for a live app;
`/api/doc?path=<p>&doc=1 | jq -r '.markdown // .rawHtml'` for a folder, so
HTML and data files print too) plus the targeting rules the validator actually
supports: `diagramAnchor` on POST for diagram files, `htmlAnchor` by PATCH
only (POST drops it), `pageUrl` by PATCH for live-app routes. Folder sessions
are stated plainly: an external comment cannot target a document; it lists in
the panel whichever document is open, is not highlighted inline, and rides the
submitted feedback. Not done yet: POST accepting `htmlAnchor`, and a `path`
field so a folder-session external comment targets one document.
`packages/server/annotate-agent-instructions.test.ts`
executes every curl/JSON example in the text against a real annotate server,
so an instruction that drifts from the server fails there.

Save to Obsidian / Bear / Octarine menu items are hidden (a `Mod+S` quick save
toasts instead) when the session has no document text (`notesSaveAvailable`: raw-HTML, live-app, a
folder with no file open) — the server skips an empty `plan`, so those items
were silent no-ops.

### Tolerant argument resolution

Slash-command hosts forward raw user words to `plannotator annotate` verbatim (on Claude Code through a bash-substitution prefix that runs before the model sees anything), so non-strict invocations resolve their arguments in three tiers. The shared logic lives in `packages/shared/annotate-target.ts` (vendored to Pi) and is wired into the CLI's annotate branch plus the OpenCode and Pi command parsers:

1. A single-token invocation runs the classic pipeline unchanged: a bare correct path behaves exactly as before, and a lone typo'd path still fails with `File not found` and exit `1`.
2. With several tokens, each token is probed; exactly one naming an existing file, URL, or folder proceeds with it (`annotate look at notes.md please` opens `notes.md`). **Bundle rule (0.29), checked first:** when EVERY token is an existing regular file named by its path (resolved from the cwd, `~` or an `@` prefix; `probeAnnotateBundlePath`, never a name found only by searching the project, never a URL or folder), they open as one review in the typed order with duplicates dropped (`selectAnnotateTokenTarget(..., { bundlePath })` → `{ kind: "bundle" }`; the same file twice is `single`, on every host); an existing file of an unsupported type or over the 2MB cap among them fails naming it (`resolveAnnotateBundleFiles`; a `.env` is named as refused). When every token READS as a file path (`looksLikeFilePath` from the tool contract: a separator, a leading `~` `.` `@`, or an extension) but some name nothing at all (nothing exists at the path, `annotatePathExists`, and nothing is found by search), the selection is `{ kind: "missing" }` and the host fails naming them (`buildMissingAnnotateFilesMessage`, exit 1, or 2 under a strict gate): an explicit list of files with a typo never narrows to the files that exist. An existing path is never missing, so a stray `.` or `..` beside a file still opens the file and an existing folder keeps the ambiguity error. Known edge: a dotted word such as `Node.js` or `v2.0` reads as a file path, so `annotate notes.md about Node.js` is prose (fast path) but `annotate notes.md Node.js` fails naming `Node.js` when no such file exists. Otherwise two or more resolving tokens (prose around them, a URL or folder among them, a searched name) error naming every candidate rather than guessing, and the error gains one hint line, `ANNOTATE_BUNDLE_HINT` ("To review several files together, pass only their paths: plannotator annotate a.md b.html"), on hosts that open bundles. A host that cannot open bundles passes no `bundlePath` and keeps the #1182 tiers exactly. Bare directory names only count as targets when they are the sole argument, so a stray word matching a directory (or `.`) cannot hijack the fast path; unrecognized dash-prefixed tokens disable the tolerance entirely so a typo'd flag (`--no-jna`) errors the way it always did instead of being silently skipped.
3. When nothing resolves, the CLI emits an agent-addressed handoff that echoes the words tried and asks the reading agent to re-run with a concrete target (content flags such as `--markdown` / `--no-jina` / `--render-html` are echoed for the re-run; transport flags are not). In plain mode the handoff goes to **stdout with exit `0`**, because a non-zero exit from a Claude Code bang-prefix skill aborts the prompt before the model sees any output; with `--json` / `--hook` it goes to stderr with exit `1` so machine-readable stdout stays reserved for decision records. OpenCode and Pi surface the same message as a host notification.

Strict invocations (`--require-approval` / `--result-file`) bypass all three tiers: `args[1]` is the target and a typo'd path stays a startup failure with exit `2`. With several arguments, a strict gate takes only the bundle rule: several existing file paths make one review (approve covers every file); anything else exits `2` ("File not found: <first>" when the first argument names nothing, else "A strict annotate gate takes one target, or only existing file paths…"), where extra words used to be silently ignored. The refusal is decided by probe and stat only: nothing is fetched, probed live, or reported as resolved first.

### Several files in one review (annotate bundles)

`plannotator annotate spec.md mock.html notes.md`, the `plannotator` tool's `target: [...]`, a taken-over Bash command with several file paths, and `/plannotator-annotate a.md b.md` on Pi and OpenCode (embedded and CLI-bridge) open ONE review of the listed files, in the given order, with ONE decision (owner decisions: no flag, no file-count limit, per-file decisions later). Design: `.product/drafts/agent-sessions-0.29/DESIGN.md` section A.

- **Server mode `annotate-bundle`** in both runtimes (`packages/server/annotate.ts`, mirrored in `apps/pi-extension/server/serverAnnotate.ts`): options `bundleFiles: AnnotateBundleFile[]` (`{ path, renderAs }`, from `packages/shared/annotate-bundle.ts`, deliberately not in `@plannotator/core` so the published core export map is unchanged; two or more or the server throws) and `filePath` = the bundle root (`annotateBundleRoot`, the deepest directory holding every file, compared by path segment). `/api/plan` adds `bundle` (the list, in order) and `projectRoot` = the bundle root. `/api/doc` serves the files and what they link to under the single-file rule: reference roots are the cwd plus each file's own directory, and for a symlinked file also its target's whole directory, as a single-file session on that path would (`bundlePaths` on `getAnnotateReferenceRootPaths`), so a document beside a bundle file opens as a linked document exactly as from that file alone, and anything outside is `403`. The editor never walks the bundle root. Each text file's version history is saved when the review opens (the folder pipeline's per-file memo, run eagerly; raw HTML keeps none, as in folders), and `/api/doc` returns its version fields. Source save (Edit Mode writes) is off in bundles.
- **Drafts:** the session draft is keyed by the ordered list (`bundle:\0<paths>`), and every file's comments are also saved under that file's path key (#1710's document copies), so they follow the file into a single-file, folder or other bundle session. Host status `documents` lists the files.
- **Decision record:** the host result record (`PLANNOTATOR_HOST_RESULT_FILE`) and the feedback archive gain `documents: [{ path, annotationCount }]` in bundle order (`annotateBundleDocumentCounts`, counted from each submitted annotation's `documentPath`). The archive record's surface is `annotate-bundle` with `target.documents` and no `filePath`. The agent message frames the feedback with `Files: <path>, <path>` (`annotateBundleTargetText`) on every host.
- **Editor** (`packages/editor/App.tsx`): a folder session (`annotateSource` stays `'folder'`) with `bundleFiles` state. The first file opens by itself; the header's `BundleSwitcher` (`packages/editor/components/BundleSwitcher.tsx`, "2 of 3 · mock.html ‹ ›", desktop; the compact shell names the position in its title and offers Previous/Next file in its Options menu) and the Files tab follow the given order: the tab shows the bundle as a synthetic, never-fetched file-browser section (`bundleDirState`, merged into `navigatorFileBrowser` beside any configured directories; the filesystem root is the empty dir path so `${dir}/${node}` stays absolute). A link from one bundle file to another opens it as that bundle file. A bundle file has no Close pill, no sidebar "Back to…" and no HTML header Back (the switcher moves between the files); a document a bundle file links to goes back to the last bundle file shown (`bundleBackPath`, the first file before any), never to the folder's empty "choose a file" state (`DocBadges`' `onBack` is optional for the `folder-file` variant). The export lists one section per file in bundle order under `BUNDLE_DOC_EXPORT_HEADING` ("File Feedback"; `resolveFeedbackSections({ bundleOrder })`, unlisted linked documents after), the All files panel follows the same order (`groupAnnotationsByDocument`'s `order`), and Ask AI's context carries `bundlePosition`, so the session-bridge surface line reads "annotating /…/mock.html, file 2 of 3".
- **Version skew:** an older CLI answers several paths with the ambiguity error lacking `ANNOTATE_BUNDLE_HINT`; the Claude Code mod and the OpenCode CLI bridge recognize that (`isOlderCliBundleRefusal`) and say to update Plannotator to open several files at once. An older host never sends a list.

Tests: the selection table in `packages/shared/annotate-target.test.ts`; `packages/server/annotate-bundle.scenarios.ts` (both runtimes); `apps/hook/server/annotate-bundle-cli.test.ts` (the CLI as a process: order, one decision, the host record's `documents`, strict gates, the hint); `packages/shared/annotate-bundle.test.ts`; the mod's `controller.test.ts` and `plannotator-tool*.test.ts`; OpenCode `commands.test.ts` and `cli-bridge.test.ts`; and the DOM test `packages/editor/App.bundle.test.tsx` (first file opens, switcher and file list in order, one section per file in bundle order).

The bang prefix in the Claude Code skill is deliberate: #872 (commit `aac5aacb`, "restore `/plannotator-*` bash execution on Claude Code") put it back so the slash command never depends on the model choosing to run the binary. Argument-shape problems belong here in the CLI's resolution, not in the skill templates.

Hosts that run the CLI as a child must hand it the words as SEPARATE arguments, or none of this runs: one argument is one path to the CLI (`annotate ". notes.md"` is "File not found"). The OpenCode CLI bridge (OpenCode 2 native commands and the OpenCode 1 CLI runtime) does this with `annotateCliTargets` (`apps/opencode-plugin/cli-bridge.ts`) over the shared `annotateTargetWords` (`packages/shared/annotate-args.ts`: quotes group a path with spaces only when they open and close a word, so prose apostrophes stay in their words; an unterminated quote is prose, backslashes are kept, known flags are dropped). It keeps ONE argument, exactly as before, when the whole input names an existing target (an unquoted path with spaces), for a single word, and when a word starts with `-` (a typo'd or prose flag must never reach the CLI as a real one). The `plannotator` tool's single target is never re-split. `apps/opencode-plugin/annotate-words-cli.test.ts` runs the REAL CLI for this. An OpenCode 2 slash command that fails (a refused argument or the CLI's startup error) posts a transcript notice, `Plannotator /plannotator-annotate failed: <reason>` (`createCommandFailureNotifier` in `v2-client.ts`: `session.synthetic` with a description and `resume: false`, so no model turn; the context hook drops it from model requests like the session-URL notice, matching only a `text` that ends with the marker `commandFailureNoticeText` adds and the visible `description` lacks, so a copy of the line the person types or pastes is never dropped); the OpenCode 1 CLI runtime shows an error toast. Before this the failure only reached the log, which OpenCode 2 discards. Tool launches report failures as the tool result instead.

### Annotate drafts follow the file

Annotate drafts used to be keyed only by a hash of the document text, so an agent edit plus a reopen lost the reviewer's unsent comments. `packages/shared/annotate-draft.ts` (vendored to Pi; both servers route `/api/draft` and `/api/draft/document` through `createAnnotateDraftSession`) applies the #1590 pattern:

- **Single local file** (mode `annotate`, not a URL): the draft is also saved under `annotateFileDraftKey(<abs path>)`, reusing `review-draft.ts`'s dual-key logic with the content key as the "patch" key. Load prefers the content copy unless the path copy is strictly newer by `draftGeneration`; the path copy remembers every content key it was saved on (`patchKeys`, server-stamped, stripped from client bodies and from load responses); its tombstone guards both keys. Restored comments re-anchor by text and one whose text is gone shows the existing Unanchored chip and still exports, with no line label. Because block ids are positional, the highlighter's restore report lists under `moved` every comment whose stored `blockId` no longer holds its text (the block its highlight landed in, or `''` when the text is gone, which is also reported unanchored whether or not stored positions existed), and App writes that back (`applyRestoredAnchors`, `packages/editor/restoredAnchors.ts`), so export line labels name the lines the text is on now; an unchanged document reports nothing and exports byte-identically. Only rows that own a text highlight go through that restore (`annotationOwnsHighlight`, `packages/ui/utils/annotationOwnsHighlight.ts`: not diff-view comments with their `diff-block-N` ids, general comments, checkbox toggles or question answers); every re-apply caller (draft restore, `useLinkedDoc`'s back/re-open, per-document copies) filters with it, and the highlighter and `applyRestoredAnchors` skip the same rows, so a diff-view comment's `blockId` is never rewritten. Behavior change worth a release note: any restored comment the restore cannot paint now shows the Unanchored chip, not only one whose stored positions landed on other text, so comments with no stored positions (share-link imports, external/SSE comments, Edit Mode repaints) are chipped when their quote is not in the document. A save refused as stale (another session on the same file decided or saved ahead) answers `409 { ok: false, error, found, draftGeneration }`; `DraftTransport.save` may resolve `{ staleGeneration }` and the hook raises its counter above it and saves once more, so the reviewer's comments are not silently left unsaved.
- **Per-document copies:** every document a local-file or folder session holds comments on, other than the session's own root, is saved under that document's path key by the client hook `packages/editor/hooks/useDocumentDrafts.ts` (pure planning in `packages/editor/documentDrafts.ts`), and merged in the first time the document opens in a session (ids already held are skipped; a toast says how many came back). So a file's comments follow it between a folder session and a session on the file alone. These writes are generation-stamped by the server (one above whatever the key has seen), so a single-file session that later loads the copy resumes above it. A document is written only after its copy was read, and sent empty only when it was sent with content before. With per-document copies on, the session draft carries the ROOT document's comments even while another document is open (`composeSessionDraft` in `documentDrafts.ts`), plus every document the server keeps no copy for: one it refuses (`400`/`403`: outside the session's roots such as an Obsidian vault document, a symlink alias of the root, not a regular file) and a copy of the root opened through a self-link, so those stay crash-recoverable as before. Paths are canonicalized with `realpath` and must name an existing regular file (`canonicalDocumentPath`), so an alias shares its target's key.
- **Clearing:** a decision (`/api/feedback`, `/api/approve`, and the reviewer's Close `/api/exit`, which deleted the draft before this too) clears the session's keys and the path copy of every document the session wrote or restored from, then refuses session-draft saves (`409 { decided: true }`, even above the tombstone, so a second tab cannot put back comments that were just sent; never retried by the client) and document writes (`409`). A client DELETE (everything removed, banner dismissed) clears only the session draft's keys. The client-lease auto-dismiss keeps everything, as before. An agent close (`POST /api/host/close`, `closedBy: "agent"`) is the other exception: it KEEPS the session draft, its path copy and every document copy (`closeKeepingDraft`), so they come back when the file is reopened, even after an edit. Saves and document writes that arrive after it still land (the tab also flushes its pending debounced saves when the session-closed event arrives, `flushPendingSave` / `flushPendingWrite`), so a comment typed just before the close is kept; only the closed tab's DELETE is ignored. The closed-tab copy (`packages/ui/utils/agentClosed.ts`) says per case what brings the draft back: a local file or folder even after edits, a URL or agent message only unchanged, a live app by its address. The host status/close `unsentAnnotations` count is the session draft the session would restore plus every document copy it covered (`countUnsent`).
- **Scope:** URL, live-app and annotate-last sessions have no path key and no document copies. Drafts are crash recovery, not history, so `PLANNOTATOR_ANNOTATE_HISTORY` does not govern them. Known edges: two open sessions on the same file write the same path key and the last save wins; the key is the file's path only, so a raw-HTML session and a `--markdown` session on the same `.html` share one copy (raw-HTML pinpoints restored into the converted view, or the other way round, show as Unanchored); and the key follows the path's spelling after `realpath`, so a file reached through a hard link or a different mount is a different key.

Tests: `packages/server/annotate-draft.scenarios.ts` (run against both runtimes by `packages/server/annotate-draft.test.ts` and `apps/pi-extension/server/serverAnnotate-drafts.test.ts`), `packages/editor/documentDrafts.test.ts`, `packages/editor/restoredAnchors.test.ts`, and the DOM tests `packages/editor/App.documentDrafts.test.tsx`, `packages/editor/annotationDraftStaleRetry.test.tsx` (the 409 retry against real draft sessions), `packages/editor/App.restoreAcrossEdit.test.tsx` (line labels and chips after a restore across an edit), `packages/ui/components/Viewer.restoreMovedAnchors.test.tsx` and `packages/ui/hooks/useLinkedDoc.reapplyFilter.test.tsx`.

### Strict direct annotate results

Direct `plannotator annotate` invocations may add `--require-approval` and/or `--result-file <path>` only with `--gate --json`; both reject `--hook` and are not shared with OpenCode/Pi slash-command parsing. When neither strict option is present, single-target invocations keep the legacy plaintext, JSON, hook, and exit behavior unchanged, with one plaintext exception and three additive JSON fields. The plaintext exception: a gated approval that carries a note (**Approve with a note…** / **Approve with notes**, offered by every `--gate` session except `--hook`) prints the configured `approvedWithNotes` prompt, with its `File:` / `Folder:` / `URL:` / `Files:` context line (`annotateContextLine`), instead of `The user approved.`; a bare approval still prints that line byte for byte. First, a non-gated Done with nothing to send prints `{"decision":"annotated","feedback":"User reviewed the document and has no feedback.","nothingToSend":true,"annotationCount":0}` (`nothingToSend` appears only in that case and only on the non-strict `--json` record and the `opencode-annotate-last` record; decision values, the feedback text, plaintext, `--hook` output, the strict-gate record and every exit code are unchanged; the OpenCode CLI bridge, Amp and Droid read it; #1701). Second, `annotationCount` (the number of annotations the decision carried) rides every approved and annotated record of the non-strict `--json` output, `opencode-annotate-last`, and `opencode-review`; the OpenCode bridge names it in its decision heading, and the strict-gate record does not carry it. Third, `target` (the absolute file or folder path, URL, or a bundle's files, as the CLI resolved them) rides every non-strict `--json` record and `opencode-review` (the PR URL, patch file or directory), so the OpenCode bridge names the file the CLI actually opened (see "Decision targets"); plaintext, `--hook` and the strict-gate record do not carry it. Note for exact-string matchers: the non-strict `--json` DISMISSED record, which used to be exactly `{"decision":"dismissed"}`, now also carries `target` (`{"decision":"dismissed","target":"/abs/notes.md"}`); parse the JSON and read `decision` instead of comparing the line. Multi-token invocations go through the tolerant tiers described under "Tolerant argument resolution" above; several existing file paths open one review of all of them (strict gates included).

Strict decisions use one newline-terminated JSON record on stdout and, when requested, identical bytes in the result file. Exit codes follow the grep convention: approval exits `0`; with `--require-approval`, annotated and dismissed decisions are published before exiting `1` (negative human outcome); usage/startup/validation failures — bad flag combinations, strict flags outside `annotate --gate --json`, a missing `--result-file` parent, a pre-existing or dangling-symlink destination, and every annotate startup failure (missing path, unreachable URL, empty folder, ambiguous name, missing file, oversized file) — exit `2` (the gate itself was misconfigured or could not start). Those startup sites exit `1` as before for non-strict invocations, with one deliberate exception: the multi-token zero-resolve handoff is not a startup failure, so in plain non-strict mode it prints on stdout and exits `0` (under `--json`/`--hook` it stays stderr + exit `1`). Under a strict flag `1` is reserved for "the reviewer did not approve", so a typo'd path must never masquerade as a rejection. Post-decision publication failures (destination appears between validation and publish, hard links unavailable) also exit `2`: the result *file* was not published, so they present as environment errors — "the gate could not publish its result" — never as a reviewer outcome, and never as approval (still fail-closed, since only `0` means approved). The stdout decision record is written **before** result-file publication and is still emitted whenever the decision itself completed; only a stdout write failure leaves no record anywhere. Signal deaths keep `128+n`. Result paths resolve from the invocation working directory, require an existing parent and absent destination, and publish via a flushed/closed `0600` same-directory temporary file plus an atomic no-clobber hard link—never copy or overwrite fallback (the `0600` mode is a no-op on Windows, and the atomic link/rename is not followed by a parent-directory fsync, so publication is atomic but not crash-durable). Keep reviewed sources at stable project paths; unique result and diagnostic log files may use a narrow temporary directory. Explicit Close emits `dismissed`; missing results or process/browser failures are recovery cases, never approval.

### Abandoned strict gate sessions

Local direct structured gates (`--gate --json`, not `--hook`, not remote) advertise a client lease in `/api/plan` and serve `/api/annotate/client-lease` (SSE, `ANNOTATE_CLIENT_LEASE_STREAM_PATH`). Each open stream is one connected review surface; the server heartbeats every 5s and, once at least one client has connected, starts a 30s reconnect grace when the last one disconnects. A reconnect inside the grace continues the same review; expiry resolves the gate as the same `dismissed` decision an explicit Close produces, except that it keeps the saved annotation draft so an abandoned review can still be recovered. Approve, feedback, explicit exit, and server stop all cancel a pending expiry. Whichever producer settles the session first wins: every one of them (each connected surface and the expiry itself) goes through a single one-shot settlement, so a decision arriving after the session already resolved is rejected with `409` rather than deleting the draft and reporting success for an outcome the caller never received. Page lifecycle events are deliberately not used: `pagehide`/`beforeunload` also fire on reload and navigation, so they cannot distinguish abandonment from a reconnect. A session that never receives its first client never auto-dismisses, so browser-launch failures still need a caller-side timeout, and remote/shared sessions keep the capability off because tunnel disconnects would read as abandonment — as do `--tailscale`-published sessions, which force local mode but are reached through the serve proxy, whose disconnects would read the same way.

### Live app annotation (annotate-app)

Live local app annotation (spec: `adr/research/SPIKE-local-app-annotation-20260810.md`, section 7; phase 1 shipped it on the Bun path, phase 2 brought the Pi extension to parity). `plannotator annotate http://localhost:5173` probes the loopback URL (3s timeout, `accept: text/html`) and, when the probe returns an HTML page, starts server mode `"annotate-app"` instead of converting the page: a dedicated loopback reverse proxy mirrors the whole dev-server origin on its own `127.0.0.1` port, injects `<script src="/__plannotator__/bridge.js">` into every HTML response (streaming, exactly once per document), and passes WebSockets through so HMR keeps working. Every proxy DECISION — the injector state machine, loopback/Host/Origin predicates, CSP/X-Frame-Options policy, redirect rewrite, WS origin gate, bridge assembly, `liveAppDraftIdentity` — lives once in `packages/shared/live-proxy-core.ts`; `packages/server/live-proxy.ts` is the Bun transport over it and `packages/shared/live-proxy-node.ts` (vendored to Pi) is the `node:http` transport, whose WS passthrough replays the client's own handshake upstream over raw TCP and pipes the sockets byte-for-byte. The probe itself (timeout, `< 500` status gate, final-response redirect rule) and every user-facing live-mode message are shared too, in `packages/shared/live-probe.ts`. The editor renders the proxied app full-viewport in an unsandboxed iframe and drives the same pinpoint annotation experience the srcdoc surface provides. `--static` forces the classic conversion; `--app` forces live and errors loudly wherever it cannot apply: non-loopback, https, unreachable, non-HTML, off-origin-redirecting, and non-URL (file/folder) targets. "Loopback" means `localhost`, `::1`, or a LITERAL IPv4 address in 127.0.0.0/8 (`isLoopbackHostname` in `live-proxy-core.ts`, the single source of truth); DNS names like `127.0.0.1.evil.example` are not loopback. Live eligibility is judged on the probe's FINAL response after redirects: a target that 302s off its own loopback origin (auth portal, tunnel splash, another local port) falls back to the static pipeline instead of opening a dead live surface, while same-server redirects stay live-eligible.

The advertised `appUrl` is the proxy under its LOCALHOST spelling with the target URL's own path and query (`http://localhost:<B>/admin?tab=2`): localhost keeps the framed app same-site with the editor page and shares the dev app's host-only localhost cookies and storage, which a `127.0.0.1` spelling would not (Safari ITP would then block all cookies in the cross-site iframe). The proxy still BINDS the `127.0.0.1` literal; browsers that resolve localhost to `::1` first fall back to IPv4 on the refused loopback connect.

**Runtime coverage:** the feature ships on the Bun server + Claude Code CLI path AND on the Pi extension (`/plannotator-annotate http://localhost:5173` probes live-first through the shared `live-probe` module, recognizes `--app`/`--static` via `parseAnnotateArgs`'s `liveFlags` opt-in, and surfaces the probe-fallback notice through Pi's notifier; `apps/pi-extension/server/serverAnnotate.ts` serves the same `annotate-app` `/api/plan` payload over the vendored Node live proxy). The OpenCode slash-command parser is still untouched: its URL targets keep static conversion, and it deliberately does NOT opt into `liveFlags`, so a typo'd `--app` there stays a visible "File not found" instead of being silently swallowed. Pi has no `--tailscale`, so its hard-off matrix is remote-mode only (command-side notify + server throw + unconditional loopback bind).

**Session shape:** the surface opens with pinpoint **armed**, and it is comment-only; the full interaction contract it shares with raw-HTML sessions is documented once under "## Annotation System" below. Two things are specific to live mode: vim navigation is off outright (`vimModeEnabled={liveApp ? false : ...}`, `packages/editor/App.tsx:5484`), because its keyboard cursor writes into the app's own DOM, and the viewer's floating input-method switch is not offered. Text drag-selection commenting is NOT disabled: it stays live in both the armed and Interact states, exactly as on raw HTML. Multi-page sessions are supported in one server session: annotations carry `pageUrl` (pathname + search, capped at 2048), restore filters to the current page, the export groups feedback under per-page headings while numbering stays global, and the bridge reports SPA navigations via a coalesced `page-change` message. Version history, durable submission records, URL sharing, portable HTML export, Obsidian/Bear save, and the annotate agent terminal are all off, exactly like URL sessions. Drafts, feedback, approve, gates, and the client lease work unchanged.

**Security posture:** the proxy binds `127.0.0.1` unconditionally and validates the `Host` header before touching upstream (DNS-rebinding blunting); `PLANNOTATOR_URL_HOST` is never applied to the proxy origin. WebSocket upgrades whose browser `Origin` header is present and does not name the proxy itself are refused before any upstream contact, so a hostile page's cross-site WS connect is never laundered into the origin-less shape dev servers trust as a non-browser client (Vite CVE-2025-24010 class); header-less non-browser clients pass. App CSP on HTML responses is dropped and replaced with a `frame-ancestors` policy listing exactly the editor origins (amending an arbitrary CSP for an injected script is unpredictable; dev servers rarely ship one; `<meta http-equiv>` CSP is a documented non-goal); `X-Frame-Options` is stripped only on those same HTML responses, so non-HTML responses keep whatever framing protection the app shipped. `/__plannotator__/bridge.js` embeds the per-session token, so its delivery refuses `Sec-Fetch-Site` values other than `same-origin`/`none` (defense in depth against off-origin `<script src>` token reads; header-less clients pass). Upstream redirect `Location`s are re-anchored onto the proxy by loopback-host-plus-port equivalence, never by string prefix. The injected bridge authenticates both message directions with a per-session token plus origin checks, and posts each outbound message once per listed editor origin (the browser delivers only the one matching the parent document, so an editor opened at `127.0.0.1` works too); the parent side keeps every existing size cap. Remote mode is a hard-off with three independent layers and no override env var: the CLI exits with a startup failure suggesting `--static` (on Pi, the command notifies with the same shared message), `startAnnotateServer` throws (both the Bun server and the Pi mirror), and neither transport's proxy bind ever follows `PLANNOTATOR_REMOTE` — both bind the `127.0.0.1` literal unconditionally, asserted at source level by their test suites. `--tailscale` sessions are hard-off the same way (CLI startup failure + server throw, keyed on `tailnetPublished`): the annotate server stays loopback-bound but is published across the tailnet through the serve proxy, and a live proxy would relay the user's authenticated dev app to every tailnet peer — the same reasoning that defaults the annotate agent terminal off for tailnet-published sessions. Release-note-worthy behavior change: under `PLANNOTATOR_REMOTE`, `plannotator annotate http://localhost:...` previously converted the page silently and now exits with that startup failure asking for `--static`.

**Live restore resilience:** a `find-and-mark` that resolves nothing in live mode keeps its record, seeded with unresolved placeholder targets from the durable anchor/text params, so the mutation-driven reconcile re-acquires the pin once a lazy route or data-dependent tree finishes rendering. Srcdoc restores keep the old fail-closed drop (a static document would never re-resolve).

**Known limitations (documented, not bugs):** hardcoded absolute origins in the app, origin-pinned CORS to secondary APIs, and OAuth `redirect_uri` flows land outside the proxy; frame-busting apps break the wrapper; content-encoded HTML that survives the encoding strip renders without the bridge; cross-page annotation clicks do not navigate; a redirect to a DIFFERENT loopback service (another port) is passed through un-rewritten and the iframe leaves the proxy, which is why the probe refuses such targets up front. Manual smoke loop: `scripts/live-annotate-smoke.sh` (not CI).

## Plannotator Inbox

One long-lived local server per machine. Agents leave messages, `:::question` blocks, files and guided reviews there for the person, and the person answers when they can. Nothing holds an agent session open on it. A reply wakes the session that asked, through the Claude Code, Pi or OpenCode connection, or reaches any other agent through `wait_for_reply`. The design of record is `.product/approved/plannotator-inbox-window-2026-10-07/` and the owner's decisions are in `.product/approved/plannotator-inbox-decisions-2026-10-06/approval.md`, both in the Workspaces meta repo. Not built: the Mac notification helper (a spike, `research/findings/INBOX-MAC-HELPER-SPIKE-2026-10-07.md` in the Workspaces tree). Where it is documented for users and agents: `plannotator --help` and `plannotator inbox --help` (`apps/hook/server/cli.ts`), the `## plannotator inbox` section of the `plannotator` skill (`apps/skills/core/plannotator/SKILL.md`), and the marketing reference page `apps/marketing/src/content/docs/reference/inbox.md` (`/docs/reference/inbox/`). A change to the command, the MCP tool list or the knob updates all three.

**The command** (`apps/hook/server/inbox-command.ts`, help text in `cli.ts`).
- `plannotator inbox` starts the Inbox in the foreground and opens it in the browser, or opens the running one.
- `plannotator inbox --background` starts it detached (its own session, output in `inbox/inbox.log`), prints the URL and exits 0. It never opens a browser, so an on-demand start never pops a tab mid-work.
- `plannotator inbox --no-open` runs it here without a browser.
- `plannotator inbox mcp` is the stdio MCP entry (`apps/hook/server/inbox-mcp-shim.ts`), a thin JSON-RPC proxy:
  - It POSTs each stdin message to the Inbox's `/mcp` and writes every answer to stdout.
  - It re-reads `inbox/inbox.json` on every message and starts a stopped Inbox through the `--background` path (no tab).
  - When the agent leaves them out, it fills `project_path` (its working folder, or `PLANNOTATOR_CWD`) and `agent_session` (one `ses_` id per shim process).
- Any other argument exits 1 with a usage line.
- Starts are serialized by `inbox/start.lock` (mkdir, stale after 30 s), so two agents that find the Inbox stopped at once start one. The detached child runs under its starter's lock (`PLANNOTATOR_INBOX_LOCK_HELD`, internal, scrubbed at start).
- The Inbox never registers in `sessions/` and never arms auto-update, so it never holds an update back.
- The help text's `inbox mcp` line names all eight MCP tools (see "MCP"); keep it in step with `packages/server/inbox-mcp.ts`.

**Local only by default; each wider path is a switch.**
- It always binds `127.0.0.1` and ignores `PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT` and `--tailscale`, because it holds tokens and everything agents sent.
- Port: the last one (from the registry) comes first, so the browser's notification permission holds. When something else holds that port, the Inbox takes a random port and shows a one-time notice (stderr and the list model's `notice`). It never uses 19432.
- A paired phone reaches it only through the device door (see "Phones"), and only over a path the person switched on in Settings:
  - "Reach from my tailnet" (off by default): a second loopback listener that serves the device door and nothing else, published with `tailscale serve --bg --https=8443 http://127.0.0.1:<door port>`, serve and never funnel. The window's port is never published: `tailscale serve` passes the client's own Host header through, so only the socket can keep tailnet requests on the door. The switch is kept in `inbox.json` as `tailnet: { https_port: 8443, door_port }`; each start publishes again. The listener and the mapping go when the switch goes off and at every clean stop (quit, the stop route, and a restart to update, before it starts the new binary). A mapping a crash left (kill -9) is re-pointed by the next start before anything else, or taken down when it cannot publish; SIGHUP runs the clean stop while a mapping exists (installed only then, as `--tailscale` does, so `nohup` keeps its meaning otherwise); `uninstall --purge` takes a leftover down by `door_port`. A take-down that fails changes nothing (switching off answers `409 tailnet_unavailable`, `door_port` is kept). The window's port never adds the tailnet name to its Host allowlist. A mapping on 8443 that the Inbox did not make (its target is not this run's or the last run's door listener) is never overwritten or taken down: the switch stays off and Settings says so.
  - "Reach from this Wi-Fi" (off by default; `packages/server/inbox-lan.ts`, contract section 3): a TLS listener on every interface (`0.0.0.0`) that serves the same door-only handler as the tailnet's listener, on a port chosen free the first time and kept in `inbox.json` as `lan: { port, on }` (kept when switched off, so on again reuses it). It stays on all interfaces, not the Wi-Fi address alone: a socket bound to one address dies with a new DHCP lease, and `Bun.serve` cannot bind to an interface. The certificate is self-signed ECDSA P-256 (`CN=Plannotator Inbox`, never rotated), made with two `openssl` child processes the first time and kept in `inbox/tls/` (files 0600 in a 0700 folder); its SHA-256 (of the DER) rides the QR as `fp` and the phone pins it. A `_plannotator-inbox._tcp` Bonjour record (instance `computer.name`, TXT `v=1`, `fp=`) goes out through `dns-sd -R` (macOS) or `avahi-publish -s` (Linux) as a child process under `sh`, which ends the publisher when its stdin closes, so a kill -9 leaves no record; with neither, the listener still answers at the QR's address and Settings says phones will not list it. Pairing over the Wi-Fi is by the QR's secret only: the LAN listener's `pair` refuses six digits with `400 code_not_accepted_here` (a Bonjour record anyone on the Wi-Fi can publish must never become the pin), while the window's port and the tailnet's listener take both; the record's `fp` only lets a phone already paired by QR follow the computer to a new address. The QR's `lan` is the first private IPv4 address that is not loopback, link-local or Tailscale's, read when the offer is made. Off closes the listener and the record and keeps the port with `on: false`; a listener that cannot open at start shows the switch on with the reason, and off works; a clean stop closes both and keeps the switch, and the next start opens the same port with the same certificate. `openssl` missing answers `409 lan_unavailable` and the switch stays off.
  - The relay (R1; `packages/server/inbox-relay.ts`, `apps/relay`, contract section 4): not a listener. The Inbox makes an outbound mailbox at the first pairing and holds one WebSocket to it while a phone is paired; the relay holds only hashes, each phone's relay switch, its APNs token and envelopes it cannot open. Through it (R2) a phone reads and answers the Inbox from anywhere: store lines down, commands up, each sealed under keys made at pairing.

**Registry** `${dataDir}/inbox/inbox.json` (`packages/shared/inbox/registry.ts`).
- Shape: `{ v, pid, port, url, version, token, serverSession, startedAt, tailnet?, lan? }` (`tailnet: { https_port, door_port }` while "Reach from my tailnet" is on, `lan: { port, on }` once "Reach from this Wi-Fi" was switched on), mode 0600, written atomically at every start and kept after exit. "Found" means the file exists. The token rotates every start.
- Running: `GET /api/inbox/health` on that port answers with this entry's `serverSession`.
- Stopped: a dead pid with no answer, a port answering for another Inbox, or a live pid with nothing listening (a reused pid).
- Busy: a live pid whose port takes the health request but does not answer in time. Callers wait for a busy Inbox (up to 20 s, then an error) and never replace it, because a second process would be a second writer on the store.
- Callers re-read the registry on every call.
- The detached Inbox runs with `inbox/` as its working directory and `windowsHide`.
- Restart to update: on a 60 s health tick, a compiled Inbox stats the binary on disk. Only when the file's identity (device, inode, size, mtime) changed does it run the binary with `--version`. If that version differs from its own, the Inbox reports `update: { available, version }` on health, the list model and the event stream.
- `uninstall --purge` stops a running Inbox first (its token-guarded stop route, then SIGTERM only while the port still answers with that `serverSession` and pid) and removes `inbox/` (`inbox` is in `PURGE_OWNED_TOP_LEVEL`, `packages/server/uninstall.ts`). An Inbox that is still running after that blocks the data purge: uninstall says to quit it and run `uninstall --purge` again. It also takes down a tailnet mapping a crashed Inbox left (`takeDownInboxTailnet`, only when `inbox.json` has `tailnet`). `--dry-run` lists the stop and the take-down. A plain uninstall keeps the data.

**Store** (`packages/shared/inbox/`, one writer: the server process).
- Layout under `inbox/`:
  - `projects/<key>/` holds `project.json`, `messages.jsonl`, `questions.jsonl`, `decisions.jsonl` and `annotations.jsonl`. `<key>` is the project name plus 6 hex of the root's hash. A key that collides takes more of the hash.
  - `blobs/<sha256>` holds sent attachment versions and guided-review snapshots.
  - `seq.json` holds the highest seq across deletions.
  - The Pi and OpenCode connections keep `claims/<reply id>/` (delivery claims), `connection-tools.json` (the last tool list) and `leases/<host>-<session>.json` (which process of a session delivers).
  - The Claude Code mod keeps its claims and lease under `claude-code-mod/<session>/inbox/`.
- A project is the repository (the git toplevel of the path an agent names) or the folder.
- Every line is a full snapshot `{ v, seq, at, kind, id, record }`. The last line per id is current. Nothing is rewritten in place, and fields are only added.
- `seq` is one counter across the Inbox. The union of lines by seq is the event log that the window's stream and `wait_for_reply`'s cursor read.
- A torn last line is skipped on read, and a newline is appended before the next write to that file.
- No storage caps.
- Records are snake_case with `msg_`, `prj_`, `ses_`, `att_` and `dec_` ULIDs.
- Questions:
  - A question record keeps Workspaces' `Question` wire fields beside Plannotator's `QuestionAnswer` v1 (`packages/core/inbox-types.ts`).
  - State (`open | picked | sent | closed`) is derived, never stored.
  - `Stopped:` and `Holds up:` lines are read as Workspaces reads them (`packages/core/inbox-questions.ts`, over core's `findQuestionBlocks` and `parseQuestionBlock`, so keys equal the card's).
- Idempotency:
  - An agent's send is idempotent on its `idempotency_key`. The key is checked before routing. Another body, `reply_to` or thread name under the same key is `409 idempotency_key_reused`.
  - A person's Send is idempotent on its own key.

**Threads and the project filter** (the row model, owner ruling 2026-10-07). A row is a thread. The project is a label on the row and a filter (the sidebar's folders), never the row. `send_message` routes in `InboxStore.sendMessage`, and the first match wins:
1. `reply_to`: that message's thread, as a reply.
2. `thread`, a name:
   - Validation: trimmed, 1 to 120 characters, with no control characters, line breaks or bidi controls, and something visible. Anything else is `validation_error: thread: …`.
   - It joins the newest OPEN thread of that name in the project, across sessions. With none open, it starts a new thread under the name.
   - Names compare by `inboxThreadNameKey` (NFKC, default-ignorable code points dropped, whitespace runs as one space, case folded), so look-alike spellings are one thread. The stored name keeps the first sender's spelling.
3. Otherwise, the sender session's default thread: the newest UNNAMED thread that `agent_session` started in the project while it is open, else a new thread. A sender with no `agent_session` starts a thread with each message.

More rules:
- Resolved means done: the next message starts a new thread. A resolved thread still takes `reply_to` replies.
- A thread keeps its first message's subject.
- Routing reads only the log: two indexes (`sessionThreads`, `namedThreads`) are rebuilt from each root's first line in seq order. A replay therefore routes exactly as the live store did, and an older store with no `thread_name` replays unchanged.
- Routing is synchronous inside the server process, so racing sends land in one thread.
- `read_thread`'s list mode lists the threads the session sent in (`asked_by: "me"`), and `wait_for_reply` with no id waits on those threads.
- Without a cursor, a reply counts when it comes after the caller's last message in the thread.

**The list** (`packages/shared/inbox/list.ts`, pure; labels in `INBOX_SECTIONS`, `packages/core/inbox-types.ts`). The sections, in order: Stopped on you, Holding up work, Waiting on you, Sent, New since you looked, Quiet. The strongest reason wins:
1. Resolved: Quiet.
2. An open question with `Stopped:`: Stopped on you.
3. One with `Holds up:`: Holding up work.
4. Any other open question: Waiting on you.
5. Picks saved but not sent: New since you looked ("Answered, not sent").
6. The person's reply is the last message and no agent has read it: Sent.
7. Agent messages after the person's last look: New since you looked.
8. Anything else: Quiet.

Sorting and the rest:
- Stopped and Waiting sort oldest waiting first. Holding sorts most held-up first. Sent, New and Quiet sort newest activity first.
- `unread` (bold) means Stopped, Holding, Waiting or New.
- "Looked" is `POST /api/inbox/threads/:id/seen`, sent when a thread opens. The person's own reply also counts.
- "The agent read it" is recorded when `wait_for_reply` returns the person's reply or `read_thread` reads the thread, which moves a Sent row to Quiet. Any agent's read counts.
- `?project=prj_…` keeps the sections and drops other projects' rows.
- The list is linear in the store: about 10 ms for 4,000 threads.

**The window** (`packages/inbox`, built by `apps/inbox` as a Vite single-file app).
- Build and serve: `build:hook` copies its `dist/index.html` to `apps/hook/dist/inbox.html`. The binary embeds it, and `runInboxCommand` hands it to `startInboxServer` as `htmlContent`. Without it, `/` says to run `build:hook`.
- Styling: `packages/inbox/inbox.css` carries the design record's values on Plannotator's theme tokens with an `ib-` prefix. Plannotator's own components draw themselves.
- Routing is the hash: `#thread=msg_…` (the link the MCP tools hand agents), `#project=prj_…`, `#settings`, `#decisions=prj_…&decision=dec_…`, `&file=att_…`, `&guide=msg_…`.
- The sidebar:
  - The Tater mark (24 frames over 3.5 s, paused offscreen, the first frame under reduced motion).
  - Inbox, and each project folder with the count of rows waiting on the person.
  - Decisions, with the count of questions that record a decision once sent.
  - Settings.
  - "A new version is ready, Restart" when health reports `update`. Restart is `POST /api/inbox/restart`: the server stops, the binary on disk starts detached, and the page reloads on the new `serverSession`.
- A wide row shows:
  - the project label
  - the badge ("Stopped", "Holds up N")
  - the agent's mark
  - the named thread's chip
  - the subject
  - the count ("2 questions", or "Answered, not sent")
  - the "Guided review" mark when the thread carries one
  - the time

  A Sent row reads "Saved for <agent>. It sees it when it checks." Quiet is folded.
- Held order (`packages/inbox/held.ts`): the rows on screen change only on an action (opening a row, a pick, a Send, a folder, Show). New agent activity waits behind "N new in <project>". The person's own writes never count.
- First run (no project yet), "No agent has written yet":
  - three equal cards for the Plannotator connections (Claude Code, Pi, OpenCode), each with "Use MCP instead"
  - then "Other agents", the harness picker (`packages/inbox/harnesses.ts`), with one verified artefact, one note and a folded "Another way" per harness
  - Every command names this CLI's absolute path (`mcp_command` from `GET /api/inbox/settings`).
- Settings:
  - the `inboxTool` knob per host ("applies to the next session"; disabled while `PLANNOTATOR_INBOX_TOOL` decides)
  - the notifications switch
  - the compact picker (Other MCP client: the command and `http://127.0.0.1:<port>/mcp`)
  - the store on disk per project and thread, with Delete thread and Delete project ("Delete? Click again")
- Theme: it follows the OS unless Plannotator's theme cookies say otherwise. `configurePlannotatorUI` turns off `/api/config` sync and WebMCP.

**Questions and Send.**
- A row opens the thread beside a narrowed list and records a look.
- The thread reads as email: the subject, the sender row, and each message through `Viewer` with the `answerOnly` seam. There are no comments on the text and no document actions, and the question cards keep their handlers.
- A click on a card is a pick, saved at once (`POST /api/inbox/messages/:id/picks`, serialized per thread, a stale revision `409 question_revision_conflict`). The card's footer says "Picked 10:51 AM, not sent" or "Sent 10:52 AM". "Waiting on this answer · Holds up N" sits under the asking message.
- The foot:
  - "Not sent · Send · Edit the reply" when picks wait.
  - The reply box with its "N picks" and "N annotations" chips. Mod+Enter sends.
- A Send is `POST /api/inbox/messages/:id/reply` with an idempotency key per target message, kept for a retry. The store writes one person reply in this order: `Answered N questions.`, the person's words, `formatQuestionAnswersSection`, then the annotations' feedback.
- The sent questions are marked before the reply line lands. When the reply line never lands, they read as picked again, so a retry never reads "already sent" with nothing sent.
- After a Send, the reply shows "Saved for <agent>…" until an agent reads it or a connection delivers it, then "Delivered to <agent>, 10:52 AM".
- No tool answers, approves or sends for the person.

**New message** (`packages/server/inbox-sessions.ts`, `packages/inbox/components/NewMessage.tsx`; record 5.1 to 5.3; owner Q4: "just another button next to reply", built as a try, not a chat product).
- The thread's New message button writes the person's words to one LIVE agent session of the thread's project, through the same wake path as a reply.
- A New message belongs only to the session it names. The store keeps it as a person message with `reply_to: null` and `to: { host, session }` (`InboxAddressee`), and `InboxStore.isFor` hands it to that session only:
  - `pendingReplies` gives it to that session's poll (command `type: "message"`), and `recordDelivery` refuses any other session.
  - Another session's `wait_for_reply` never returns it (`forCaller` in `inbox-mcp.ts`).
  - Another agent reading the thread through `read_thread` sees its text but does not settle it. It is settled only by its delivery: the named session's wake, or that session's own `wait_for_reply`, which records the delivery.
- Live sessions are kept in memory only. Every bridge poll can carry `project_path`, `started_at`, `busy` and `idle_since`, and `POST /api/inbox/bridge/event` `{ type: "state", busy }` says when a turn starts or ends.
  - A session is live while it polled within `INBOX_SESSION_LIVE_MS` (30 s, `connection.ts`) or holds a poll now.
  - It is in a project when its `project_path` resolves to the project's root (realpath, then the repository root, cached per path). A connection that sends no `project_path` is in a project when it wrote there.
  - The Claude Code mod sends all four. The Pi and OpenCode polls send none of them, so their sessions count in a project they wrote in.
- Routes: `GET /api/inbox/threads/:id/sessions` and `POST /api/inbox/threads/:id/message` (see "Inbox Server"). A session that is no longer live is `409 session_not_live` and nothing is written. A replayed key answers the message it wrote.
- The wake is `inboxWakeText` with `INBOX_MESSAGE_INSTRUCTION` as its second line: the person wrote to you; answer with `reply_to` the id in the first line. Its subject is the thread's, and there is no MCP tool for it.
- The window:
  - The button reads the live sessions when the thread opens, every 10 s, and on press.
  - None: the button greys but stays pressable and opens "<agent> is not running in <project>" with Reply instead (5.3).
  - One: the box opens addressed to it, "New message to <host> in <project> (live session, idle|working)" (5.1).
  - Several: one row each, with when it started and whether it wrote this thread, is idle or is working (5.2).
  - The thread shows the message "to <host>", then "<host> takes it as its next turn." until delivered, then "Delivered to <host>, <time>".
- Tests: `apps/hook/hooks/mod/inbox.test.ts` 09 and `tests/e2e/inbox-new-message.spec.ts`.

**Attachments and annotation** (record 2.1 to 2.8; files shown as they are now, versioned).
- `send_message` takes `attachments: [path]` (absolute, or relative to `project_path`).
- At send time, `recordInboxAttachments` (`packages/shared/inbox/attachments.ts`) resolves each path to its realpath. It checks every file before writing anything, with no size bound. It refuses:
  - a path outside the project root
  - a path that is not a regular file
  - `.env`, by the named path's name and by its target's
  - anything outside annotate's annotatable set (`packages/core/annotatable.ts`)
- Each accepted file's bytes are copied to `inbox/blobs/<sha256>` (the sent version). The message gets an attachment record: `att_` id, realpath, `named_path` for a symlink, `kind` (markdown, text, html, mermaid or graphviz), `sent_sha256`, `size`, `sent_at`, `sent_mtime`.
- Access: a file is reached only by its id, and no route takes a path. Reading the current file requires the recorded realpath to still be that path and a regular file. Otherwise the answer is `409 attachment_changed_type` or `404 attachment_missing`, and the sent version still opens.
- Serving:
  - Raw bytes go out as `text/plain` with CSP `sandbox` and nosniff.
  - HTML is drawn through annotate's serving path: a `<base href>` at `/api/html-assets/<token>/`, one unguessable token per folder, inside `HtmlViewer`'s sandboxed srcdoc frame. Relative images and frames load from the file's folder. The page cannot read the Inbox API, and a frame never draws the Inbox.
- The window (`packages/inbox/components/AttachmentTiles.tsx`, `AttachmentPane.tsx`, `AnnotationsChip.tsx`):
  - Tiles sit at the foot of each agent message ("Markdown, 2 annotations", or "Changed since it was sent, edited 11:05 AM").
  - Open puts the file beside the thread, with Full screen. HTML opens full screen by default.
  - Viewers: markdown and text through `Viewer` with the annotation toolstrip, diagrams through `DiagramViewer` (node comments), and HTML through `HtmlViewer` (pinpoint, pen, Esc to Interact).
  - `AnnotationPanel` sits at the right.
  - The changed line reads "Changed since <agent> sent it at 10:42 AM. Edited 11:05 AM. Open the version it sent".
- Annotations live in `annotations.jsonl`, keyed by the file's path and version (`current` or the sent sha256). A draft on `current` survives the agent's edit and re-anchors by its text.
- Send carries the annotations as Plannotator's feedback text (`exportLinkedDocAnnotations`, under "Feedback on the attached files", one section per file and version) and marks them sent with the reply.
- Comments take no images.
- Delete thread rewrites the project's files without the thread's lines. Delete project removes its folder. Both then remove every blob that no remaining record uses.

**Decisions** (`packages/server/inbox-decisions.ts`; records in `decisions.jsonl`, `InboxDecision` in `inbox-types.ts`).
- Fields: `text`, `reason`, `source` `{ kind: answer | agent | person, … }`, `state` `current | replaced | retired`, `version` (a stale one is `409 decision_version_conflict`), `replaces_id`, `replacement_id`, and the dates.
- The switch:
  - The tag on every question card is the switch, `decision_recording` on the question.
  - Default: on exactly when the block says `Decision: when answered`.
  - It is saved at once by `POST /api/inbox/messages/:id/decision` and refused once the answer is sent.
- The decision card: the tag's words open it (`DecisionCard`). "Decision" is drafted from the answer and "Why (optional)" as "Asked by <agent>: <question>".
- At Send, after the reply landed, `recordDecisionsForReply` writes one decision per sent question with recording on. A decision that cannot be written comes back in `decisions_refused` and never undoes the answer. The thread shows "Settled: <text>".
- The Decisions page (`#decisions`):
  - a project switch
  - Waiting
  - Settled
  - "Replaced or retired", folded
  - a row opens with Retire or Replace. Replace writes a new record naming `replaces_id`.
- MCP: `list_decisions` (`state`: current by default, replaced, retired, all) and `record_decision` (text, reason, idempotent, source `agent`).

**Guided reviews** (`packages/server/inbox-guides.ts`; code diffs only, in Plannotator's portable format).
- `get_guide_brief` answers the authoring brief in the shape Workspaces' tool gives agents: `methodology`, `output_schema`, `diff_steps`, `rules`, and an `example` that works as it is.
- `submit_guide` takes `guide` plus `patch`, or `snapshot`, plus `body` and send_message's routing fields.
- Validation is Plannotator's own (`parseGuideSnapshot`, `buildAuthoredGuideSnapshot`'s placement checks). A refusal is `invalid_guide: …` naming the file.
- The snapshot is stored as a blob only after the message lands. The message carries `guide: { sha256, input_sha256, bytes, title, sections, files, additions, deletions }`. Idempotency compares `input_sha256`.
- The window: the message shows the guide as a card. Open (`#thread=…&guide=<message id>`) takes the window: Plannotator's `GuideView` over review-editor's `AllFilesCodeView`, read-only. The reader mounts only through a `lazy()` import, guarded by `tests/entry-assets.test.ts`.
- Reviewed ticks are kept on the message (`POST /api/inbox/messages/:id/guide/reviewed`).
- Escape or "Thread" goes back.
- Build notes: the window's strict typecheck reads the reader's shape from `packages/inbox/guide/reader-module.d.ts`, and the reader itself is checked by `packages/inbox/tsconfig.guide.json` (review-editor carries pre-existing type errors). `apps/inbox/index.css` scans `packages/guide-viewer` and `packages/review-editor/components` for Tailwind. No class was added to the guide chain, so the guides.show viewer build and its pinned manifest are unchanged.

**Notifications** (`packages/inbox/notify.ts`; the open page first, no Web Push, no service worker).
- The page raises a browser `Notification` for each new question that the event stream brings in. News never notifies. Every notification carries one tag (`plannotator-inbox`).
- While the tab is away:
  - One thread: "<project>: <agent> stopped on you" or "is waiting on you", with the subject as the body. A click opens the thread.
  - A burst becomes one notice, "3 waiting in 2 projects". A click opens the list.
- Nothing is raised while the tab is visible and focused.
- The one-time ask (`components/NotificationAsk.tsx`) appears above the list when an item arrives and the browser has not decided. It never appears on first paint. "Not now" is remembered.
- After a port change it returns once as "The Inbox moved to a new address. Allow notifications again."
- State lives in config.json as `inboxNotifications` (`{ enabled, dismissed, allowedOrigin }`), through `GET` and `POST /api/inbox/settings`.

**Agent connections and the knob.**
- A connection gives its host one tool, `plannotator_inbox`, whose `action` is one of the Inbox's MCP tools. It also wakes the session that asked when the person sends.
- The contract lives once in `packages/shared/inbox/connection.ts`. The mod keeps a byte-for-byte copy of its CONTRACT section in `apps/hook/hooks/mod/inbox-contract.ts`, pinned by `inbox-contract.test.ts`.
- The tool is built from the running Inbox's own `tools/list` (`inboxAgentTool`). The connection fills `project_path`, `agent_session`, `agent_host` and `agent_name` and keeps them out of the schema.
- The wake text (`inboxWakeText`) is `Plannotator Inbox: <subject> (<reply id>)`, the fixed `INBOX_WAKE_INSTRUCTION` line, a blank line, then the reply verbatim. It never carries the thread and never touches the system prompt.
- A connection whose wake runs sets `_meta["ai.plannotator/inbox-wakes"]: true` on its `tools/call` (`INBOX_WAKES_META_KEY`, `inboxToolCallParams`): the Claude Code mod always, Pi and OpenCode 2 while the session's wake exists, OpenCode 1 never. send_message and submit_guide then end their result with `INBOX_REPLY_ARRIVES_TEXT` (end the turn; the reply arrives by itself) instead of "Call wait_for_reply…", which the stdio shim, raw MCP clients and older connections keep (`callerWakes` in `inbox-mcp.ts`). An older Inbox ignores the key.
- The bridge is two connection routes:
  - `POST /api/inbox/bridge/poll` holds up to 25 s for the person's replies to that session.
  - `POST /api/inbox/bridge/event` `{ type: "delivered" }` writes `delivery` on the reply, which the thread shows as "Delivered to <agent>".
- Pending replies are derived from the store (`InboxStore.pendingReplies`), so a reply is handed out on every poll until it is delivered, survives a restart, and never wakes a session that already read it through the MCP.
- Each host checks the knob and the registry once, and the tool exists only where `inbox/inbox.json` existed then and the knob allowed it: the Claude Code mod at the process's first `session.start` (so a change applies when Claude Code restarts), Pi when the extension instance loads (each session and `/reload`), OpenCode at plugin setup (each OpenCode start). The tool list never changes during a session.
- The knob: `PLANNOTATOR_INBOX_TOOL` (`1`, `true`, `on` / `0`, `false`, `off`, `disabled`), then config `inboxTool` (one boolean, or `{ "claude-code", "pi", "opencode" }`, written by Settings), then `INBOX_TOOL_DEFAULTS` (on for Claude Code, off on Pi and OpenCode, which send every tool's full definition with each request) (`packages/shared/config.ts`, `resolveInboxTool`).
- **Claude Code** (the mod, `apps/hook/hooks/mod/inbox.ts`; details in "The Plannotator Inbox" in the mod section):
  - `InboxLink` long-polls on a 1 s tick and submits the wake once the session has been idle for two ticks.
  - It claims each reply once (mkdir) and holds a per-session lease, `watcher.json`: the person's last process wins, and the lease goes stale after 20 s.
  - It needs the mod (Claude Code 2.1.287+, not `claude -p`, not Windows).
- **Pi and OpenCode** (`packages/shared/inbox/agent-link.ts`, vendored into Pi as `generated/inbox/`):
  - `InboxAgentConnection` starts a stopped Inbox with `plannotator inbox --background`, through `PLANNOTATOR_BIN`, `plannotator` on PATH, or `~/.local/bin/plannotator`. With no binary, the first result says to install Plannotator.
  - `InboxWake` long-polls, delivers after two idle ticks, checks the reply once more, and claims it with a mkdir of `inbox/claims/<reply id>`. It never interrupts a turn.
  - Two processes on one session (`pi -c` or `--session` twice; two `opencode2` servers on one database): only the holder of the session's lease, `inbox/leases/<host>-<session>.json` (`{ owner, at, touchedAt }`, `inboxLeaseFileOf` in `agent-link.ts`), polls and delivers. It is the Claude Code mod's rule ported: the process the person used last holds it, renewed every 5 s (`INBOX_LEASE_EVERY_MS`), taken over about 20 s after the holder dies (`INBOX_LEASE_STALE_MS`; released at once on a clean exit), and re-read right before the claim. The claim still keeps a delivery once whatever the lease says.
  - What moves the lease: on Pi, the person typing (an `input` whose source is not `extension`) and a `plannotator_inbox` call, plus a session start. On OpenCode 2 (checked on 2.0.19) typing does NOT move it, only a `plannotator_inbox` tool call does, because the plugin gets no typing events: its event subscription yielded none there. The code would also touch on a user `session.inbox.enqueued` item or a `session.execution.started`, should an OpenCode deliver them. So on OpenCode 2 a process the person only typed into, whose agent never called the tool, has no wake, and the other process still delivers.
  - Pi (`apps/pi-extension/inbox.ts`): the tool is inactive in print and JSON mode. Delivery is `pi.sendUserMessage(text, { deliverAs: "followUp" })`, confirmed by its `message_start`, and the thread reads "Delivered to Pi".
  - OpenCode 2 (`apps/opencode-plugin/inbox.ts`): the wake is per root session, made on its first tool call or run in the process. Delivery is `session.prompt({ delivery: "queue" })`, never steer, and the thread reads "Delivered to OpenCode".
  - OpenCode 1: the tool only, with no wake.
  - Neither package ships `inbox.html`.

**MCP for other agents** (`packages/server/inbox-mcp.ts`, `@modelcontextprotocol/server` 2.2.0, stateless).
- Tools: `send_message`, `read_thread`, `resolve_message`, `wait_for_reply`, `list_decisions`, `record_decision`, `get_guide_brief`, `submit_guide`.
- Transports: stdio through `plannotator inbox mcp` (the harness picker's commands use it), or Streamable HTTP at `http://127.0.0.1:<port>/mcp`. The window says to prefer the command, because the port can change.
- Character limits: server instructions stay under Claude Code's 2,048 characters. The question guide rides `send_message`'s description, and `inbox.test.ts` pins that Claude Code's 2,048-character description cut keeps the guide's working part.
- Answers: success is `structuredContent` plus one line. A refusal is `isError` with `<snake_code>: <message>`.
- `wait_for_reply` returns a reply as soon as it lands, or `{ status: "waiting", cursor }` after 50 s.

**Server routes** are listed under "Inbox Server" in "Server API".

**On a phone**: `adr/implementation/inbox-mobile.md` is the wire contract the iPhone app and its server steps build against: the pairing offer, the device token door `/api/inbox/device/*`, the LAN listener, the relay, the surface bridge and the idempotency rule. Built (P1, P2, R1, R2): pairing, the door, the tailnet path, the LAN listener, and the relay's mailboxes, push and carriage; the iPhone app `apps/ios` (M1: pairing by QR or typed address and six digits, the list, threads, picks, Send, Resolve, Delete, Settings with the tailnet row; its proof is `bun apps/ios/scripts/proof.ts --binary <compiled plannotator>`, run by `.github/workflows/ios.yml`). Not built: the app's Wi-Fi path (pinned TLS and Bonjour).

**Phones** (`packages/server/inbox-devices.ts`, records in `packages/shared/inbox/devices.ts`; contract sections 1, 2 and 6).
- Pairing: Settings' "Pair a phone" calls `POST /api/inbox/pairing`, which opens one offer: a `plannotator://pair` link (drawn as a QR code with `uqr`, `packages/inbox/qr.ts`) carrying the computer's name, the tailnet address when it is on, the LAN address and the certificate's SHA-256 (`lan`, `fp`) when the Wi-Fi is on, a 32-byte secret and six digits. One offer is open at a time, in memory only. It closes when redeemed, when the window makes another, 10 minutes after it was made, or after 5 wrong codes: the two limits pairing needs, and the only ones. The phone redeems the secret or the digits at `POST /api/inbox/device/pair` for its own `tok_` bearer token, returned once.
- Records under `inbox/`: `devices.jsonl` (the store's line rules; `dev_` id, name, platform, the token's SHA-256 and never the token, created, last seen, revoked, `carriage`), `device-secrets/<dev id>` (the pairing secret, 0600 in a 0700 folder, for the relay's keys; deleted on revoke) and `device-commands.jsonl` (the door's answers by key). Last seen is kept in memory on each request and written when its UTC day changes.
- The relay (`packages/server/inbox-relay.ts`; the Worker in `apps/relay`; contract section 4):
  - The first pairing makes the mailbox (`POST /v1/mailboxes` with the SHA-256 of a fresh 32-byte mailbox secret) and keeps it in `inbox/relay.json` (0600): `{ v: 1, url, mailbox_id, secret }`. The redemption's answer carries `relay: { url, mailbox_id }`, or null when the relay cannot be reached (a call waits 10 s at most). Each paired phone is registered by the SHA-256 of its relay secret (HKDF of its pairing secret, `deriveRelayKeys` in `packages/core/crypto.ts`) and removed at the relay when it is revoked.
  - One outbound WebSocket to the mailbox while a phone is paired, reconnecting 1 s to 60 s apart. `hello` writes each phone's relay switch into its record, removes at the relay a phone revoked here, and registers a phone the relay does not list; `carriage` writes the switch a phone flipped. The phone registers its APNs token at the relay itself, with its relay secret.
  - The carriage (R2). Frames are handled one at a time in arrival order. Down: after `hello`, each phone with its switch on gets every store line after the cursor the relay holds for it (`changesSince`, as the event stream catches up), then each line as it is written, as an `item` sealed under the phone's key `K` (the event stream's `record` payload plus `v`, `type` and `after`, the seq the previous item reached, so the phone notices a gap); a line past Cloudflare's 32 MiB WebSocket message goes down as a `too_large` placeholder and the cursor moves past it. The push plaintext carries `type: "push"`, so neither can pass for the other. Up: each `command` is opened with the phone's up key `U` (a key per direction, so a down envelope reflected up does not open), applied in-process through the door as that device (`asDevice` in `inbox-devices.ts`: the revocation check, the allowlist and the idempotency log, never a loopback HTTP call), answered with a `result` item under the id sealed inside it (a sealed id that is not the relay's frame id is refused) with status, type and body bytes as base64 (files are GET results; one past Cloudflare's 32 MiB WebSocket message becomes a 413 `result_too_large` in its place), and reported `applied`. `pair` and `events` are not carried. A command no key opens is reported applied with no result. The Inbox stopped, commands wait at the relay and are applied on the next start; a replay answers the stored result and writes nothing.
  - Push: an agent's message landing with a question or a guided review (its first line in the store) sends one push per paired phone whose switch is on, the summary (thread, subject, project, agent, and one single-choice question with up to four choices) sealed with `encryptWithKey` under that phone's key, collapsed per thread by an HMAC of the thread id under that key (the relay never sees a thread id). Over Apple's 4096 bytes it drops the question's context, then the question, then sends the ids alone.
  - The relay is `https://relay.plannotator.ai` (not yet deployed; until then a pairing answers `relay: null`) unless `PLANNOTATOR_RELAY_URL` names another. Tests never reach the hosted relay: the root preload and the test world point it at a closed loopback port.
  - The Worker (`apps/relay`): one Durable Object per mailbox on SQLite (`mailbox` with the secret's hash; `devices` with the relay secret's hash, the switch, the cursor, the APNs token and environment, the next item number; `items` and `commands`, envelopes kept in parts of 1,000,000 characters because a row may not pass 2 MB). Down items are deleted on the phone's ack (by item number, or by store cursor when it read directly) and when it turns its switch off; commands when the Inbox reports them applied; everything a device held when it is removed. APNs over HTTP/2 through `connect()` (`src/apns-h2.ts`; a Worker's `fetch` cannot reach APNs; it refuses a frame over 16 KiB and keeps at most 8 KiB of an answer), an ES256 provider token from the `APNS_KEY` secret kept 50 minutes; a 410 deletes the token; without the key a push answers `no_apns_key`. Mailbox creation takes guides.show's rate limit rule (20 a minute per IP); nothing else is braked; nothing is swept by time.
- The door, `/api/inbox/device/*`, in order: any `Origin` is `403 origin_not_allowed`; `pair` takes no token; then `Authorization: Bearer tok_…` (`401 device_token_missing`, `device_token_invalid`, `device_revoked`); then the explicit allowlist (`ALLOWLIST`: health, threads, projects, a thread, seen, events, picks, reply, resolve, delete thread, attachments, view, the HTML asset route, annotations and remove, the guide and its ticks, the decision switch, decisions, live sessions, New message; anything else `404 device_route_not_found`); then a POST needs `idempotency_key` (`422`). The request then goes to the window's own handler through the server's own `fetch` on loopback, adding and stripping nothing. `/mcp`, the bridge, control, settings, restart, raw attachment bytes, project delete, decision retire and replace, pairing, the device list and the tailnet and Wi-Fi switches are never on it.
- Idempotency: a POST's status and JSON body are kept per device and key and read at start. The same key on the same route answers them again with `Idempotent-Replayed: true` and writes nothing; on another route it is `409 idempotency_key_reused`; a 5xx is not kept.
- Remove: Settings' Remove (`POST /api/inbox/devices/:id/revoke`) or the phone's own `POST /api/inbox/device/revoke` marks the record revoked, deletes its secret and ends its open event streams. Its next request is `401 device_revoked`.
- Settings' Phones block (`packages/inbox/components/Phones.tsx`; not in the window's design record, OWNER-ITEMS item 23, built in Settings' own rows): the Wi-Fi switch with the LAN address, the certificate's SHA-256 in groups of four and, where nothing can publish Bonjour, a note that phones will not list it but the scan still pairs; the pairing panel says "or enter the code" only while the tailnet is on; the tailnet switch with the served address (the two in the order the iPhone's 9.2 lists them); Pair a phone (with neither path on, its note offers "Turn on Reach from this Wi-Fi" in place) (the QR, the digits, the countdown, New code; it watches the device list while open and closes when the phone appears), the paired phones with platform, last seen and Remove (asked twice).

**The surface** (PLAN step S1; contract section 5). `apps/inbox`'s `build:surface` (`vite.surface.config.ts`, entry `surface.html`) builds `packages/inbox/surface` into one file, which `build:hook` copies to `apps/hook/dist/surface.html`; the iPhone app bundles it.
- It mounts only `Viewer` with the annotation toolstrip, `HtmlViewer` with pins, `DiagramViewer` (lazy) and the guide (`packages/inbox/guide/SurfaceGuideReader.tsx` behind `#surface-guide-reader`, lazy: the sections, then one `GuideSectionCard` per screen).
- No network: CSP `default-src 'none'`, `connect-src 'none'`; an HTML page's folder loads from the shell's `plannotator-asset:` scheme. The system face on Plannotator's tokens; settings live in memory; diffs unified and wrapped.
- The bridge: `packages/core/inbox-surface-bridge.ts` (re-exported by `inbox-types`), the surface's end in `packages/inbox/surface/bridge.ts`. The composer is the shell's: the viewers report drafts through ui's `onHostDraft` seams, and `commit_annotation` draws the saved one.
- Proof: `tests/e2e/surface.spec.ts`, Playwright WebKit against the built file and a compiled Inbox (in `inbox-e2e.yml`).

**Security**, on every request:
- The Host allowlist (`createRequestHostGuard({ localOnly: true })`).
- `/mcp` refuses any request with an Origin (403 `origin_not_allowed`).
- Connection routes (`/api/inbox/bridge/*`, `/api/inbox/control/stop`) take the registry's bearer token, a loopback Host naming this port, and no Origin.
- State-changing window routes run `isSameOriginOrNoOrigin` (403 `cross_origin`), then the `serverSession` stale-tab guard (409 `session_mismatch`).
- No CORS headers on the Inbox's routes. The one exception is annotate's asset route for an attached HTML page's folder.
- The window's CSP: `default-src 'self'`, inline script and style, `connect-src 'self'`, `frame-ancestors 'none'`, `base-uri 'self'`, `form-action 'none'`.
- Agent text reaches the page only through React and Plannotator's markdown renderer.
- The device door (`/api/inbox/device/*`): no Origin, the phone's bearer token, the allowlist (see "Phones"). The tailnet and the Wi-Fi reach only the door, each through its own listener (see "Local only by default").
- DAST (`.github/workflows/dast.yml`) scans a seeded Inbox on port 19435, the door's refusals included.

**Proofs.** Every proof runs under a temp data dir, against a real server, with no mocks.
- Server and store:
  - `packages/server/inbox.test.ts`: registry, health, port reuse and fallback, restart to update, every refusal, and the MCP through the SDK's own client, including a real 50 s `wait_for_reply`.
  - `packages/server/inbox-threads.test.ts`: the row model live.
  - `packages/shared/inbox/store.test.ts`: fast-check properties, including routing determinism against an independent oracle.
  - `apps/hook/server/inbox-cli.test.ts`: the subcommand as processes, the shim through the SDK's stdio client, and uninstall.
  - `packages/server/inbox-decisions.test.ts`, `inbox-attachments.test.ts` and `inbox-bridge.test.ts`.
  - `packages/server/inbox-devices.test.ts`: every pairing and door exchange of the mobile contract (7.1 to 7.25, 7.36, 7.37) replayed with real fetch against `plannotator inbox --background`, a phone's pick and Send reaching the agent's `wait_for_reply`, the refusals, a key replayed across a restart; on the compiled binary in the inbox-e2e job.
  - `packages/server/inbox-lan.test.ts`: the Wi-Fi listener on `plannotator inbox --background`: a phone (`tests/helpers/pinned-phone.ts`, which pins the certificate's SHA-256 and sends raw HTTP/1.1) pairs over the LAN address (7.2) by the QR's secret, while six digits there are `400 code_not_accepted_here` and still pair on the window's port; a wrong fingerprint is refused before a byte is sent; spoofed Host, Origin, encoded paths, an absolute-form request line and a WebSocket upgrade reach nothing outside the door; off and on again keep the port; a listener that cannot open at start turns off; the Bonjour record read back with `dns-sd -L` on macOS; off, a clean stop, a kill -9 and the next start; `openssl` failing. The certificate is made at run time, never committed. On the compiled binary in the inbox-e2e job.
  - `apps/relay/test/relay.test.ts`: the relay under `wrangler dev` with `plannotator inbox --background` pointed at it and a local HTTP/2 server playing Apple (it checks the ES256 provider token): a pairing makes the mailbox and registers the phone; a replayed registration changes nothing; the phone's relay switch reaches the device record over the socket; a question is one push (two questions one, news none, a guided review one) whose envelope the phone's key opens; Apple's 4096 bytes; no push with the switch off; no key, secret, subject or body in the Durable Object's storage; a 410 deletes the token; `hello` after a restart; a removed phone gone with what it held; the carriage (two phones, one with its switch off: the list, the thread, a pick and a Send as commands, the agent's `wait_for_reply` getting the answer; a replayed reply writing nothing; a down item reflected up refused; an attachment's view and a 1.4 MB HTML asset by request; the Inbox stopped with an answer queued, then started, the agent receiving it once; storage holding ciphertext only and empty after ack; ack by cursor; a revoked phone's items gone); `no_apns_key` and the creation brake on a relay without the key; a hostile peer in Apple's place (a 16 MiB frame and a body flood fail at once; a graceful GOAWAY still answers); Apple's real sandbox and production answering 403 InvalidProviderToken to a throwaway key (only with `RELAY_PROOF_APPLE=1`, which the workflow sets, so a local run works offline). Run from `apps/relay` (`bun test`), on the compiled binary in the relay workflow (`.github/workflows/relay.yml`).
  - `packages/core/crypto.test.ts`: the relay's keys and envelope against `packages/core/fixtures/inbox-relay-vectors.json` (all-zero inputs), which the app checks in Swift too.
- The window: Playwright 1.63.0 headless Chromium against the compiled binary (`bun run test:e2e:inbox`, `.github/workflows/inbox-e2e.yml`), with agents writing through `plannotator inbox mcp` (`scripts/inbox-sim.ts`):
  - `tests/e2e/inbox.spec.ts`
  - `inbox-decisions.spec.ts`
  - `notifications.spec.ts`
  - `inbox-attachments.spec.ts`
  - `inbox-guides.spec.ts`
  - `inbox-phones.spec.ts` (Pair a phone, the device list and Remove; Reach from this Wi-Fi with a pinned phone pairing over the LAN, the no-Bonjour note and `openssl` failing; with `PLANNOTATOR_E2E_TAILNET=1` on a Mac signed in to Tailscale, the door at the MagicDNS name on 8443)

  PNGs land in `.local/proof/`.
- The connections:
  - Claude Code: `apps/hook/hooks/mod/inbox.test.ts`, run by `.github/workflows/inbox-claude-code.yml`.
  - Pi: `apps/pi-extension/inbox.test.ts`, the real Pi in RPC mode, plus the 0.79.1 floor in `.github/workflows/inbox-pi.yml`.
  - OpenCode: `apps/opencode-plugin/inbox-v2.test.ts`, the packed plugin in the real `opencode2`, run by the "OpenCode 2 installed package" job in `test.yml`, plus `inbox.test.ts` for OpenCode 1.
  - All three use a scripted model endpoint (`tests/helpers/scripted-model.ts`) and a real Inbox (`tests/helpers/inbox-world.ts`).

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
| `/api/plan/revision`  | GET    | `{ revision, decided }` for a review that receives revised plans while open (see "Pi plan review does not block"). With `planRevisions: true` on the server options, `/api/plan` also carries `planRevision`; `/api/approve` / `/api/deny` refuse a stale `planRevision` with `409 { code: "plan_revised" }` |
| `/api/archive/plans`  | GET    | List archived plan decisions (`?customPath=`) |
| `/api/archive/plan`   | GET    | Fetch archived plan content (`?filename=&customPath=`) |
| `/api/done`           | POST   | Close archive browser (archive mode only)  |
| `/api/approve`        | POST   | Approve plan (body: planSave, agentSwitch, obsidian, bear, feedback, serverSession?; see "Stale-tab guard") |
| `/api/deny`           | POST   | Deny plan (body: feedback, planSave, answersOnly?, serverSession?). `answersOnly: true` (a boolean, nothing else) rides the decision so the consumer sends `plan.answered` instead of the denied prompt; see "Question blocks" |
| `/api/save-notes`     | POST   | Save to external note apps (Obsidian, Bear, Octarine) |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns `{ path, originalName }` |
| `/api/obsidian/vaults`| GET    | Detect available Obsidian vaults           |
| `/api/skills`         | GET    | List global agent skills for comment skill references (`{ skills: [{ name, root, description?, humanOnly, dir }] }`) |
| `/api/skills/content` | GET    | SKILL.md contents of one discovered skill for human-only feedback injection (`?name=<skill>`) returns `{ skill: { name, dir, path, content, truncated, humanOnly } }`; the name is matched against discovery only, never used as a path |
| `/api/reference/obsidian/files` | GET | List vault markdown files as nested tree (`?vaultPath=<path>`) |
| `/api/reference/obsidian/doc`   | GET | Read a vault markdown file (`?vaultPath=<path>&path=<file>`) |
| `/api/plan/vscode-diff` | POST   | Open diff in VS Code (body: baseVersion)   |
| `/api/doc`              | GET    | Serve linked .md/.mdx file (`?path=<path>`). When the hook reports the plan's own file (Claude Code's `planFilePath`, trusted only when its contents equal the plan), `/api/plan` advertises `planDir` and a request with `base=<planDir>` is also served from that directory, but only for paths that are exactly one of the plan's link targets (`[x](target)`, `[[target]]`, HTML `href`, ignoring links inside code; both sides compared with `?query`/`#fragment` dropped, percent-decoding and `./` collapsed, and the file served is the one that normalized target names; `resolvePlanLinkedDoc` in `packages/shared/doc-resolve.ts`) — other files there, such as other plans in `~/.claude/plans/`, stay unreachable. A linked file beside the plan shadows a project document of the same relative name; everything else resolves against the project roots exactly as without a base. Bun plan server only (Pi plans live under the project root) |
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
| `/api/external-annotations` | PATCH | Update fields on a single annotation (`?id=`). The body is allowlisted and field-validated by `validateAnnotationPatch` (`@plannotator/core/external-annotation`, both runtimes) with the SAME validators POST applies — `diagramAnchor` / `htmlAnchor` / `elementContext` / the target arrays through their own fail-closed parsers, `inReplyTo` through `validateReplyTarget`, the scalars by type and cap. A bad value is `400`, unknown keys are dropped, `id` and `source` stay immutable, and `null` clears an optional field but is refused on an anchor or a structural one |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |
| `/api/host/status` | GET | Host-only (see "Host session control" below): `{ kind: "plan", documents: [], unsentAnnotations, decided }`. A plan review has no host close (`POST /api/host/close` answers `409 { code: "not_closable" }`). |

### Review Server (`packages/server/review.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/diff`           | GET    | Returns `{ rawPatch, gitRef, snapshotId, origin, mode?, diffType, base, hideWhitespace, gitContext, agentCwd?, approvalNotesSupported, semanticDiff?, callFlow?, sections?, commitInfo?, generatedFiles?, baseBehindRemote? }`. `snapshotId` identifies this diff snapshot; the client echoes it on `/api/diff/fresh` probes (also returned by the switch/PR endpoints). `approvalNotesSupported` is the approve-with-notes capability advert (echoed on `/api/diff/switch`, `/api/pr-diff-scope`, and `/api/pr-switch` too, so it survives a diff switch); absent reads as false. `sections` is the since-base sidecar (Committed/Changes/Untracked partition); `commitInfo` is the commit-metadata sidecar (subject, markdown body, author + avatar) present only while a `commit:<sha>` (or jj `jj-commit:<commit id>`) diff is active; `generatedFiles` lists the repo-relative paths that count as generated, which the client collapses by default GitHub-style (presentation-only: the patch is never filtered). Two-layer detection (`packages/shared/generated-files.ts`, vendored to Pi): built-in name defaults (`DEFAULT_GENERATED_PATTERNS` — lockfiles like `bun.lock`/`package-lock.json`/`Cargo.lock`, plus `*.min.js`/`*.min.css`/`*.map`, matched against the path's last segment) apply in every mode with no git needed, and explicit `.gitattributes` `linguist-generated` refines them in BOTH directions via one batched `git check-attr --stdin` at the review cwd (set/true marks any file, unset/false un-marks even a built-in name, unspecified keeps the default). Attribute refinement runs for plain local Git sessions only — PR worktrees, workspace, jj, GitButler, P4, and piped patches get the name-based defaults alone; `baseBehindRemote` flags that the diff base is behind its remote tip. Workspace mode returns `mode: "workspace"` with folder-prefixed paths and no `gitContext`. |
| `/api/diff/switch`    | POST   | Switch diff type, base branch, or whitespace mode (body: `{ diffType, base?, hideWhitespace?, explicitBase? }` — `diffType` includes the `commit:<sha>` family, and `jj-commit:<commit id>` in a jj session). Also kicks off the rate-limited remote-default/staleness probe fire-and-forget (#1553): this endpoint backs the pickers AND the "Diff out of date · Refresh" button, so it is where a reviewer asks for a fresh answer. Fire-and-forget because a hanging remote must never make a diff switch wait — this response carries the cached `baseBehindRemote` and the next one carries the refreshed value. `explicitBase: true` marks a base the user picked from the picker — the server then honors it verbatim and permanently disables the bare-local-name → `origin/*` canonicalization for the session (echoed bases stay canonicalizable). Response includes `semanticDiff?`, `callFlow?`, `sections?`, `commitInfo?`, `generatedFiles?`, `baseBehindRemote?`, or `{ superseded: true }` when a newer concurrent switch has taken over (client ignores it). |
| `/api/commits`        | GET    | One page of the branch's linear `--first-parent` history for the Commits panel (`?limit=&before=`) → `{ commits, hasMore, base }`. Rows carry `isHead` / `isPastBase` (where the branch meets the active base) and best-effort author `avatarUrl`. Local git and jj sessions only (PR/workspace/GitButler/p4 → 400); computed against the active diff's cwd, so worktree sessions list the worktree's history. In a jj session the rail walks first parents from `@` (`isHead` = the working copy, `shortSha` = the short change id, `base` = the compare target's label) and clicks open `jj-commit:<commit id>`; a jj older than 0.33 (no `first_ancestors`) answers `500` with a message naming the version. |
| `/api/diff/fresh`     | GET    | Cheap staleness probe: recomputes the VCS fingerprint captured with the current diff snapshot and returns `{ fresh, fingerprint?, baseBehindRemote?, agentCwd? }`. Strictly **local**: it never contacts the git remote (#1553 — the client polls it every 5s, so the remote probe that used to hang off it made an idle session query the remote once a minute forever). `baseBehindRemote` is carried from the cached value refreshed by the other endpoints. Accepts `?snapshot=<id>` — the client echoes the `snapshotId` it received with its diff, and a mismatch with the server's current snapshot reports stale PER CLIENT (covers the startup base upgrade and cross-tab switches even when the VCS fingerprint matches). `baseBehindRemote` is carried on every response (omitting it would flicker the "behind GitHub" banner); `agentCwd` re-advertises the PR checkout in PR mode. Unfingerprintable modes (e.g. P4) always report fresh to a matching snapshot. Polled by the UI's "Diff out of date · Refresh" notice. |
| `/api/fetch-base`     | POST   | Runs `git fetch` for the base's remote tracking ref, then re-queries the remote tip (fresh `ls-remote`) so narrow-refspec fetches report honestly. Backs the "Baseline is behind GitHub · Fetch" banner. Git-only, base-relative diff types only. |
| `/api/semantic-diff`  | GET    | Runs semantic diff for the active patch and returns parsed sem output or an unavailable/error response (`?fileExt=` / `?fileExts=` optional). |
| `/api/call-flow`      | GET    | Runs snapshot-bound CallDiff analysis for the active Git review (`?snapshot=<id>` required). Returns bounded call trees, raw output, per-file impacts, and explicit skipped-language/file metadata for packs not yet installed. |
| `/api/call-flow/install` | POST | Starts or joins the selective install (`{ languageIds?: [...] }`; omission uses the current review's server-authored plan). The UI calls it automatically once per target per review session after Call flow consent; manual calls remain for Retry and install-ahead. The coordinator deduplicates/queues core and pack targets, a stale-tolerant data-dir lease serializes publication across server processes, Node >= 22 preflight runs before download, and the endpoint enforces the same-origin guard. |
| `/api/call-flow/install-status` | GET | Poll `{ state, stage?, languageIds?, currentLanguageId?, error?, reason? }` across `downloading` / `verifying` / `installing-deps` / `building`. |
| `/api/review-analysis` | GET / POST  | GET refreshes capability adverts without mutating settings; POST persists independent `{ semanticDiff, callFlow }` booleans and returns adverts. |
| `/api/file-content`   | GET    | Returns `{ oldContent, newContent }` for expandable diff context (`?path=&oldPath=&base=`) |
| `/api/review-image`   | GET    | One side of a changed image as raw bytes for the Before/After preview (`?path=&side=old\|new&snapshot=`; #1598). Serves only a file in the current patch whose chunk has no hunks and whose path is `png jpg jpeg gif webp svg avif bmp ico apng`; the old path is taken from the chunk, never the client. `Content-Type` is sniffed from magic bytes; every image response carries `nosniff`, `Content-Security-Policy: sandbox; …` and `Cross-Origin-Resource-Policy: same-origin`, plus `ETag` (304 on `If-None-Match`) and `X-Image-Width`/`X-Image-Height` when the header parses. Errors are JSON `{ reason, error }`: `400 unavailable\|bad-request`, `404 not-in-diff\|absent\|missing`, `409 stale`, `413 too-large` (10 MB per side or 50 megapixels), `415 not-image\|lfs-pointer`, `502 fetch-failed`. Advertised by `imagePreviewSupported` on every diff payload (false for static-patch and P4 sessions). |
| `/api/git-add`        | POST   | Stage/unstage a file (body: `{ filePath, undo? }`) |
| `/api/review-progress?snapshot=<snapshotId>` | GET/POST | Load or save durable viewed-file progress. GET returns `{ available, key?, fingerprints?, viewedFiles?, suppressedFiles? }`; POST takes `{ key, changes: [{ path, fingerprint, viewed }] }`. Stale snapshots return 409. |
| `/api/feedback`       | POST   | Submit review (body: feedback, annotations, agentSwitch, platform?, serverSession?). `platform: true` (boolean only) marks the status post the PR-platform path sends after `/api/pr-action`; it rides onto the decision, where the Claude Code mod logs it instead of starting a turn and OpenCode, Pi, CLI stdout and Amp deliver the status line verbatim without the request-changes suffix. Never infer it from empty `annotations` (see "Host result file") |
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
| `/api/external-annotations` | PATCH | Update fields on a single annotation (`?id=`). The body is allowlisted and field-validated by `validateAnnotationPatch` (`@plannotator/core/external-annotation`, both runtimes) with the SAME validators POST applies — `diagramAnchor` / `htmlAnchor` / `elementContext` / the target arrays through their own fail-closed parsers, `inReplyTo` through `validateReplyTarget`, the scalars by type and cap. A bad value is `400`, unknown keys are dropped, `id` and `source` stay immutable, and `null` clears an optional field but is refused on an anchor or a structural one |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |
| `/api/host/status` | GET | Host-only (see "Host session control" below): `{ kind, documents, unsentAnnotations, decided }`; counts only, never comment text |
| `/api/host/close` | POST | Host-only: the reviewer's Close marked `closedBy: "agent"`, KEEPING the draft; tells open tabs over the external-annotation SSE (`session-closed`) and answers `{ unsentAnnotations }`; `409 { code: "already_decided" }` once decided |
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
| `/api/guide/:jobId/export` | GET | Download a guide as one portable HTML file (`Content-Disposition: attachment`): live job ids resolve from the session's launch-time review (store fallback), `saved:{id}` from the store. 404 when the guide's diff was not retained (pre-portable envelopes). No size gate. `/api/guide/:jobId/export-info` returns `{ bytes, filename, languages }` for the same resolution. |
| `/api/guide/:jobId/share` | POST | Create a share link for a guide on the guide host (`resolveGuideShareUrl`; guide share hosting contract `adr/implementation/guide-share-hosting.md` §7). Body `{ public?: boolean, ttlSeconds?: number }`, every field optional and an empty body means the defaults: encrypted upload (the key lives only in the returned URL's `#key=` fragment; the host stores ciphertext) unless `public: true` stores the snapshot unencrypted so the hosted page can carry a title and `og:` tags. Resolves the guide exactly like `/export` (launch-time review, `saved:{id}` from the store). `200 { id, url, deleteToken, expiresAt?, bytes, recorded }` where `recorded` says whether the saved envelope now remembers `share: { id, url, createdAt, deleteToken, serviceUrl }` (false without an envelope, e.g. guide history off, in which case only the one-time token can remove the link). `400` bad body, `403 { error: "sharing disabled" }` when `PLANNOTATOR_SHARE=disabled` (also the same-origin guard as other mutating endpoints), `404` when the diff was not retained, `409 { error, url }` when the envelope already records a link (one link per guide: the record is the only place the token lives, so a second upload would orphan the first), `502 { error }` on a service failure (`GuideShareError`). |
| `/api/guide/:jobId/share` | DELETE | Remove the recorded share link: calls the host the record names (`serviceUrl`, never merely the currently configured share URL) with the stored delete token and clears the envelope record. `204`; `404` when no record; a host `404` (already expired or removed elsewhere) still clears the record; other host errors `502`. Same-origin guard. |
| `/api/guide/:jobId/share-info` | GET | `{ enabled, serviceUrl, existing?: { url, createdAt } }`: whether sharing is on (`resolveSharingEnabled`), which host links go to, and the link the saved envelope already records, so the UI can hide "Create share link" or offer Remove link. |
| `/api/guides` | GET | List persisted guides for the current repo: `[{ id, label, title, savedAt, progress: { reviewed, total }, moved }]` — `moved` flags a stored head sha that differs from the head currently under review |
| `/api/guides/:id` | DELETE | Delete a persisted guide. A recorded share link is removed from its host first, best effort: the envelope is the only copy of the delete token, so a host failure is logged with the manual `plannotator guide unshare` command and the delete still proceeds |
| `/api/guide/:jobId/output` | GET | Fetch a failed guide job's captured raw output for manual repair (404 if none captured) |
| `/api/guide/:jobId/submit` | POST | Manually submit corrected guide JSON for a failed job (body: `{ payload }`) |
| `/api/code-nav/resolve` | POST | Search for symbol definitions and references via ripgrep (body: `{ symbol, filePath, line, charStart, side, language? }`) |
| `/api/code-nav/hover` | POST | Token hover card resolution: the same body and the same guards as `/resolve`, over the same ripgrep search, returning one enriched definition (kind, approximate signature, heuristic doc comment, short preview), an optional runner-up candidate, and a five-reference sample. `backend: 'unavailable'` (rg missing) is a normal 200 and the client renders nothing. `source` is always `'search'` in Tier 0; the nullable `symbolKind` / `signature` / `doc` fields are what a later syntax- or index-backed tier would fill. Client-side the card is governed by two cookie-only settings (`packages/ui/config/settings.ts`, types in `@plannotator/core/token-hover`): `tokenHoverTrigger` (`hover` default / `modifier`, meaning the platform's primary modifier held, Cmd on macOS and Ctrl elsewhere via `isModKeyHeld` / `modEventKey` in `packages/ui/utils/platform.ts` / `off`, which withholds the handler props so the diff views wire no listeners at all) and `tokenHoverDelay` (150 / 300 default / 700 ms, the dwell before any request exists; 300 matches the VS Code hover delay). `tokenHoverTrigger` REPLACED the original `tokenHoverCards` boolean and re-reads its cookie as a migration on every load until the user touches the setting (`false` becomes `off`), never writing it back: a migrating read returns a value, so the registry's default-seeding write never fires, and resolution is pure and identical every time. Cmd rather than Alt because Alt is widely bound to push-to-talk dictation (an Alt gate would open cards while the user speaks) and because Cmd+hover is already VS Code's "tell me about this symbol" gesture; the navigable-target underline and the card under one held key is that composite gesture, not a collision, since `handleCodeNavRequest` dismisses the hover surface on every References invocation. Only the modifier ALONE arms: any other key while it is held (Cmd+C) disarms and closes, so a copy with the pointer parked on a token cannot pop a card. Both key branches read `composedPath()[0]`, not `event.target`, because a window-level listener sees the shadow HOST and Pierre's edit-session editor is a contenteditable inside that root; typing suppresses ARMING only, never disarming, and keyup carries no typing guard at all. The `pn-token-nav` affordance is the other half of the held-key gesture: the diff views paint it from the pointer enter event, and the hook additionally reports arm/disarm through `onModifierGate(armed, tokenElement)` so a key pressed over a parked pointer (and the release after it) paints and unpaints it too. `pn-token-hover` (underline plus a `cursor: pointer !important` that beats Pierre's I-beam) is painted by BOTH diff views, gated on a hover handler actually being wired, so `off` and the portable viewer get no affordance. Click behavior is untouched by the trigger setting, and the #1461 Alt+click References alias is unrelated. The stored value stays `modifier`: the setting names the shape of the gate, not which key fills it. |
| `/api/code-nav/file` | GET | Read file from working tree for code-nav preview (`?path=`) |

### Annotate Server (`packages/server/annotate.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/plan`           | GET    | Returns `{ plan, origin, mode: "annotate", filePath, sourceInfo?, gate, renderAs?, rawHtml?, previousPlan?, versionInfo?, diffCurrent?, diffHtml? }`. `renderAs` is `"markdown"`, `"html"`, or — for a whole-file diagram source (`.mmd`/`.mermaid`/`.dot`/`.gv`) — `"mermaid"` / `"graphviz"`, in which case `plan` is the file's RAW text and the editor renders it as one diagram block (see "Diagram files"). The decision is the pure, shared `annotateDiagramRenderKind` (`packages/core/annotatable.ts`), so a raw-HTML, converted, URL, folder, message or live-app session is never a diagram session in either runtime. The last four power the per-file version diff: `previousPlan`/`versionInfo`/`diffCurrent` for the markdown diff, `diffHtml` (the previous→current page rendered with inline `<ins>`/`<del>`) for `--render-html` files. A local rendered-HTML root is served from its CURRENT bytes on every read (`readRootHtml`), with the startup snapshot as the fallback when the file is missing, unreadable, or over the 2MB cap; when the served bytes differ from the snapshot, `previousPlan`/`versionInfo` still name the saved baseline and `diffCurrent`/`diffHtml` are recomputed against the served bytes (`htmlDiff` is pure; a GET never writes history), so a reload after an agent edit keeps the version diff. `/api/doc` carries the same recomputed `previousPlan`/`versionInfo`/`diffHtml` when it serves that root document (the in-app Refresh path, `rootHtmlVersionDiff`), and nothing extra for any other document. Live app sessions return `{ mode: "annotate-app", appUrl, targetUrl, liveToken, sharingEnabled: false, ... }` instead: no rawHtml, no version fields (see "Live app annotation"). A review of several files answers `{ mode: "annotate-bundle", plan: "", bundle: [{ path, renderAs }], projectRoot: <bundle root>, documentDrafts: true, ... }` (see "Several files in one review"). |
| `/api/plan/version`   | GET    | Fetch a specific stored version of the annotated file (`?v=N`) |
| `/api/plan/versions`  | GET    | List all stored versions of the annotated file |
| `/api/feedback`       | POST   | Submit annotations (body: feedback, annotations, serverSession?) |
| `/api/approve`        | POST   | Approve without feedback (review-gate UX, `--gate`) |
| `/api/exit`           | POST   | Close session without feedback (`?serverSession=` in the query; the body is empty) |
| `/api/save-notes`     | POST   | Save to external note apps (Obsidian, Bear, Octarine) |
| `/api/html-assets/<token>/<path>` | GET | Serve relative support assets for raw HTML annotation sessions, and the sibling `.html`/`.htm` documents an annotated page EMBEDS (`<iframe>`/`<embed>`/`<object>`/`<frame>`). The served page carries a `<base href>` pointing here, which is what makes relative URLs — including ones a script assigns at runtime — resolve against the document's own directory. HTML responses carry `Content-Security-Policy: sandbox allow-scripts` (no `allow-same-origin`, so an embed can never call this session's API) plus `nosniff`, and honour the 2MB annotate cap; a framed or `.html` failure renders a small 404 document naming the file rather than JSON or the app. See "Embedded local documents" under Annotation System. |
| `/api/share-html`     | GET    | Lazily prepare portable raw HTML for sharing (`?path=<html-file>` optional) |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns `{ path, originalName }` |
| `/api/doc`            | GET    | Serve linked .md/.mdx/.html file or code file (`?path=<path>&base=<dir>`). A diagram source carries the same `renderAs: "mermaid" \| "graphviz"` with its raw text as `markdown`, so folder navigation opens it in the diagram viewer too |
| `/api/doc/exists`     | POST   | Batch-validate code-file paths (body: `{ paths: string[], base?: string }`) |
| `/api/skills`         | GET    | List global agent skills for comment skill references (`{ skills: [{ name, root, description?, humanOnly, dir }] }`) |
| `/api/skills/content` | GET    | SKILL.md contents of one discovered skill for human-only feedback injection (`?name=<skill>`) returns `{ skill: { name, dir, path, content, truncated, humanOnly } }`; the name is matched against discovery only, never used as a path |
| `/api/draft`          | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes. A single local file is keyed by its content AND its path (see "Annotate drafts follow the file"); with the path copy in use a stale save answers `409 { ok: false, error: "stale draft generation", found, draftGeneration }`, and the client (`useAnnotationDraft`, default transport) adopts `draftGeneration` and saves once more above it. After the review is decided every save (any session kind, any generation) answers `409 { ok: false, decided: true, error, found, draftGeneration }`, which the client never retries |
| `/api/draft/document` | GET/POST | Per-document draft copies (local-file and folder sessions; `/api/plan` advertises `documentDrafts: true`): GET `?path=<abs>` returns `{ found, annotations, globalAttachments }` (404 when none, 400 when the path is not an existing regular file, 403 outside the session's roots or for a single-file session's own file, symlink aliases included); POST `{ documents: [{ path, annotations, globalAttachments? }] }` returns `{ ok, written, rejected? }`, an empty list clears that copy, and `409` after a decision |
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
| `/api/external-annotations` | PATCH | Update fields on a single annotation (`?id=`). The body is allowlisted and field-validated by `validateAnnotationPatch` (`@plannotator/core/external-annotation`, both runtimes) with the SAME validators POST applies — `diagramAnchor` / `htmlAnchor` / `elementContext` / the target arrays through their own fail-closed parsers, `inReplyTo` through `validateReplyTarget`, the scalars by type and cap. A bad value is `400`, unknown keys are dropped, `id` and `source` stay immutable, and `null` clears an optional field but is refused on an anchor or a structural one |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |
| `/api/host/status` | GET | Host-only (see "Host session control" below): `{ kind, documents, unsentAnnotations, decided }`; counts only, never comment text |
| `/api/host/close` | POST | Host-only: the reviewer's Close marked `closedBy: "agent"`, KEEPING the draft; tells open tabs over the external-annotation SSE (`session-closed`) and answers `{ unsentAnnotations }`; `409 { code: "already_decided" }` once decided |

All servers use random ports locally or fixed port (`19432`) in remote mode.

**Stale-tab guard (`serverSession`).** Because a port can be reused (a fixed `PLANNOTATOR_PORT`, remote mode's `19432`, a rare random-port collision), a tab left open on an old session could post its decision to a NEW server on the same address and approve a document it never showed. Every plan, annotate and review server (Bun and Pi) therefore issues one random `serverSession` nonce per process (`packages/core/server-session.ts`, vendored to Pi) and advertises it on `/api/plan` and on every diff payload (`/api/diff` and the switch/PR endpoints, beside `approvalNotesSupported`). The client (`packages/ui/utils/serverSession.ts`) echoes it on every decision: `serverSession` in the body of plan `/api/approve` + `/api/deny`, annotate `/api/approve` + `/api/feedback`, review `/api/feedback` (the platform status post included), and as `?serverSession=` on `/api/exit` (whose body is empty). A server holding a DIFFERENT nonce answers `409 { code: "session_mismatch", error }` before it claims or settles anything, and the tab shows `ServerSessionReplacedBanner` ("This review was replaced — reload"). A decision WITHOUT the field is accepted, so an older client (and any host posting decisions by hand) keeps working; only a present, different nonce is refused. `/api/pr-action` (which posts the review to GitHub, GitLab or Bitbucket) carries the nonce in its body too and is guarded the same way in both runtimes: a mismatch posts nothing and the tab shows the same banner.

### Host allowlist (every request)

Every plan, review, annotate (archive and goal-setup included, and the servers OpenCode embeds) server, and the Plannotator Inbox (always the local rule: `createRequestHostGuard({ localOnly: true })`), checks the request's `Host` header BEFORE any route, in both runtimes: the app HTML, every API and every WebSocket upgrade. The rule is one pure predicate, `isAllowedRequestHost` in `packages/shared/request-host.ts` (vendored to Pi); the adapters are `packages/server/request-host-guard.ts` (Bun, first lines of each `fetch`) and `apps/pi-extension/server/request-host-guard.ts` (node:http, first line of each handler, plus an `upgrade` interception, because node:http hands an upgrade to every `upgrade` listener, such as the annotate agent terminal's). Why: `isSameOriginOrNoOrigin` compares Origin with Host, which cannot tell the session's own page from a page served under another DNS name that resolves to this machine (both carry matching Origin and Host), and most GETs had no check at all. IP literals and loopback names cannot be re-pointed by DNS, so the allowlist is built from them:

- **Every mode:** loopback names: `localhost`, `*.localhost`, `127.0.0.0/8` literals, `[::1]` (`isLoopbackHostname`).
- **Remote mode** (`PLANNOTATOR_REMOTE` / SSH, wide bind): also any IPv4 or IPv6 literal (LAN or container address), the configured urlHost (`auto` resolved through the same cached Tailscale lookup the advertised URL uses), and this machine's `os.hostname()` (full name, first label, and `<first label>.local`, the mDNS name another LAN device types, which `os.hostname()` omits on Linux and often on macOS; mDNS answers on the local link only, so it cannot be pointed here from outside the network). These names are resolved lazily, on the first request that is neither loopback nor an IP literal.
- **`--tailscale`** (local mode, Bun CLI only): `tailscale serve` forwards the browser's own Host (the MagicDNS name; for TCP backends it sets `r.Out.Host = r.In.Host`), so `enableTailscaleServe` registers the serve URL's hostname with `allowServedHostname` once serve reports it (not for the Inbox's persisted mapping, which points at a door-only listener that reads no Host).
- **Browser IDE port proxies** (every mode): code-server and Coder set `VSCODE_PROXY_URI`; when its HOSTNAME holds the `{{port}}` template (`https://{{port}}--main--ws--me.coder.example.com/`), the per-port hostname (`<digits>` in the template's place, nothing else) is allowed (`forwardedPortHostPatterns`). Such a proxy reaches the loopback-bound server and forwards its own Host. The value comes from the environment the IDE started and names the IDE's own proxy domain, never a request. A path-based template (`./proxy/{{port}}/`) adds nothing. GitHub Codespaces and VS Code dev tunnels need no rule: their forwarders present `Host: localhost:<port>` (the browser's name rides in `X-Forwarded-Host`, which is never read). No provider domain (`.app.github.dev`, `.gitpod.io`, `.devtunnels.ms`) is built in: the forwarders that matter present loopback, and a blanket suffix would admit every other tenant's forwarded hostname for no gain.
- **`PLANNOTATOR_ALLOWED_HOSTS`**: extra names (a `:port` on an entry is ignored), `.suffix` entries, or `*` (off). See the env table.
- **No Host header** (an HTTP/1.0 non-browser client): allowed; browsers always send one. A malformed Host is refused.
- **The port is never compared.** Forwarded ports legitimately arrive with another port (`ssh -L 8080:localhost:19432`, VS Code / devcontainer auto-forwarding to a loopback-bound server when the local port is taken, `docker -p`), and a foreign name is refused by its hostname alone. The VS Code cookie proxy rewrites Host to the upstream's `localhost:<port>`, a loopback name. The narrower loopback-AND-port checks of the pull bridge and host control stay as they were, behind this one.
- **Refusal:** `403`, `text/plain`, `X-Plannotator-Error: host_not_allowed`, a one-paragraph body naming the hostname (only when it parses as one) and `PLANNOTATOR_ALLOWED_HOSTS`; never a 404, so it cannot be mistaken for the app catch-all.

Not covered, by design: the live-app proxy (`live-proxy-core.ts` has its own Host, Origin and WebSocket-origin checks), the compiled build's agent-terminal Node sidecar (`agent-terminal-node-sidecar.mjs`: bound to `127.0.0.1` on a port only the Bun server learns, never sent to the browser, and served only under the session's random-token PTY path; the browser's upgrade reaches the guarded annotate server first), the paste service (a public service, not a session) and the guides.show local static dev server (serves build output only). Tests: `packages/shared/request-host.test.ts` (the predicate), `packages/server/request-host.scenarios.ts` run by `packages/server/request-host.test.ts` (Bun, plus goal setup and the tailnet name) and `apps/pi-extension/server/request-host.test.ts` (Pi), and `apps/pi-extension/server/request-host-guard.test.ts` (the upgrade interception).

### Inbox Server (`packages/server/inbox.ts`)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/` | GET | The window (`htmlContent`, the embedded `inbox.html`), with its CSP |
| `/favicon.png` | GET | The window's icon (`handleFavicon`) |
| `/api/inbox/health` | GET | `{ ok, app: "plannotator-inbox", version, serverSession, pid, update }`: liveness for the registry readers |
| `/api/inbox/threads` | GET | The list model, a row per thread: `{ serverSession, version, cursor, update, notice, projects: [{ ...project, threads, unread }], project, sections: [{ id, label, threads: [row] }] }`. All six sections, in order, empty ones included. A row is the thread summary (Workspaces' question counts `open`, `picked`, `stopped`, `holds_up`, `prompt`; `waiting_on_person`) plus `project: { id, name }`, `thread_name`, `section`, `unread`, `answered_not_sent`, `waiting_since`, `unseen`, `sent: { at, checked_at } \| null`. `?project=prj_…` keeps the sections and drops other projects' rows (`422` malformed, `404` unknown) |
| `/api/inbox/projects` | GET | The sidebar's folders: `{ serverSession, cursor, projects: [{ id, key, name, root, created_at, threads, unread }] }` |
| `/api/inbox/threads/:id` | GET | `{ serverSession, cursor, thread }`: every message, each with its `questions` (Workspaces' `Question` wire plus `message_id`), and the thread's `thread_name` |
| `/api/inbox/threads/:id/seen` | POST | `{ serverSession? }`: the person looked at the thread; its agent messages so far leave "New since you looked". Writes nothing when nothing is new. Returns `{ thread: row }` |
| `/api/inbox/threads/:id/sessions` | GET | New message: the live agent sessions of the thread's project, `{ home, project, sessions: [{ session, host, started_at, last_seen_at, busy, idle_since, wrote_thread }] }`, the thread's writers first (latest writer first), then by start |
| `/api/inbox/threads/:id/message` | POST | New message: `{ serverSession?, session, body, idempotency_key }` writes the person's words to that live session (`to` on the message); same-origin and `serverSession` guards; `409 session_not_live` when the session is not live (nothing written); a replayed key answers the message it wrote |
| `/api/inbox/events` | GET (SSE) | `event: record` per store line (`id:` = seq) after `?cursor=` / `Last-Event-ID` (replay first, then live), `event: status` for restart-to-update, a heartbeat every 15 s |
| `/api/inbox/messages/:id/picks` | POST | Save picks at once: `{ serverSession?, questions: [{ key, revision, answer or null }] }` |
| `/api/inbox/messages/:id/reply` | POST | The person's Send: `{ serverSession?, idempotency_key, words?, questions?: [{ key, revision, answer? }], feedback?, annotation_ids? }` (the annotations' feedback text is appended after the answers; the named annotations are marked sent) returns `{ reply, questions, replayed }` |
| `/api/inbox/messages/:id/guide` | GET | The guided review a message carries: `{ message_id, guide, snapshot }` (the snapshot as validated and stored); `404 guide_not_found` when it carries none |
| `/api/inbox/messages/:id/guide/reviewed` | POST | `{ serverSession?, reviewed: boolean[] }`: the person's reviewed ticks on that guide, kept on the message (`guide_reviewed`); same-origin and `serverSession` guards; `422` not a list of booleans, `404` no such message or no guide |
| `/api/inbox/messages/:id/resolve` | POST | `{ serverSession?, resolved? }`: resolve or reopen the thread |
| `/api/inbox/settings` | GET | What Settings and the connect snippets read: `{ serverSession, version, port, url, mcp_url, mcp_command, home, data_dir, inbox_tool: { hosts: { claude-code, pi, opencode }, env }, notifications: { enabled, dismissed, allowed_origin }, store: { dir, bytes, projects: [{ id, name, root, bytes, threads: [{ thread_id, subject, bytes }] }] } }` |
| `/api/inbox/settings` | POST | `{ serverSession?, inbox_tool?: { <host>: boolean }, notifications?: { enabled?, dismissed?, allowed_origin? } }` (one of the two required): saves `inboxTool` per host (the hosts not named keep their value) and/or `inboxNotifications` into config.json, and answers `{ inbox_tool, notifications }`; same-origin and `serverSession` guards; `500 config_not_saved` when the file did not change |
| `/api/inbox/restart` | POST | `{ serverSession? }`: the window's Restart. Stops listening and calls `onRestartRequested` (the command starts the binary on disk); `409 restart_unavailable` without one. Same-origin and `serverSession` guards |
| `/api/inbox/bridge/poll` | POST | Connection route (token, loopback Host, no Origin): `{ session, host?, waitMs? }` returns `{ commands: [{ type: "reply", id, thread_id, reply_to, subject, body, url }] }`, the person's replies waiting for that agent session; held up to 25 s when there are none |
| `/api/inbox/bridge/event` | POST | Connection route: `{ session, host, type: "delivered", id }` records that the reply or New message reached the session as a turn (`delivery` on it, the thread read by the agent; `422` for another session's); `{ session, host, type: "state", busy }` reports a turn starting or ending, for New message's live sessions |
| `/api/inbox/control/stop` | POST | Connection route: the bearer token from `inbox.json`, a loopback Host with this port, no Origin. Stops the Inbox (uninstall --purge) |
| `/mcp` | POST | MCP, stateless; any Origin refused |
| `/api/inbox/threads/:id/attachments` | GET | `{ serverSession, attachments: [state], annotations }`: each attachment record with `message_id`, `current: { sha256, size, mtime } \| null`, `changed_since_sent`, `unavailable: { code, message } \| null`, and the thread's annotations waiting for a Send |
| `/api/inbox/attachments/:id` | GET | The current file's bytes by id (`?version=sent`: the sent blob), always `text/plain`, CSP `sandbox`. `404 attachment_not_found` / `attachment_missing`, `409 attachment_changed_type`. No route takes a path |
| `/api/inbox/attachments/:id/view` | GET | `{ attachment, version, text, html }`: one version's text (`version` is `current` or the sent sha256, the annotations' key); for HTML, `html` is the page with its `<base href>` at its folder's asset route |
| `/api/html-assets/<token>/<path>` | GET | Annotate's asset route (`resolveHtmlAssetRoute`) for the folder of an attached HTML page |
| `/api/inbox/annotations` | POST | `{ serverSession?, attachment_id, version, annotation }`: save a new annotation or edit one still waiting (`409 annotation_closed` once sent or removed) |
| `/api/inbox/annotations/:id/remove` | POST | `{ serverSession? }`: remove one still waiting |
| `/api/inbox/threads/:id/delete` | POST | `{ serverSession? }`: delete the thread and the blobs no other record uses; returns `{ ok, store }` |
| `/api/inbox/projects/:id/delete` | POST | `{ serverSession? }`: delete the project's folder and its unused blobs; returns `{ ok, store }` |
| `/api/inbox/pairing` | POST | `{ serverSession? }`: open the one pairing offer, `201 { offer: { code, expires_at }, link, computer: { name }, addresses: { tailnet, lan, fingerprint } }` (mobile contract 7.1) |
| `/api/inbox/devices` | GET | `{ devices: [{ id, name, platform, created_at, last_seen_at, revoked_at, carriage }] }`: the paired phones not revoked, newest first |
| `/api/inbox/devices/:id/revoke` | POST | `{ serverSession? }`: remove a phone, `{ device }`; `404 device_not_found` |
| `/api/inbox/tailnet` | GET / POST | `{ tailnet: { on, address, error } }`; POST `{ serverSession?, on }` switches "Reach from my tailnet" (`409 tailnet_port_taken`, `409 tailnet_unavailable`) |
| `/api/inbox/lan` | GET / POST | `{ lan: { on, address, fingerprint, bonjour, error } }`; POST `{ serverSession?, on }` switches "Reach from this Wi-Fi" (`409 lan_unavailable` when `openssl` cannot make the certificate) |
| `/api/inbox/device/*` | GET / POST | The phone door: `pair` (no token), `revoke`, and the allowlist mapped onto the routes above (see "Phones" and `adr/implementation/inbox-mobile.md` section 2) |

### Host session control

`GET /api/host/status` and `POST /api/host/close` (`packages/shared/host-control.ts`,
vendored to Pi; Bun adapter `packages/server/host-control.ts`, Pi adapter
`apps/pi-extension/server/host-control.ts`) let the agent session that launched a
review ask what it holds and close it. Guarded exactly like the pull bridge: a
loopback Host naming the server's port (`403`), no `Origin` (`403`), and
`Authorization: Bearer <token>` (`401`), the launch's `PLANNOTATOR_SESSION_BRIDGE_TOKEN`
(Bun default; servers also take `hostControlToken`). Without a token the paths answer
`404 { error: "Not found", code: "host_control_disabled" }` (`HOST_CONTROL_DISABLED_CODE`),
which a host reads as "turned off" rather than "an older Plannotator" (an uncoded `404`);
they are off in remote mode, and
`--tailscale` discards the env token. Unlike the pull bridge they still answer under
`PLANNOTATOR_AI=disabled` (closing a review is not an AI feature). Once a session is
decided (a host close included), the review servers refuse a late `/api/feedback` or
`/api/exit` with `409` (both runtimes, like annotate), so a tab still open after the
close neither deletes the kept draft nor gets an ok for feedback nobody receives.
Close settles the decision as `exit` with
`closedBy: "agent"` and `unsentAnnotations` (no draft delete, no feedback-archive
record: the reviewer decided nothing), broadcasts `{ type: "session-closed", by:
"agent", unsentAnnotations }` on the external-annotation stream (`broadcast` on both
runtimes' handlers; `useExternalAnnotations`'s `onSessionClosed`), and the CLI's
host result record carries the same `closedBy` / `unsentAnnotations` on its
`dismissed` record. Every server result also exposes `hostControl` (`status()`,
`close?()`) for hosts that run the server in-process (Pi, the OpenCode 2 embedded
plan server). Plan servers implement status only. A host that calls the endpoints
over HTTP reads the answers with `classifyHostCloseAnswer` / `readHostStatusAnswer`
from the same shared module (the OpenCode 2 tool); the Claude Code mod keeps its own
copy of that rule because a hooks module imports only its own folder.

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

## Feedback Archive

Every review submitted through a Plannotator decision is durably archived at
decision-settlement time, so a submission survives an agent-side timeout, a
closed terminal, or a `planSave` setting the user turned off. One deliberate
exception: a review posted straight to GitHub, GitLab or Bitbucket with `POST
/api/pr-action` is delivered to the platform and is **not** archived locally
yet (a named follow-up). Layout, per project (same `{project}` key as
`history/`):

```
${PLANNOTATOR_DATA_DIR}/feedback/{project}/
  index.jsonl                                  # append-only, authoritative, schema v1
  records/2026-08-31T14-22-07-511Z-review-feedback.md   # human-readable sidecar
```

The JSONL line is self-contained (`v`, `ts`, `client`, `clientVersion?`,
`project`, `origin`, `surface`, `decision`, `target`, `feedback`,
`annotations`, `counts`, `recordFile`) so an analyzer never has to open a
sidecar; the markdown sidecar exists because the rest of the data dir is
greppable markdown and is written only for records that carry content. Bare
approvals, LGTMs, and dismissals are decision-only lines with no sidecar.

**This index is shared, not Plannotator-private.** Several tools that share the
data dir append to the SAME `feedback/{project}/index.jsonl`, separated by the
`client` field on each line rather than by separate files. Known writers today:
`plannotator` (this repo) and `plannotator-tui`, the Rust terminal client;
`herdr-annotate` is reserved for a possible future Lite writer. Treat `client`
as an open set, never an enum to validate against. Practical consequences: the
line shape is a cross-tool contract, so fields are **added, never repurposed**;
other clients suffix their id onto their sidecar filenames
(`{stamp}-{surface}-{decision}-plannotator-tui.md`), so the `records/`
directory holds more filename shapes than this repo writes and `recordFile` is
the only valid handle to a sidecar (nothing may parse the name); and unknown
fields must be ignored rather than rejected.

Two optional fields are declared in v1 but not populated here, so their names
are reserved across every client: `target.agent` (`{ host?, session?,
transcript? }`) is the provenance for surfaces whose subject is an agent
session rather than a file or a diff, such as annotate-last, and
`clientVersion` is the writing client's own version where it knows it
(`packages/shared` has no runtime-agnostic version constant, so this repo
leaves it unset rather than reading `package.json` from a vendored module).

Everything is written by one shared module, `packages/shared/feedback-archive.ts`
(vendored to Pi as `apps/pi-extension/generated/feedback-archive.ts`), which
resolves the data dir per call and **never throws**: a failed archive write is
logged, degrades silently for the user, and keeps the annotation draft as the
recovery copy. The append happens BEFORE `deleteDraft`, generalizing the #678
ordering to every surface. Call sites: `packages/server/index.ts`
(`/api/approve`, `/api/deny`), `packages/server/review.ts` (`/api/feedback`,
`/api/exit`), `packages/server/annotate.ts` (`persistSubmittedDecision`,
`/api/exit`), and the three Pi mirrors in `apps/pi-extension/server/`.

Invariants worth keeping: records never contain patch bytes or a second copy of
the plan (identity and a version-file reference instead); repeat decisions
append rather than overwrite (unlike the legacy `plans/` snapshot, which is
keyed by slug and status and is left alone); annotation `source` / `author`
provenance is preserved so external, agent, and WebMCP findings stay
distinguishable from the human's own comments; and `feedback` is listed in
`PURGE_OWNED_TOP_LEVEL` (`packages/server/uninstall.ts`) so uninstall purge
removes it. Controls and the privacy/retention note are in the
`PLANNOTATOR_FEEDBACK_HISTORY` row of the environment table above. The read
path in v1 is the files on disk (`jq` over `index.jsonl`, `grep` over
`records/`); there is no CLI reader or UI surface yet.

Details that surprise people:

- **Index durability is a practical guarantee, not a formal one.** One record
  is always exactly one line, and the whole line is handed to a single
  append-mode write. That write is not one syscall (`appendFileSync` loops
  internally until its buffer is drained); what holds in practice is that an
  `O_APPEND` write of a line-sized buffer completes without interleaving on a
  local filesystem. NFS and SMB do not promise even that, and a genuine
  interleave damages **both** records that raced, not just the later one. The
  backstop is the reader: unparsable lines are skipped, so everything else in
  the file still reads. With several clients writing one index, this caveat is
  worth knowing rather than assuming away.
- **Readers gate on structure, not version.** `parseFeedbackIndex` keeps any
  line that parses and carries a numeric `v`, so a newer writer's lines are
  still returned; an analyzer that depends on v1 semantics should filter
  `v <= 1` itself. Since fields are only added and never repurposed, a `v2`
  would signal a real shape change rather than the arrival of new keys.
- **Folder-session records name the folder, not the open document.** A folder
  annotate session submits one body of feedback for the session, so
  `target.filePath` is the session's folder. The record's `annotations` hold
  every document's comments (not only the open one's), and each comment made
  on a document other than the session's own target carries the additive
  `documentPath` field naming that document (absent means the session's own
  target or message; distinct from `file`, a code annotation's file).
- **Records of a review of several files name every file.** Surface
  `annotate-bundle` (additive), no `target.filePath`, and the additive
  `target.documents: [{ path, annotationCount }]` in review order; every
  comment on a file carries its `documentPath`.
- **URL-session records store the full URL, query string included**, because
  that is the page that was reviewed. A URL carrying a token in its query is
  therefore written to disk; the opt-out is the control for that.
- **`target.review.cwd` is provenance, not a durable handle.** A PR review
  started with `--local` records a per-PR pool checkout that is cleaned up when
  the session ends; `target.review.pr` plus `gitRef` are the identity that
  survives.
- **Project bucketing prefers the caller's `project` option** (the `project`
  field on `ReviewServerOptions`, mirroring the annotate server), falling back
  to deriving a name from the review cwd. The fallback is wrong in PR mode,
  where there is no `gitContext` and `--local` points `agentCwd` at
  `pool/pr-<n>`, so every CLI entry point passes `detectProjectName()`.
- **The test suite turns the archive off** through the `tests/setup/feedback-archive-off.ts`
  preload in `bunfig.toml`, because most server tests boot a real server
  without redirecting `PLANNOTATOR_DATA_DIR` and would otherwise write into the
  contributor's own data dir. Tests that need the archive opt back in inside
  their own test bodies.

## Plan Diff

When a user denies a plan and Claude resubmits, the UI shows what changed between versions. A `+N/-M` badge appears below the document card; clicking it toggles between normal view and diff view.

**Diff engine** (`packages/ui/utils/planDiffEngine.ts`): Uses the `diff` npm package (`diffLines()`) to compute line-level diffs. Groups consecutive remove+add into "modified" blocks. Returns `PlanDiffBlock[]` and `PlanDiffStats`.

**Three view modes** (toggle via `PlanDiffModeSwitcher`; `planDiffMode` in `packages/editor/App.tsx` defaults to `classic`):
- **Classic** (`PlanCleanDiffView`, block-level, old above new): Color-coded left borders — green (added), red (removed/strikethrough), yellow (modified). The default.
- **Rendered** (`PlanCleanDiffView` with `wordLevel`, experimental): the same view with word-level inline highlighting.
- **Raw** (`PlanRawDiffView`): Monospace `+/-` lines, git-style

**State** (`packages/ui/hooks/usePlanDiff.ts`): Manages base version selection, diff computation, and version fetching. The server sends `previousPlan` with the initial `/api/plan` response; the hook auto-diffs against it. Users can select any prior version from the sidebar Version Browser.

**Diff annotations:** The clean diff view supports block-level annotation — hover over added/removed/modified sections to annotate entire blocks. Annotations carry a `diffContext` field (`added`/`removed`/`modified`). Exported feedback includes `[In diff content]` labels. A diff annotation's `blockId` is `diff-block-N` (N indexes the diff against the selected base, not a document block), so the export cannot place it in the document: diff comments print together AFTER the document's other comments, in diff order (`sortAnnotationsInDocumentOrder` in `packages/ui/utils/parser.ts`); a document with no diff comments sorts exactly as before.

**Annotation hook** (`packages/ui/hooks/useAnnotationHighlighter.ts`): Annotation infrastructure used by `Viewer.tsx`. Manages web-highlighter lifecycle, toolbar/popover state, annotation creation, text-based restoration, and scroll-to-selected. The diff view uses its own block-level hover system instead.

**Sidebar** (`packages/ui/hooks/useSidebar.ts`): Shared left sidebar with three tabs — Table of Contents, Version Browser, and Archive. The "Auto-open Sidebar" setting controls whether it opens on load (TOC tab only). In archive mode, the sidebar opens to the Archive tab automatically.

## Portable Guided Reviews

Decision record: `adr/decisions/007-portable-guided-reviews-20260815.md`; spec: `adr/implementation/portable-guided-reviews.md`.

A guide exports as ONE small HTML file (size ≈ the diff, never the app) that pins a specific viewer build on `guides.show` (`viewer.<hash>.js/.css` + SRI). Format lives in `@plannotator/core/guide-format` (versioned strict snapshot, `createGuideHtml`, fixtures + a compatibility test that must keep parsing every shipped fixture); the pinned build is the generated `@plannotator/core/guide-viewer-manifest` (regenerate with `bun run --cwd apps/guides-show build:viewer && bun run --cwd apps/guides-show sync:manifest`; CI fails if stale).

Invariants: the diff a guide describes is captured when the guide job LAUNCHES (`buildCommand`'s `launchReview`, carried server-side like `changedFilesSnapshot` — never on the SSE-broadcast `AgentJobInfo`) and stored beside the saved guide as `{id}.patch` (patch written before the envelope that references it; deleted together). Exports never read the on-screen diff. `/v1/` on guides.show is add-only (content-hashed, never overwritten or deleted) so exported files keep opening; the viewer is the same guide chain (`@plannotator/guide-viewer`) over `AllFilesCodeView` in `readOnly` mode — no drift by construction. Read-only hosts stub the annotation composer/popovers at build time (`apps/guides-show/build/read-only-stubs-plugin.ts`); do not add app-only surfaces to the guide chain without going through the `GuideHost` contract.

Viewer runtime invariants (`apps/guides-show/viewer/`): the highlight worker is fetched from guides.show and constructed locally, and HOW is decided by a live probe (`portablePool.tsx`: blob classic → blob module → data classic → data module; a one-line worker must answer), never by `location.protocol` — Chrome refuses blob *module* workers from `file://` asynchronously (its console says "cross-origin redirects of the top-level worker script") but accepts classic ones, and headless checks with `--allow-file-access-from-files` hide that, so test `file://` exports WITHOUT that flag. The worker bundle must stay import-free (`check-budgets` asserts it) so it can run as a classic worker. A pool that is not initialized within 4 s is dropped (`PoolWatchdog`) and the guide re-renders on the main thread; Pierre renders nothing while waiting on a pool whose workers died, so this is what keeps diffs from going blank. The exported document's plain-text fallback article is opacity 0 for the first 2.5 s (CSS-only reveal), so a cold viewer download shows the theme ground, then the guide skeleton, then the guide — never a flash of the fallback prose. The portable page must not set `overflow` on `body`/`html`: `GuideViewportManager.findScrollRoot` walks up for an `overflow-y: auto|scroll` ancestor to use as its IntersectionObserver root + scroll-event source, and an overflow on body propagates to the viewport without body itself scrolling — the manager would observe a never-scrolling element, mark everything "near", rank by distance from the middle of the whole document, and CodeViews would only mount on hover (`requestMount`). The manager now treats body/html as the window regardless, but keep the CSS clean too.

Three producers share the one pure export (`createGuideHtml`): the in-app **Download portable guide** button, `plannotator guide export --id <saved>`, and the agent path `plannotator guide export --guide guide.json --patch guide.patch` (`packages/server/guide/guide-cli.ts`, `buildAuthoredGuideSnapshot`) used by the standalone `plannotator-guide` agent skill (its own repo, `plannotator/guides` — deliberately NOT part of this repo or its installers). The authored form takes the same `{ title, intent, sections, unplacedFiles? }` shape the in-app generator emits plus optional `review { gitRef, base }`, `source`, `generator`; it is STRICT where the in-app validator is lenient (a file not in the patch, or placed twice, is an error listing the patch's files — exit 1 — rather than a silently dropped chapter), fills `source` from git in cwd (`origin` → owner/repo, branch, head sha) unless the guide supplies one, and round-trips the built snapshot through the strict format parser so a bad `source`/`generator` fails at export time. `--patch -` reads stdin. The skill's worked example is the `AUTHORED` fixture in `guide-cli.test.ts` — keep them in step.

### Hosted share links (guide share hosting)

Contract: `adr/implementation/guide-share-hosting.md` (names, routes, shapes and error codes there are final; change them there first). A guide can also be shared as a link on a guide host instead of a downloaded file: the review header's Share menu offers **Download portable guide** (unchanged) and **Create share link**; the CLI has `plannotator guide share --id <saved> | --guide g.json --patch p.patch | --snapshot s.json [--public] [--ttl 7d|24h|30m|3600] [--json]` (stdout: the URL, or `{ id, url, deleteToken, expiresAt? }` with `--json`; stderr: the size and the exact `Delete with: plannotator guide unshare <id> --token <t>` line) and `plannotator guide unshare <id> --token <t>` (removal goes to the host a saved guide's record names, else `PLANNOTATOR_GUIDE_SHARE_URL` / `guideShareUrl`). `--id` refuses with exit 1 while the saved guide already records a link. Exit codes match `export` (0 / 1 not found, invalid, service error / 2 usage). The upload itself is `shareGuide` / `unshareGuide` in `packages/server/guide/guide-share.ts` (vendored to Pi as `apps/pi-extension/generated/guide-share.ts`; both review servers expose the same `/share`, `/share-info` and `DELETE /share` endpoints). No upload ever happens without the Create click or the CLI command.

Two modes, encrypted by default. **Encrypted** stores `encrypt(await compress(snapshot))` (the same `@plannotator/core/crypto` + `@plannotator/core/compress` pair plan share links use); the key is generated by the uploader and lives ONLY in the URL fragment (`#key=<key>`, `GUIDE_SHARE_KEY_PARAM`), which browsers never send to the server, so the host holds ciphertext it cannot read and the page it serves is a shell that fetches `/api/g/<id>` and decrypts in the browser. **Plain** (`--public` / "Allow link previews", `{ public: true }`) stores the snapshot JSON (validated server-side with `parseGuideSnapshotJson`) so the hosted page can carry `<title>`, `og:*` and the guide text; use it when a chat app should unfurl the link. Both modes cap the stored body at `MAX_SHARED_GUIDE_BYTES` (25 MiB; `413`), have no expiry unless `ttlSeconds` (CLI `--ttl`) sets one, and return a one-time `deleteToken` (16 random bytes base64url, stored as a hex SHA-256) that is the only way to remove the guide besides the saved-envelope record.

Where it lives: `apps/guides-show/share/` (`core/handler.ts` is the pure request handler, `core/storage.ts` the `GuideStore` interface, `stores/{r2,memory}.ts`), served by the Cloudflare Worker (`apps/guides-show/worker/index.ts`, R2 bucket binding `GUIDES` = `guides-show-guides`). "Self-hostable" means deploying that Worker yourself and pointing `PLANNOTATOR_GUIDE_SHARE_URL` at it. Routes: `POST /api/g` (`201 { id, url, deleteToken, expiresAt? }`, `400`/`413`/`429`), `GET /g/<id>` (HTML, `Cache-Control: public, max-age=300`, styled 404 page), `GET /api/g/<id>` (the stored body, CORS `*`), `DELETE /api/g/<id>` with `Authorization: Bearer <deleteToken>` (`204`/`401`/`404`), `OPTIONS /api/g*`. Upload guards: the size cap plus a per-IP rate limit on creation only (Cloudflare's `[[ratelimits]]` binding, 20 creates per minute per `CF-Connecting-IP`, `429` + `Retry-After`), optional in the Worker's `Env` and fail-open whenever it cannot resolve, so local runs and self-hosts without the binding are unlimited. Guides are kept indefinitely by decision (no host-imposed TTL, nothing prunes the bucket); only an upload's own `ttlSeconds` expires one, enforced on read.

Invariants: hosted pages of either mode carry `<meta name=GUIDE_HOSTED_META_NAME>` (plus `<link rel=canonical>`, `robots noindex`, `og:*`), which is how the viewer knows to add its client-side **Download** button (builds the portable file from the DOM-reconstructed viewer pin, never re-fetches, never includes the hosted meta); the encrypted shell (`createGuideShellHtml`) additionally carries `<meta name=GUIDE_PAYLOAD_META_NAME>` naming `/api/g/<id>` and NO title, intent or payload in the HTML; a plain page embeds the snapshot like an export and has no payload meta. The key must never appear anywhere but the fragment (not in a query string, not in a request, not in a stored record other than the uploader's own envelope). The uploader sends its viewer pin (`{ js, css, jsIntegrity, cssIntegrity, langs? }` from `GUIDE_VIEWER_MANIFEST`) and the host renders with it on its OWN `/v1/` (`baseUrl` is never sent); without a pin the host uses its bundled manifest. Error pages name the serving host, never guides.show, and store failures answer `500 { error: "internal error" }` with the real message logged host-side only. One link per guide in Plannotator (`409` on a second upload); removal goes to the host the record names. Deploying the Worker with the `guides-show-guides` bucket is a separate, explicit step: no production deploy without a bucket, and never as part of a build.

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
  diagramAnchor?: DiagramAnchor; // A comment on a rendered diagram part: { v: 1, family, kind, id | from + to, label, sourceLine } (document lines); see "Diagram comments"
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

**Annotation undo/redo:** each plan, annotate, or code-review app keeps one bounded 50-action stack for the active surface. `Mod+Z` undoes; `Mod+Shift+Z` and `Mod+Y` redo. Only local human annotation mutations are recorded, and a new mutation discards the redo branch. Native inputs, textareas, contenteditable regions, CodeMirror, dialogs/popovers, the Image Annotator, and an open Review Edit Mode session keep ownership of their own history shortcuts. External/agent writes do not enter annotation history; direct source changes, draft/share restore, refresh or diff replacement, identity changes, navigation to another document/message/review context, submission, and other baseline replacements clear it. The Image Annotator keeps a separate stroke undo/redo stack while its overlay is open.

**Cross-file annotations (multi-document annotate sessions).** A folder session — a review of several files (bundle), and any session whose linked documents carry feedback — spreads one body of feedback over many documents, so the annotations panel has a scope toggle in its header: **This file | All files**. It appears only when feedback exists outside the open document (`isMultiDocumentSession` in `packages/editor/App.tsx`); message multi-select keeps its own cross-message surface and is excluded. The toggle replaces the old `+N in M other files` flash affordance as the primary answer to "there are comments elsewhere"; the flash survives as a "Show in files" link at the foot of the All files view, and the header keeps a quiet `+N elsewhere` count while the scope is This file.

*Default rule* (`resolveInitialAnnotationScope`, `packages/ui/utils/annotationScope.ts`): the saved preference wins, except that a document with **no feedback of its own while other documents have some** opens on All files — that is the frustration the view exists for. It is re-resolved on every document change (keyed on the open document only, so a toggle is never yanked away mid-document), and the explicit choice persists per browser in the `plannotator-annotation-scope` cookie. One exception: arriving by clicking a card in the All files list keeps the All files scope, because that list is where the reviewer was.

*Grouping* is `groupAnnotationsByDocument` (pure, same file): one collapsible group per document that actually carries feedback, the open document first and the rest by path (in a bundle: the bundle's own order, the open file in its place, anything else after), labelled relative to the deepest session root the file browser knows. Cards are the same `AnnotationCard` the single-document timeline renders, so quote, comment, type, images, replies, Edit and Delete behave identically.

*Editing another document's comments* writes straight into that document's stored annotations through `useLinkedDoc`'s `updateStoredAnnotations` (the linked-doc cache, or the stashed source document); the active document is refused outright, since its annotations are host state. The export reads the same store, so a cross-file delete is reflected in what is submitted. *Export split:* `getDocAnnotations()` also carries the OPEN document's live state (for counts and the panel), so an export must never read it beside the host's live annotations — that printed the open document twice (every folder session, and any session submitted while a linked document was open). Every export goes through `useLinkedDoc.getFeedbackDocuments()` (`{ root, documents }`: the stashed root while a linked document is open, else null, and every other document once by path) and `resolveFeedbackSections` (`packages/editor/feedbackDocuments.ts`): the root (plan, file, or folder-level comments, plus SSE externals) under the session heading, every other document under its own path. A folder session titles that second section `Folder Document Feedback` ("files in the reviewed folder"), not the plan wording. Every document's entries are rendered by the ONE renderer `exportAnnotations` uses (`renderAnnotationEntries` in `packages/ui/utils/parser.ts`: document order, `[In diff content]`, quick labels + tip + Label Summary, threaded replies), so a document reads the same whichever section carries it. A cache entry under the root's own path (the root opened from itself, e.g. an HTML "Home" link) is a separate copy and is exported under its path, never dropped. **These cross-file mutations are deliberately not undoable:** the annotation history stack describes the open document's surface, and an entry that undid into a document the reviewer is not looking at would restore invisible state. `Mod+Z` still covers everything done in the open document.

*Jumping* (`useAnnotationJump`, `packages/editor/hooks/`) navigates through the file browser's own selection path — so the active file, the doc URL and the linked document stay in step — waits for the commit that makes the target the open document, then selects it, which is what scrolls markdown highlights and drives the HTML viewer's marker selection. A navigation that never commits drops the request rather than selecting an id into whatever document is open later. An HTML destination is opened with `revealSidebar: false`, exactly like a link click between HTML documents (#1532): that surface's page owns the viewport and the header carries its own Back, so arriving there must not pop the left sidebar. Both callers ask the same shared predicate, `documentRendersHtml` in `packages/ui/utils/htmlLinkNavigation.ts`.

*Counts:* the panel header shows the scoped count, but the session total the decision control runs on (`feedbackAnnotationCount`) is computed from session state and is unaffected by the toggle — switching scope never changes what is submitted. Not covered: code review, single-document plan review, and live-app multi-page sessions (which already group their export by page). The compact/touch sheet reuses `AnnotationPanel`, so it gets the same toggle in its own header bar. Every panel prop is optional and additive, so a host that passes none of them (Workspaces) renders the previous panel, legacy affordance included.

**Diagram comments (Mermaid and Graphviz fences).** A comment composed on a rendered diagram part — a click on a node, edge or cluster in the inline canvas or the popout — becomes an `Annotation` on the document with ONE additive field, `diagramAnchor` (`DiagramAnchor` from `@plannotator/core/diagram-anchor`, the `htmlAnchor` precedent): `{ v: 1, family, kind, id | from + to, label, sourceLine }` (families: flowchart, state, class, er, requirement, sequence, other, graphviz; kinds: node, edge, cluster, and `diagram` for the whole diagram, which has no id), where the anchor is the diagram's OWN id for the part (sequence parts carry classes, not ids, so the codec's ids are the actor's `name`, `msg-<n>`, `note-<n>`, `frame-<n>` by document order, restored with a label check because an ordinal moves) (never the rendered element id with its trailing counter, never geometry) and `sourceLine` names 1-based DOCUMENT lines (the offset is `Block.diagramSourceLineOffset ?? Block.startLine`: a fence's opening line sits one above the diagram's first line, so a fence uses its `startLine`, while a whole-file diagram source sets the offset to 0 because its first line IS document line 1). The annotation carries the fence's `blockId`, `startOffset`/`endOffset` 0, the label as `originalText`, `type: COMMENT` and the tater identity, so it lists in the annotations rail beside text comments, exports, persists in drafts (opaque JSON), and restores after a reload: `useAnnotationHighlighter` skips rows carrying `diagramAnchor` (neither attempted nor unanchored), and `DiagramBlock` re-resolves them against every render through the engine's finder — id, then label, then unanchored — and reports through `Viewer.onRestoreReport` with its own comments as `attempted`, so App's `markdownUnanchoredIds` shows the same "Unanchored" chip a text comment gets. All three export paths (`exportAnnotations`, `exportLinkedDocAnnotations`, `exportAnnotationEntry`) print the location line `Diagram node <label> (<id>), line <n>` (whole diagram: `Diagram (<family>), lines a–b`) under the comment's heading; a WebMCP reply inherits its parent's `diagramAnchor`; the diagram block is `annotation-exclude`, so text restore can never wrap a `<mark>` inside the svg. The line comes from (`diagramAnchorLocationLine`; edges name both ends); the feedback archive records the validated anchor as `diagramAnchor`; `POST /api/external-annotations` accepts a validated `diagramAnchor` on plan comments (both runtimes, `400` when malformed; such rows carry `blockId: "external"`, and like a comment whose fence was deleted they are resolved BY ANCHOR against every diagram block through `DiagramAnchorClaims` (`components/diagram/anchorClaims`, provided by `Viewer`): the first block in document order whose finder resolves it shows it, and when every block answered and none did it is reported unanchored); share links drop the anchor exactly like `htmlAnchor` (`sharing.multiTarget.test.ts`). Every renderer read of the field is nullish-safe (`ann.diagramAnchor != null`, `?.family`): a row reaches the renderer from several local ingests, and a malformed anchor must list as unanchored, never throw during render. Selecting a diagram comment in the rail pulses its ring, pans it into view and scrolls the block into view. Plannotator passes `maxAdditionalTargets` 0 (one part per comment; the viewer's shift-click multi-select is a host opt-in) and no `onSave` (no Source pane; the in-block Show-source toggle keeps the fence readable). Read-only documents (archive) open no composer. The composer also offers **Ask AI** (same handler, label, disabled-until-text rule and no key binding as the markdown composer's; Enter stays Comment) wherever the document's Viewer gets `onAskAI`: `DiagramBlock` sends a `CommentAskAIContext` built by `diagramAskAIContext` (`packages/ui/utils/diagramAskAI.ts`) whose `detail` carries the export's location line, the engine and family, and the diagram source in document lines (bounded to 40 lines / 4000 chars, grown outward from the part's line so the part is always in it; a single line over the budget is cut with `…`), so the identity rides the user message ahead of the question for SDK providers, Ask this session and the agent terminal alike. Asking from the popout closes the popout, which would otherwise cover the panel the answer streams into.

**Diagram files (annotate `.mmd`/`.mermaid`/`.dot`/`.gv`).** `plannotator annotate flow.mmd` opens the FILE as one diagram in the same engine — `DiagramBlock` → `DiagramViewer` → `DiagramPopout`, themed, click-to-comment on nodes/edges/clusters/the whole diagram, drafts, export, per-file version history — rather than refusing it or rendering it as text. Three pieces, one decision each:

1. **Core** (`packages/core/annotatable.ts`): the four extensions join the annotatable plain-text and doc sets (they ARE UTF-8 text, so CLI resolution, the 2MB `MAX_ANNOTATABLE_FILE_BYTES` cap, folder discovery, the file browser and `/api/doc` need no special case), and `diagramRenderKindForPath` is the single predicate that names the engine. They are not markdown: `shouldStripFrontmatter` returns **false** for them, because Mermaid's own `--- … ---` config block is diagram content, and `normalizeMarkdownExtensions` can never re-register them.
2. **Servers** (`packages/server/annotate.ts` + `reference-handlers.ts`, mirrored in `apps/pi-extension/server/serverAnnotate.ts` + `reference.ts`): `/api/plan` and `/api/doc` set `renderAs` to `"mermaid"`/`"graphviz"` and keep the file's RAW text as the body. The session-level guard is the shared pure `annotateDiagramRenderKind`, so both runtimes exclude raw-HTML, converted, URL, folder, message and live-app sessions identically. Version history is unchanged (diagram text is text).
3. **Editor** (`packages/editor/App.tsx`): `renderAs` widens to `DocumentRenderAs` (`'markdown' | 'html' | DiagramRenderKind`) and the `blocks` memo becomes `diagramDocumentBlocks(text, kind)` (`packages/ui/utils/parser.ts`) — ONE `code` block whose language routes to the engine, so `Viewer`, `diagramAnchor` comments, `useAnnotationHighlighter` skipping, the export, drafts and restore are the fence path unchanged. The block sets `startLine: 1` + `sourceLineCount` (so the export's `(lines a–b)` label names the file's real span) and `diagramSourceLineOffset: 0` (so a comment's `sourceLine` is the file's own line — a synthesized ```` ```mermaid ```` wrapper would report every line one too high). Edit Mode and the Select/Markup input-method strip are excluded with HTML: the block is `annotation-exclude`, so there is no text to drag-select.

Share links carry the FENCED form in the payload's `p` (`shareableDocumentMarkdown`, `packages/ui/utils/sharing.ts`): the portal has no server to tell it `renderAs`, and fencing needs no portal change and no new payload flag. Diagram comments themselves still degrade to text comments in a share link, exactly as they do from a fence (`diagramAnchor` is dropped like `htmlAnchor`).

**Raw-HTML annotate:** the sandboxed viewer never mutates the visited page's DOM. Committed annotations render as numbered placed comment markers plus overlay-projected highlight rectangles inside a shadow-rooted fixed overlay host: the durable anchor data (element selector, text snapshot, normalized selected point) is persisted, and the markers/highlights are disposable projections re-resolved from it on every reconcile. Shift-click multi-select joins additional elements to one comment (`htmlAdditionalTargets`).

**Element context (agent-facing).** A pinpoint also captures a bounded description of the element at click time, `elementContext` on the annotation (`HtmlElementContext` in `packages/ui/types.ts`; extra targets carry a smaller one as `context`), built by `buildElementContext` in the bridge and re-validated at the parent trust boundary by `parseHtmlElementContext`, which lives in `packages/core/html-anchor.ts` beside `parseHtmlElementAnchor` (#1549); `useHtmlAnnotation.ts` imports and re-exports it rather than mirroring it, and the host persistence helpers in that same core module (`buildPersistedHtmlAnchor`, `projectHostThreads`) run it too, so a host that persists and projects through core keeps the field instead of dropping it on save. It is purely descriptive, never read by restore. Fields: tag, id, author classes, an ancestor `path`, explicit-or-implicit `role`, accessible `name`, an ALLOWLISTED attribute set (href/src scrubbed of query and fragment, `data:` truncated to its media type), rendered `text` (300), a collapsed HTML `outline` (600 chars; two child levels, then one, then a per-tag count, whichever first fits), child count, viewport `rect`, nearest `landmark` and `heading`, a `component` hint from `data-component`/`data-testid` ancestry (deliberately no React fiber reads), and in live-app sessions the `page` route and title. Never captured: form values, `on*` handlers, `style`, script/style/template contents, full innerHTML. Hard cap 2 KiB serialized per primary (1 KiB per extra target), shedding outline → text → attrs → classes → path → heading → landmark → component → sourceName (one order, `ELEMENT_CONTEXT_SHED_ORDER` in core, mirrored by the bridge's `CTX_SHED_ORDER`; a test keeps them equal). Under the persisted anchor's own 16 KiB budget `buildPersistedHtmlAnchor` sheds contexts — per-target first, from the end, then the primary — BEFORE it drops any target, since a context is descriptive and re-derivable on the next click while a dropped target loses a marker the reviewer placed; `DEFAULT_HTML_ANCHOR_MAX_BYTES` is unchanged and the dropped-target counts still count targets only. The export (`elementContextExportBlock` in `packages/ui/utils/parser.ts`) prints a 4-backtick `html` fence of the outline plus `selector` / `path` / `role` · `name` · `component` / `attrs` / `text` / `box` / `near` lines under the comment; a text-less pinpoint's placeholder quote names WHICH element it is, not just its kind: the hover label plus the accessible name (`ctxName`: aria-label, alt, title, …) plus, for media (`img`, `video`/`audio` and their `<source>`, `iframe`, `embed`, `object`, `input type=image`, svg `<image>`), the source FILE name through the same `ctxScrubUrl` scrub (`[element: Image "Team photo" (team.jpg)]`, `[element: Image (data:image/png)]`; brackets and double quotes are swapped so it stays one token; `describeTextlessElement` in the bridge, used for the primary and every shift-click extra target). Restore never reads that quote: a text-less element is bound by its anchor, which it gets through an `#id` or `data-*` identity rung or, for media, through its source (`anchorSourceSnapshot` in the bridge: the author's reference to the resource, relative to the document's base when it lies under it (so a pin saved in one session restores in the next, whose asset route has another port and token), else root-relative on the document's own origin, else origin and path; the query and fragment count only as an 8-hex FNV digest, never in plain text, so `/_next/image?url=a.jpg` and `?url=b.jpg` are different sources while a token stays out of the annotation, and a source re-signed per load does not restore; no anchor for a `data:`/`blob:` source or for a source another element of the same kind shows, so identical siblings still fail closed). A media anchor whose selector no longer lands on its element is found again by that source (`relocateBySource`; two matches resolve nothing), and an element whose source changed is not bound (the pin is reported Unanchored). An `href`/`alt` selector rung can still carry a raw attribute value, as for text-bearing elements. So pins saved with the older bare `[element: Image]` keep restoring. The export rewrites the placeholder to `Feedback on the <nav> element — "Primary"` in the heading, plus the media file name (`Feedback on the <img> element (jane.png)`), read from the context's `sourceName`: the bridge records the file `describeTextlessElement` names (src, a lazy `data-src` over a `data:` placeholder, `srcset`, `<picture><source srcset>`, a video's `<source>` or `poster`, scrubbed the same way), so the heading and the composer quote always name the same file; contexts saved without `sourceName` fall back to the scrubbed `src` attribute, while a pinpoint with real quoted text keeps its quote line and gains the block. In srcdoc sessions `ctxScrubUrl` also drops the session's `/api/html-assets/<token>/` prefix, so a `src` reads as the author's own document-relative path, percent-decoded (`jane doe.png`). **Ask AI** carries the same identity: a question asked from a pinpoint composer sends `elementIdentityForAskAI(draftTargets)` (`packages/ui/utils/parser.ts`, the identity lines of `elementContextExportBlock` with `includeOutline: false`, numbered per element) as the scope's `detail`, which `buildDefaultPrompt` appends under "Selected element:" and the chat never displays; SDK providers, "Ask this session" and the agent terminal all send that prompt. It carries no query strings: the live route and an `href`/`src` selector rung are scrubbed to `?…` there (the persisted annotation keeps them). Annotations without the field export byte-identically. The grouped live-app export omits the `route` line (the `## Page:` heading carries it); `exportAnnotationEntry` (one annotation, no number) includes it; it is a pure helper for hosts and tests, and the annotation panel's card chrome is unchanged. Both helpers also take `includeOutline` (default `true`): `false` prints the identity lines without the fenced outline, for model turns where the 600-char outline is the expensive part per annotation. Share links drop `elementContext` exactly like anchors. The feedback archive records identity only (`elementTag`, `elementSelector`, `elementPath`, `elementRole`, `elementName`, `pageUrl`), never the outline. No `BRIDGE_PROTOCOL_VERSION` bump: the field is additive in both directions.

**HTML and live-app interaction model:** raw-HTML sessions and live app sessions (`mode: "annotate-app"`) share one contract. Both open with pinpoint **armed** (`htmlAnnotateArmed` defaults to `true`, `packages/editor/App.tsx:493`; live sessions open armed like every other HTML surface, `App.tsx:2871`). `Esc` walks a ladder instead of exiting outright: a pending draft closes first, then the pinpoint hover outline clears, and only then does `Esc` drop the surface to **Interact**, where the bridge goes passive so clicks, forms, text selection, and SPA navigation reach the page natively (`packages/ui/components/html-viewer/bridge-script.ts:3066-3080`; committed markers stay visible and a marker click still opens its comment, and in Interact an open drag-comment draft still closes before `Esc` is handed back to the page). Vim owns its own ladder and is skipped here. The header **pen** button toggles Annotate/Interact (`packages/editor/components/AppHeader.tsx:386-404`, `aria-pressed`), as does `Mod+Shift+A` (`packages/ui/shortcuts/plan-review/htmlAnnotate.shortcuts.ts`) — a real toggle in BOTH directions, which is what makes it the answer to "Esc dropped me to Interact, how do I get back?". Disarming through either path tears down any pending draft, because the bridge's `set-annotate-mode(false)` handler clears every pending affordance (`bridge-script.ts:719-739`), exactly as the Esc ladder does. The bridge mirrors the chord inside the iframe on the capture phase and forwards it to the parent, so it works whichever document owns focus. Text drag-selection commenting is **always live**, on both surfaces and in both states, ungated from the armed flag and from the input method (`bridge-script.ts:384-386`, `:1420-1436`): while armed, a click pins an element and a drag selects text at the same time, and the one-shot `dragEndedClick` guard stops a completed drag's trailing click from re-pinning (`bridge-script.ts:1381-1390`).

These surfaces are **comment-only**. `redline` (auto-DELETION) and `quickLabel` are clamped at the trust boundary, which is the parent's postMessage ingest rather than the server, covering the host mode and a page-supplied `modeOverride` alike so a hostile page cannot force a DELETION (`packages/ui/components/html-viewer/useHtmlAnnotation.ts:535-547`). Only CREATION is restricted: persisted DELETION annotations still restore and still render their deletion styling (`useHtmlAnnotation.ts:903`). The selection toolbar drops Delete and the label picker behind a `commentOnly` seam and keeps exactly one label affordance, the hardcoded 👍 "Looks good" for text selections (`HtmlViewer` filters its `onQuickLabel` handler to `THUMBS_UP_LABEL`); markdown surfaces keep the full toolbar. A pinpoint click opens the comment composer directly and never shows that toolbar, so the composer carries the same one-click 👍: an emoji-only button beside Save (`aria-label` and tooltip "Looks good", `data-quick-look-good`), passed by `HtmlViewer` as `CommentPopover`'s `onQuickLookGood` (absent on markdown and global composers). It goes through the same commit path as a typed comment (`commitComposerDraft` in `useHtmlAnnotation`), so the result is the toolbar's `THUMBS_UP_LABEL` quick-label COMMENT on the pinned element with its anchor, element context and shift-click extra targets. It is disabled once anything is typed or attached (a click never discards a draft) and takes no key: Mod+Enter still saves the typed comment. HTML surfaces also pin the viewer input method to pinpoint (`App.tsx:5480`), so there is no floating input-method toolstrip on them at all (`toolstripVisible` is gated on `!isHtmlSurface`, `App.tsx:2788-2793`) and the `Shift+1`-`4` annotation-mode shortcuts cannot fire there. A header **eye** button immediately left of the pen toggles Show/Hide tools, as does `Mod+Shift+X` (same scope, same bridge forwarding as the pen chord — the binding is deliberately un-mnemonic because every mnemonic letter is a browser chord: H is Chrome Home / Firefox history, E/I/J/K/C devtools, B/O bookmarks, V paste-as-plain-text, T reopen tab): hiding REMOVES all floating chrome over the page from the DOM (the sidebar tongue tabs and the comment/attachments cluster) rather than merely hiding it (`AppHeader.tsx:364-385`, `App.tsx:5193`, `HtmlViewer.tsx:810`). These surfaces **open with the tools hidden** — `DEFAULT_HTML_CHROME_STATE.toolsHidden` is true and `App.tsx` seeds `htmlToolsHidden` true so nothing flashes before the restore effect — because an HTML document is authored to fill the viewport. A fresh persisted record still wins in both directions, so a reviewer who showed the tools keeps them — in a folder annotate session too, which restores and records the `toolsHidden` half while leaving the sidebar/panel halves alone, since its file browser owns the sidebar for the whole session (`mergeHtmlChromeState`). The toggle lives in the header (and in the compact Options menu), so hidden — default or restored — always has a way back, which is what makes both honoring the persisted `toolsHidden` cookie and defaulting to hidden safe (`packages/ui/utils/htmlChrome.ts`). Note the version-diff "Show changes" control lives in that floating cluster, so it is behind the eye on a fresh session. All three header controls (eye, pen, Refresh) describe themselves through the app's `Tooltip` rather than a native `title` (`packages/ui/components/HtmlSurfaceControls.tsx`): two lines, the control's description — still the host-overridable `labels` string — over its shortcut as keycaps from `formatShortcutBindingTokens`, so the chord is never a hardcoded "Cmd". Because `title` no longer supplies the accessible name, the pen carries an explicit `aria-label` (defaulting to its description), the eye keeps its sr-only text and the Refresh its `aria-label`; the shortcut is additionally attached as a persistent `aria-describedby` span, because this Base UI build tags the popup with no ARIA at all. Refresh has no chord and renders no keycap row; `shortcuts` on the component overrides the bindings per control, defaulting to the `html-annotate` scope so the tooltips cannot drift from what the app dispatches.

**HTML Refresh (#1232).** A local rendered-HTML session can re-read its file from disk without reloading the tab, for the loop where an agent edits the page while the reviewer keeps annotating. The header **Refresh** button (left of the eye, `data-html-refresh`, titled "Refresh HTML from disk") fetches the active document through `/api/doc`, hands the bytes to the app, and remounts the viewer under a bumped `reloadGeneration` key (`packages/editor/App.tsx`, viewer `key`). The engine is the published `useHtmlRefresh` (`packages/ui/hooks/useHtmlRefresh.ts`: superseded and cross-document fetches are dropped, one restore acknowledgement per generation) and Plannotator's binding over `fetchHtmlDocumentSnapshot` is `packages/editor/hooks/useHtmlRefresh.ts` (toasts for refreshed, missing, and unavailable). Committed annotations survive on their durable anchors: the remounted viewer re-resolves every element selector and text snapshot against the new page, and the ones it cannot re-anchor are reported once (`onUnanchoredChange` to `reportAnnotationRestore`), toasted, and marked with an **Unanchored** chip in the annotations panel (`htmlUnanchoredIds` in App, cleared when the document changes); their comments stay in the panel and still export. A refresh keeps the version diff: for the root document `/api/doc` carries `previousPlan`/`versionInfo`/`diffHtml` recomputed against the bytes just read (see the annotate `/api/plan` row), `applyRefreshedHtml` sets them and resets `isPlanDiffActive`, so the view returns to normal mode with "Show changes" still available; a tab reload converges on the same state because `/api/plan` serves the current bytes and recomputes the same diff. `/api/share-html` shares the current bytes too. Only local files refresh: `canRefresh` is false for `http(s)` paths and live-app sessions, and the control is absent on read-only (archive) documents. The compact touch shell renders no header controls (`HtmlSurfaceControls` returns null when `compact`), so its Options menu offers "Refresh from disk" beside the Show/Hide tools and Interact/Annotate actions (`compactDocumentActions` in App, disabled while a refresh is in flight); a host that passes `canRefresh` and `onRefresh` to `HtmlSurfaceControls` gets the Refresh button with or without the eye.

**Links between local HTML documents.** A srcdoc document has no URL of its own — its base URL is the PARENT page's, which is the Plannotator server — so an ordinary `<a href="02-detail.html">` used to resolve onto the server, hit the catch-all, and render the whole editor inside the annotated frame; an in-page `#section` link navigated for the same reason. The bridge therefore **never lets the srcdoc frame navigate itself**: a capture-phase click handler registered before the pinpoint handler (and never stopping propagation, so armed clicks still pin the link element) `preventDefault`s every link click, scrolls in-page `#fragment`s locally, and posts the RAW href to the parent as `link-click`. `javascript:` hrefs are left to the page. The parent is the trust boundary: `parseBridgeMessage` bounds the href (2048 chars, no control characters) and `resolveHtmlLinkIntent` (`packages/ui/utils/htmlLinkNavigation.ts`, pure) decides what it means — a relative or `../` path resolves against the CURRENT document's directory and opens as a **linked document** through `/api/doc` exactly like a relative markdown link, a root-relative path (and the same path spelled with the server's own origin, the shape an author writes as `http://localhost:<port>/01-entry-point.html`) resolves against the directory the session was opened from, another origin opens in a **new tab** (`noopener,noreferrer`, the frame never navigates), a link to a local **image** (`png jpg jpeg gif webp svg avif bmp ico apng`, the set code review previews, `isReviewImagePath`) opens in the shared `ImageLightbox` (`packages/ui/components/ImageLightbox.tsx`, the same overlay the markdown Viewer uses), read through the page's OWN `/api/html-assets/<token>/…` route taken from the `<base href>` the server installed (`htmlAssetRouteFromDocument`) so nothing becomes readable that the page could not already load, and only when the image resolves inside the current page's directory (one reached by `../` or a root-relative path outside it toasts "Images open only from this page's own folder"; a page with no asset route, such as a share link, toasts too). The lightbox shows the image only through `<img src>` (an SVG never runs), takes focus when it opens (pulling it out of the iframe), and swallows every key on the window's capture phase while open, so `Esc` closes it before the HTML Esc ladder runs and `Mod+Enter` cannot submit a decision behind it. Any other local file outside the annotatable set (`.pdf`, `.zip`) raises a toast and is never fetched, and every other scheme (`data:`, `file:`, `mailto:`, `blob:`) is dropped. The query string is stripped and the fragment is kept: it rides to the new document as `HtmlViewer`'s `initialFragment` and is replayed once that document's bridge is ready (`scroll-to-fragment`). Folder sessions route the open through the file-browser selection handler so the active file, the sidebar and the linked doc stay in step. Annotations stay per document (the `useLinkedDoc` cache), and the Interact/Annotate state and the chrome rules keep applying. **Navigating between HTML documents never opens the sidebar**: the page owns the viewport on this surface (it opens with the tools hidden and the sidebar closed), so a link click leaves the sidebar exactly as the reviewer had it — closed stays closed, open stays on its tab. `useLinkedDoc.open` / `openLoaded` take `revealSidebar` for this (default `true`, so every markdown caller is unchanged), and App passes `false` only when the target renders as HTML — `resolveHtmlLinkIntent`'s `rendersHtml`, which is false for markdown targets and for `.html` under `--markdown`, so a markdown target keeps the markdown convention of opening the Contents tab. The way back is therefore a **Back control in the header** (`data-html-back`, leftmost of the HTML surface controls, before Refresh/eye/pen), rendered only while a linked HTML document is open and named after the document it returns to ("Back to index.html"; `useLinkedDoc` keeps one root snapshot rather than a stack, so Back from any depth lands on the session's root). It deliberately claims **no keyboard shortcut** — `Alt`+`Left` and the browser's own Back belong to the user — and the compact touch shell offers the same action in its Options menu. The sidebar's "Viewing / Back to …" header still works for anyone who opens the sidebar, and `TableOfContents` now renders it even when the document has no headings at all, the normal case for raw HTML. The chrome restore-on-entry effect does not re-run on html→html navigation (`shouldRestoreHtmlChrome` in `packages/ui/utils/htmlChrome.ts` is false whenever the previous surface was HTML), so following a link cannot slam the tools back to hidden or re-apply a remembered sidebar state mid-session. **Armed pinpoint clicks still annotate**: navigation is suppressed in both states, but only Interact follows the link (`Esc`, the header pen, or `Mod+Shift+A` gets there); image links follow the same rule, so a click on a thumbnail pins it while armed and opens the lightbox in Interact. Live app sessions (`mode: "annotate-app"`) are excluded outright — the interceptor lives inside the bridge's `!LIVE` guard — because they navigate the proxied app for real. Known limitation, pre-existing and unchanged for LINKED documents (`/api/doc` mints a token per HTML file's own directory and refuses `..`, so `sub/page.html` opened as a linked document loads assets below it but not ones it reaches with `../`); **embedded** documents are not affected, because they load from the embedding page's token root — see the next paragraph.

**Embedded local documents.** The same "a srcdoc has no URL of its own" fact broke `<iframe src="prototype.html">` far worse than it broke links: the embed resolved onto the server, the catch-all answered with the app, and every embed in a report rendered a second Plannotator (#1554 — five of them, cookie-less because a nested context inherits the parent's sandbox flags). Links could be fixed by intercepting clicks; embeds cannot, because the `src` is routinely assigned by SCRIPT at runtime (`<iframe data-src="…" loading="lazy">` plus a loader) and may carry a query string, so no serve-time attribute rewrite ever sees it. The fix changes **resolution** instead of markup: `rewriteHtmlAssetReferences` installs a `<base href="/api/html-assets/<token>/">` first in `<head>`, so every relative URL the document produces — `<iframe>`, `<embed>`, `<object data>`, `<frame>`, a runtime `el.src = …`, a `fetch('./data.json')`, a `new URL(x, document.baseURI)` — lands in the document's own directory whatever writes it and whenever. The base is root-relative because a srcdoc resolves its own `<base href>` against the parent's URL (this server), so the port need not be known; an author's own `<base href>` is re-anchored when relative and left untouched when absolute or root-relative (they pinned an origin deliberately). `/api/html-assets` now serves `.html`/`.htm` as real documents, so an embedded page's own relative assets and nested relative embeds resolve against ITS position under the token root — including `../` back up to the root, which is why the linked-document limitation above does not apply here. Query strings and fragments survive to the embedded document untouched (`mock-decisions.html?step=result` sees its own `location.search`); the route only ever reads `url.pathname`.

*Security.* Embedded pages are untrusted author HTML served from the Plannotator server's origin. Inside the annotate surface the primary document's `sandbox="allow-scripts"` iframe already protects them: sandboxing flags are inherited and intersected by every nested browsing context, so an embed runs at an opaque origin with no `allow-same-origin` and its `fetch('/api/plan')` fails as cross-origin (verified in the browser, before AND after this change — the pre-fix nested Plannotator was already origin-`null`, which is exactly why the owner saw "no cookies in it"). Defense in depth for the case with no parent sandbox — a reviewer pasting an asset URL into a top-level tab — is on the response: every HTML response from the asset route carries `Content-Security-Policy: sandbox allow-scripts` (`HTML_ASSET_DOCUMENT_CSP`, never `allow-same-origin`) plus `X-Content-Type-Options: nosniff`, and no cookies are involved. Nothing widens what is readable: the same per-directory token, the same `..` refusal, the same `isWithinDirectory` symlink check; HTML documents additionally honour the 2MB `MAX_ANNOTATABLE_FILE_BYTES` annotate cap rather than the 50MB asset cap. The decision is single-sourced in `resolveHtmlAssetRoute` (`packages/shared/html-assets.ts`, vendored to Pi) so the Bun route and the Pi mirror cannot drift.

*Never the app in a frame — but only for a path that could BE a file.* Under the assets prefix, a request whose `Sec-Fetch-Dest` is `iframe`/`frame`/`embed`/`object`, or any `.html` path however it was made, gets a small plain 404 document naming the missing file instead of a JSON blob; ordinary asset misses keep their JSON shape. The annotate **catch-all** applies the same 404 document, but only when BOTH conditions hold (`isFramedEmbeddedDocumentRequest` = `isFramedFetchDest` && `pathNamesEmbeddedDocument`, `packages/shared/html-assets.ts`, vendored to Pi and used by both runtimes): the destination is framed, AND the path is not `/` and either its last segment carries an extension (`/prototype-slash.html`) or it sits under a directory segment (`/assets/frame`). `/` and a bare single-segment word (`/settings`) are served the app as always, so a framed session URL and any future SPA route cannot 404. The rule keys on the **shape of the path, not `Sec-Fetch-Site`**: an annotated page is a sandboxed srcdoc with an opaque origin, so its nested-document requests are `cross-site` — the same value the VS Code webview wrapper produces, and `none` on both sides for a pasted URL — so site can never separate the two, while the path can, because the app only ever loads at `/` and a relative embed is anchored at `/api/html-assets/<token>/` by the `<base href>` (with its own 404); only a root-relative embed reaches the catch-all at all. Scoping it this way is the #1561 regression fix: the VS Code extension renders the session URL inside an `<iframe>` behind its cookie proxy (`apps/vscode-extension/src/panel-manager.ts`, `cookie-proxy.ts`, which forwards headers verbatim) and every subcommand launched from a VS Code terminal is routed there by `PLANNOTATOR_BROWSER`, so the unscoped guard made an annotate session opened from the editor show "404 Not found" and its one auto-reload 404 again. A NON-framed request for a missing path is untouched and still gets the app, exactly as before #1561. Plan and review servers carry no such guard.

*Pinpoint on an embed.* The bridge is **never** injected into a nested frame, so an embed is one pinpointable element from the outer page's perspective. While pinpoint is armed, frames are `pointer-events: none` (`body[data-plannotator-frame-inert]`, set by `updatePinpointCursor` for srcdoc sessions only — live-app sessions are untouched, since their nested frames belong to the user's app), which is what lets the click reach the outer document at all; hit-testing would then pass through to the container behind, so `preferInertFrameAt` resolves a point inside a frame's own rect back to the frame. Interact (`Esc`, the header pen, `Mod+Shift+A`) restores native interaction inside the embed — which is also the only state a link inside an embed can be followed from, exactly like the rest of this surface. An embed carries no text, so it takes the text-less media anchor rule (see "Element context" above): the comment and its element context (tag, ancestor path, the frame's `title` as the accessible name) are recorded and exported, and the placed marker restores across a reload or an HTML Refresh through the frame's `id` / `data-testid`, or else through its `src` when no other frame on the page shows the same source (`proto.html?step=1` and `proto.html?step=2` are different sources); two frames with one source fail closed and do not restore. Text-carrying pins on the page around it restore normally.

*Portable export and share links.* Embeds do not travel. `inlineHtmlLocalAssets` inlines assets as `data:` URLs but a sibling document is a second page with its own relative assets, so it is not inlined; instead a document that contains any frame gets `<base href="about:blank">`, which makes its embeds render **empty** rather than resolving onto the share portal's own catch-all and reproducing this bug there. Everything else about a share link is unchanged.

Known limitations: printing a raw-HTML annotate session prints highlight stripes from a best-effort absolute-coordinate layer and is degraded inside the iframe (pre-existing); element-only targets (SVG anchors, multi-select additional element targets) have no print representation. Annotation undo/redo listeners live in the parent document, so they are unavailable while focus is inside a raw-HTML or live-app iframe; the framed page keeps its own `Mod+Z`. Focus the editor chrome or annotation panel first. Forwarding this safely would require synchronizing parent history availability without stealing native or live-app undo; only the two reserved chords are currently forwarded: `Mod+Shift+A` (annotate toggle) and `Mod+Shift+X` (show/hide tools).

## Question blocks

An agent can ask the reviewer a question inside a plan or document with a `:::question` (pick one), `:::question-multi` (pick any) or `:::question-text` (free text) directive; the reviewer answers on a card in place. Approved design: `.product/approved/qa-components/` (SPEC plus the owner's approval.md, which overrides it). Shipped as core+ui (#1637), editor (#1638) and the agent side (prompt, skill, archive, WebMCP).

- **Grammar and data** live in `@plannotator/core/question-block` (shim `packages/shared/question-block.ts`, vendored to Pi): `parseQuestionBlock` (tolerant, returns null rather than throwing; an unparseable block falls back to the ordinary `Callout`), `indexQuestionBlocks`, `questionKey` (`q-` + hash8 of kind + prompt, so a reworded prompt is a new question), `QuestionAnswer` + the fail-closed `parseQuestionAnswer`, `questionStatus`, `formatQuestionAnswersSection`, and `QUESTION_AUTHORING_GUIDE`. `- [x]` means **settled** (the agent's echo of an earlier answer), `Recommended:` names the recommendation, "Other…", note and skip are always offered, and nothing is required.
- **An answer is one annotation** (`Annotation.questionAnswer`, id `ann-question-<key>`), so drafts, reload, undo, the panel and host persistence carry it with no second store. The highlighter skips these rows; every exporter prints them first under "Answers to your questions" (with an "Unanswered" list) and excludes them from the numbered feedback count. The editor adds the "N/M answered" header chip, the Questions section in the annotations panel, and plan review's **Send answers** primary (`isAnswersOnlyFeedback` in `packages/editor/questionDecision.ts`).
- **`plan.answered`.** Send answers posts `/api/deny` with `answersOnly: true` (`planDenyFeedbackFields`) and an unframed export. Both plan servers pass the flag onto the decision only when it is boolean `true`; every plan-deny consumer (the Claude Code / Codex / Gemini / Copilot / Vibe hook outputs and the `opencode-plan` JSON in `apps/hook/server/index.ts`, OpenCode 1 and 2 through `submit-plan-executor.ts`, Pi's `index.ts`) builds its message with `composePlanDeniedMessage` (`packages/shared/prompts.ts`), which picks `prompts.plan.answered` (default `DEFAULT_PLAN_ANSWERED_PROMPT`: "The user answered the questions in your plan…", plus the remove-or-`[x]` resubmit rule) for an answers-only deny and the unchanged denied prompt otherwise. A custom `plan.denied` does not replace the answered prompt. A deny that mixes answers with comments or edits keeps the denied prompt. Compatibility: a server that predates the flag ignores it and wraps the same export in its denied prompt; an older UI never sends it.
- **Claude Code Approve drops answers** (its hook allow carries no message); the existing "Feedback won't be sent" warning names them. No workaround in v1 (owner decision 1).
- **Agents learn the syntax** from the `plannotator` skill's "Asking the reviewer questions" section, which must equal `QUESTION_AUTHORING_GUIDE` byte for byte (`apps/hook/server/plannotator-skill-reference.test.ts` fails otherwise: edit the guide, then paste it into the skill), from the opt-in PFM reminder, and from the `plan.answered` prompt itself.
- **Feedback archive** records the validated answer per annotation as the additive `questionAnswer` field (`packages/shared/feedback-archive.ts`). Plan decisions archive no annotations array (pre-existing), so plan answers archive only inside `feedback`; annotate surfaces carry the structured field.
- **WebMCP** exposes questions read-only: `read_document` returns `questions` (number, key, kind, prompt, context, section, options with recommended/settled, status, the answer and its annotation id; orphaned answers with `q: null`) only when the document has any, and answer rows in `annotations` carry `answersQuestion`. No tool writes an answer, agent comments never carry `questionAnswer`, and `POST`/`PATCH /api/external-annotations` drop the field (owner decision 5).
- **Not covered in v1:** raw HTML, live apps, diagram files, code review, share links (an answer shares as a plain comment), and carrying answers across a resubmit other than through the agent's `[x]` echo.

## WebMCP (browser-agent tools)

The design document lives outside the tree (it is not checked in); the user-facing reference is `apps/marketing/src/content/docs/reference/webmcp-tools.md`. Phase 1 makes plan review and every annotate surface a WebMCP **provider**: a browser-integrated agent (Chrome/Edge origin trial, `chrome://flags/#enable-webmcp-testing` or `--enable-features=WebMCPTesting` locally; agent-embedded browsers unflagged) calls in-page tools instead of scraping the DOM. Code review (phase 2) and consuming the annotated app's own tools (phase 3) are not built.

**Shape (mirrors the shortcut system).** Engine in `packages/ui/webmcp/`: `modelContext.ts` is the ONLY file that spells `document.modelContext`, `registerTool`, `getTools`, `executeTool`, `toolchange` and the annotation hints (local structural types, no `webmcp-types` dependency, no `declare global`); `toolset.ts` (tool specs, the `{ ok, data, nudges, error? }` envelope, `runTool`, a per-document registry with reconcile-by-name and one `AbortController` per tool, since unregistration is only by abort); `changes.ts` (per-annotation `seq`, tombstones, per-tab watermark with `since` override, `claimOwn` so the agent's own writes are never "new" to it); `nudges.ts` (the twelve codes: `annotations_new`, `annotations_removed`, `replies_new`, `composer_open`, `source_stale`, `document_edited`, `comment_only_surface`, `page_changed`, `other_document_active`, `pending_unsent`, `session_decided`, `truncated`; messages are static strings, document and comment text never enter a message); `useToolset.ts` (React hook; handlers read through refs so a re-render never touches `registerTool`); `policy.ts` (the `webmcp` seam on `configurePlannotatorUI`, `{ enabled, namePrefix }`, default enabled with prefix `plannotator.`). Catalog in `packages/editor/webmcp/`: `documentTools.ts` builds the tools over a narrow `DocumentToolAdapter` (never imports App), `documentText.ts` holds the pure outline / windowing / quote-resolution helpers, `useDocumentWebMcp.ts` builds the adapter over App state through one ref.

**What is exposed.** `read_document` (the whole situation in one zero-argument call: session, text windowed at 16k chars cut at a block boundary with `textRange.nextOffset`, outline with per-section counts, every annotation with quote, context, `isNew` and thread ids, `otherDocuments`, nudges; `readOnlyHint` + `untrustedContentHint`), `add_comments` (1..20 items; anchoring cascade `inReplyTo` inherits the parent anchor, then `quote` resolved by text search with `section` to disambiguate, `ambiguous` returns candidate contexts, then `section` alone anchors on the heading, else a document-level note; `requestId` idempotency), `update_comment`, `remove_comments` (`destructiveHint`, ignored by today's dictionary on purpose), `reveal`, `nudge_user` (one transient banner, 280 chars, not persisted, not exported, dismissible), and `list_documents` in folder sessions only. Write tools are absent on archive and after the human's decision. Every tool-created comment is stamped `author` and `source: "browser-agent"` and renders exactly like an external-annotation comment.

**Rules.** (1) Decisions are human: there is no tool that approves, denies, submits feedback, closes the session, stages files or marks viewed, and there is no confirmation seam; the catalog test pins the names. (2) Ownership: the agent may update or remove only comments the tracker `claimOwn`ed in THIS page load (`AnnotationChangeTracker.isOwn`), never merely comments whose `source` reads `browser-agent`: `POST /api/external-annotations` accepts any `source`, so a stamp alone would let another tool's findings become agent-editable. Consequence: after a reload, the agent's earlier comments (restored from the draft) are read-only to it, like the human's; it replies instead. A `requestId` replayed after the human removed the comment it created answers `conflict` and never re-creates it. (3) Zero footprint without WebMCP: `resolveModelContext` runs once per mount; when `document.modelContext` is absent nothing is built, registered, rendered, fetched, scheduled or written. The opt-out is deliberately NOT a settings-registry entry: `configStore.ensureLoaded` seeds every registry default into a cookie on first settings access, on every surface including the guides.show viewer, so the preference lives in `packages/ui/webmcp/preference.ts`, is read lazily, and writes `plannotator-webmcp-tools=false` only when the user opts out (turning the tools back on removes the cookie). The phase-1 PR's A/B proof compared DOM shell, requests, console, timer counts and the cookie jar between the main and branch builds in a browser without the API and found no difference, and the portable viewer bundle is byte-identical to main. (4) Indicator policy: nothing visible appears merely because the API exists; only after the first successful tool call does the header show the small "Agent" affordance (`data-webmcp-indicator`). (5) Iframes: Plannotator never registers tools inside the untrusted frames, the srcdoc viewer keeps `sandbox="allow-scripts"` with no `allow` attribute and the live-app iframe gets no `allow="tools"`, so a framed page cannot register or impersonate tools (`packages/ui/webmcp/iframeIsolation.test.ts` pins this at source level; in Chrome both frames answer `NotAllowedError` for `getTools` and `registerTool`). (6) Opt-out: Settings > General > "Agent tools" (row shown only when the API exists) aborts every registration when off. (7) No server changes: the Pi and OpenCode builds get the feature through the built HTML.

**Folder sessions.** `list_documents` walks the file browser's loaded directories (`fileBrowser.dirs`, absolute path = `${dir.path}/${node.path}`, vault dirs excluded) so every document is listed, not only the ones already visited. The agent learns that the human navigated from `document.path` on its next response, not from a sibling flag: siblings exclude the open path, and after a sidebar click `fileBrowser.activeFile` equals `linkedDoc.filepath`, so a sibling with `open: true` (and with it `openedSinceLastRead` and the "opened" branch of `other_document_active`) exists only transiently, during the load window between the click and the document commit. `reveal { path }` answers `not_found` at once for a path that is neither in the folder tree nor in the linked-doc cache; otherwise it navigates (folder sessions through App's file-browser selection handler, so the active file, the doc URL and the linked document stay in step) and WAITS for the commit that makes that path the open document (an effect settles the waiter, and the linked-doc `error` state settles it early when the load fails, so a bad path never runs out the 5s timeout) before looking the comment or section up; reading state right after the `await` would see the pre-navigation document. After a tool mutation the adapter overlays the pending write on the last committed annotation list (`applyOverlay`) so the response's nudges and the new comment's `seq` reflect the mutation even though `setAnnotations` has not committed yet; the agent's own removals are claimed (`claimRemoved`) so they are never reported back to it as `annotations_removed`. Still not reachable in phase 1: `composerOpen` for a sibling (the composer is detected from the DOM of the open document only, so `other_document_active` never fires for a composer in another document), and writes to a sibling that is not open (see below).

**`inReplyTo`.** One additive field on `Annotation`: a reply inherits its parent's anchor, renders indented under it in the annotations panel (`threadReplies` in `AnnotationPanel.tsx`), and exports nested under the parent's entry (`**Replies:**` block in `exportAnnotations`); an annotation without it renders and exports byte-identically to before. The threading rule is shared (`resolveReplyParents` in `packages/core/annotation-threads.ts`): an annotation is a reply only when its target is a different annotation in the same list and the parent chain never returns to it; orphans, self-references, and every member of a cycle render and export as roots in original order, so nothing is ever dropped and the export's header count equals what is emitted. `PATCH /api/external-annotations` refuses an `inReplyTo` that is self, missing, or would close a cycle (`validateReplyTarget`, both runtimes, `400`). Drafts carry it (annotations are opaque JSON to the draft transport); share links deliberately do not (a reply shares as a plain comment on the same quote, the existing text-restore contract, pinned by `sharing.inReplyTo.test.ts`). Known limitation: comments on a sibling document that is not open answer `not_available` with a hint to `reveal { path }` first, because the linked-doc cache is a copy.

Docs: `apps/marketing/src/content/docs/reference/webmcp-tools.md` (the user-facing reference) and the manual five-flow checklist in `tests/UI-TESTING.md`.

## Keyboard Shortcuts

**Location:** `packages/ui/shortcuts/` (engine + scope data), `packages/editor/shortcuts.ts` and `packages/review-editor/shortcuts.ts` (per-app surfaces).

The shortcut system has three layers:

1. **Engine** (`packages/ui/shortcuts/{core,runtime}.ts`) — parser for declarative bindings (`Mod+Enter`, `Alt Alt` double-tap, `Alt hold`), dispatcher, platform-aware formatter (mac glyphs vs. `Ctrl`), validator, and the `useShortcutScope` / `useDoubleTapShortcuts` React hooks. Truly shared — both apps use it as-is.
2. **Scopes** — `defineShortcutScope({ id, title, shortcuts: { actionId: { bindings, description, section, ... } } })`. One scope per UI surface (annotation toolbar, comment popover, file tree, etc.). App-specific scopes live in `packages/ui/shortcuts/{plan-review,code-review}/` — **the subfolder names which app's UI the scope serves** — while genuinely cross-app scopes such as `history.shortcuts.ts` and `decisionControl.shortcuts.ts` (the header decision control's note-composer chords, mounted identically by both apps) live at the shortcuts root. Components/Apps wire handlers to a scope via `useShortcutScope({ scope, handlers: { actionId: () => ... } })`.
3. **Surfaces** (`packages/editor/shortcuts.ts`, `packages/review-editor/shortcuts.ts`) — each app composes its scopes into a `ShortcutSurface` (`planReviewSurface`, `annotateSurface`, `codeReviewSurface`). Surfaces feed both the in-app help modal and the marketing site's auto-generated docs page.

**Convention for adding new shortcuts:** define the action in the relevant app-specific subfolder (`plan-review/` or `code-review/`), or at the shortcuts root when both apps share the same action and semantics. Declare the binding(s) and description, then wire a handler at the call site with `useShortcutScope`. The marketing docs page picks it up automatically at next build. Unit tests in `packages/ui/shortcuts.test.ts` enforce normalized binding tokens (`Mod`, `Shift`, `Alt`, `A-Z`, `1-0`, named keys, `F1`–`F12`) and unique scope ids.

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

**Mermaid runtime (12.x, lazy):** `@plannotator/ui` pins `mermaid` exactly (12.0.0 since ui 0.40.0; Mermaid 12 lays flowchart/state/class/ER/requirement diagrams out with ELK by default and targets Safari 17.4+ / ES2024 — we take its defaults rather than pinning the 11.x ones). The runtime is loaded lazily on the first diagram through `packages/ui/utils/mermaid.ts`'s own `import('mermaid')`: `packages/editor/App.tsx` deliberately does NOT import `@plannotator/ui/utils/mermaid-eager` (it did through ui 0.39.0), so a plan with no diagram never downloads the ~2 MB runtime + ELK on the share portal or in a host build, and `tests/entry-assets.test.ts` fails if the eager import creeps back into either app. The single-file builds (`apps/hook`, `apps/review`, opencode, the compiled binary) still inline the runtime through `inlineDynamicImports`, so the lazy import saves nothing there and resolves from the bundle itself; the Mermaid 12 cost in those builds is the runtime's own growth. `MermaidBlock` shows the source fence under a "Rendering diagram" status until the first render lands (never the error panel as a placeholder), and `applyMermaidTheme` is keyed on the runtime object, so the lazily loaded runtime is themed on its first render exactly like an eagerly registered one. `mermaid-eager` stays exported for hosts that want the old startup registration.

**Diagram engine (ui 0.41.0):** every Mermaid and Graphviz diagram renders through ONE renderer slot and ONE canvas, the viewer moved in from Workspaces (owner ruling: the new engine, not an option). `MermaidBlock` and `GraphvizBlock` are thin wrappers over `packages/ui/components/DiagramBlock.tsx`, which keeps the fence side (`diagramLanguages.ts`, the pending fence under "Rendering diagram…", the error panel with the source, the per-engine Retry epoch, the Show-source toggle, the natural-height box) and renders `DiagramViewer` (`packages/ui/components/diagram/`) inline and again at full size in `DiagramPopout` (the `TablePopout` chrome; one code path). The renderer slot is `packages/ui/utils/diagram-render.ts`: `renderDiagram(kind, renderId, source, theme)` loads the engine through its runtime slot (`utils/mermaid.ts` as before, with `applyMermaidTheme` per (palette, mode) before every render; `utils/graphviz.ts`, new, the same shape, `@viz-js/viz` pinned exactly `3.30.0`), sanitizes the output into a NODE (`sanitizeDiagramSvg` = DOMPurify `parseDiagramSvg` + the in-place `scrubDiagramSvg` belt: no script, no `on*`, no `javascript:`/`data:` reference, no `<a href>` — a Mermaid click binding must never turn a pinpoint click into a navigation), and pairs it with the engine's finder (`utils/diagram-anchor.ts` for Mermaid's id grammar, `utils/diagram-anchor-graphviz.ts` keyed on `g.node > title`, never `nodeN`). A load failure is a value (`runtimeUnavailable: true`), which is the one failure Retry can change; one automatic re-attempt runs after the slot's retry delay. The canvas (`DiagramCanvas`) mounts the node with `replaceChildren` inside a CSS-transformed wrapper — wheel/drag/`+`/`-`/`0`/arrow keys; click-to-select vs drag-to-pan on a pointer-type-aware threshold (4 px mouse, 10 px finger); NO hover targeting on a plain mouse-over (owner ruling: it read as messy and fought the pan hand — the ring under the pointer appears only while the platform modifier is held, `isModKeyHeld`, and disarms on its release, on any other key, and on blur); canvas keys ignore Meta/Ctrl/Alt so browser chords pass through; inline the canvas is `touch-action: pan-y` (a finger scrolls the page past it) and only the popout is `touch-none`; the zoom strip is `data-print-hide` while rings and badges print. Every edge gets an invisible 14 px hit path in ONE layer appended last in the svg root (`widenEdgeHitAreas`: bare geometry, ancestors' transforms composed, no id/class/`data-*`, `diagramHitSource` maps it back) — measured in Chromium, the only thing painted over an edge is its OWN label box, centred on its midpoint, so a label is a target that resolves to its edge, and because the hit layer sits over the nodes the canvas resolves a click by PRIORITY over `elementsFromPoint` (node, then edge, then cluster), never by `event.target`. A click that resolves no part comments on the WHOLE diagram (kind `diagram`), so a click never does nothing. The scrub also scopes every `<style>` to rules under the svg's own root id (`scopeDiagramCss`: no `@import`, no fetching `url(`, no rule that could restyle the page). And the overlay (`DiagramOverlay`) reprojects rings and badges from `getBBox` through `getScreenCTM` each frame (`utils/diagram-projection.ts`), so they keep constant pixel size at every zoom. `components/mermaidSvg.ts` is gone. Under happy-dom DOMPurify is not functional (foreign-realm fragment, mislabelled svg namespaces, a cached `Node.prototype.nodeName` getter), so DOM tests swap the parse step for an inert XML parse through `__setDiagramSvgParserForTests` (`packages/ui/test-setup/diagramSvg.ts`) while the scrub still runs; the DOMPurify parse is proven in Chromium (the parity run in the PR that landed it). Real rendered svgs for the codec tests live in `packages/ui/test-setup/fixtures/diagrams/` with Chromium-measured geometry beside them.

**Diagram theming (Mermaid):** diagrams follow the palette and mode the same way fences do, through ONE dynamic mapping rather than per-palette themes. `packages/ui/utils/mermaidTheme.ts` reads the live CSS tokens off the document element (`readThemeTokens`: `--background`, `--foreground`, `--card`, `--border`, `--muted`, `--muted-foreground`, `--primary`, the accent tokens, `--font-sans`), derives a complete Mermaid `themeVariables` set for every diagram family from them (`buildMermaidThemeVariables(tokens, mode)`, pure; base theme `dark` under a dark resolved mode, `default` under light; node fill from `card`, borders from `border`, edges and arrowheads from `muted-foreground`, text from `foreground`/`card-foreground`, clusters from `muted`, twelve categorical fills for pie/git/mindmap/journey seeded from `primary`, `accent`, `success`, `warning`, `destructive` and normalized to one lightness per page polarity), and `MermaidBlock` runs the global `mermaid.initialize` through `applyMermaidTheme` once per `(palette, mode, shadow amount)` key from `useTheme()` before each render, re-rendering mounted diagrams when the key changes. Every colour handed to Mermaid is opaque hex (its colour library does not read `oklch()`), and a contrast guard (`ensureContrast`) repairs any text-on-fill pair under WCAG 4.5:1 or line-on-canvas pair under 3:1 (plus 0.1 headroom) by the smallest OKLab step toward `foreground`, then `background`, then pure black/white — guarding page-level text and lines against every surface they can cross (the `bg-muted/30` canvas over the document card and over the bare page, `card`, `muted`, `popover`, ER rows), not the page background alone; `mermaidTheme.test.ts` sweeps every palette in `packages/ui/themes` in both modes against that rule, so a new palette cannot regress it. The pure toolkit behind it is `packages/ui/utils/cssColor.ts`. **Node shadow:** Mermaid 12's neo look shadows every node, cluster and actor from its own fixed `drop-shadow(1px 2px 2px rgba(185,185,185,1))` grey, which reads as a halo on a themed page. The look is kept and that one filter is replaced: `buildMermaidThemeVariables` sets `themeVariables.dropShadow` from `buildMermaidShadow(ground, amount)` at `DEFAULT_MERMAID_SHADOW_AMOUNT` (**0.7**, i.e. 70 on the user-facing 0-100 scale, where 100 reproduces Mermaid's own geometry exactly and 0 publishes `dropShadow: false` — plus `nodeShadow: false`, the only thing that reaches a state diagram's inline-filtered start/end dots — which the neo rules render as `filter: none`). The colour is derived from the palette's own ground and its POLARITY follows the page, the same way Mermaid's `insertLookDefs` picks a white flood colour on dark themes: on a dark page the ground lifted 82% toward white at alpha `0.18 + 0.72a`, on a light page darkened 40% toward black at `0.25 + 0.3a`, each asserted to differ from the ground in the direction that reads (white/black as the fallback, Mermaid's grey when the palette yields no usable ground). A black shadow on a near-black ground is a valid filter that paints nothing, which is why polarity — not just alpha — follows the page. The amount is the cookie-only `diagramShadow` setting (Settings → Display → "Diagram Shadow", steps 0/40/70/100, `packages/ui/utils/diagramShadow.ts`), which rides into the renderer as `DiagramTheme.shadowAmount` and into the cache key; at the default the key is byte-identical to the old `(palette, mode)` one. It is a paint-time filter only: fills and label colours are identical at every amount (pinned in `mermaidTheme.test.ts`). **Host fallback:** with no theme tokens on the document `readThemeTokens` returns `undefined` and the runtime keeps the static `MERMAID_CONFIG` (still `securityLevel: 'strict'`, pinned) with no extra `initialize`, so a host without `ThemeProvider`/`theme.css` renders exactly as before — that config carries the same 70 geometry with a fixed light shadow colour, since its own slate theme is dark. A host that wants Mermaid's grey back sets its own `themeVariables.dropShadow` after ours; one that wants no shadow passes `shadowAmount: 0`. Do not add per-palette Mermaid themes or per-theme `.mermaid` CSS — extend the token mapping instead. Graphviz has no theme system, so the renderer slot's `themeGraphvizSvg` recolors the DOT DEFAULTS onto the tokens after the scrub (the white page polygon removed, `fill="none"` → `var(--card)`, default black strokes → `var(--foreground)` on nodes and edges and `var(--border)` on clusters, `lightgrey` → `var(--muted)`, text → `var(--foreground)`) and leaves every author color alone; it needs no per-palette equivalent.

**Printing (light half, one rule):** paper is white, so the whole page prints in
the **LIGHT half of the user's pair** — prose, code and diagrams together.
`ThemeProvider` forces `preferredMode` to `light` while printing
(`packages/ui/hooks/usePrintMedia.ts`), which flows through the existing
`applyThemeClasses` and, because `applyMermaidTheme` is keyed on
`(palette, mode)`, re-renders every mounted diagram in the light palette;
Graphviz follows with no re-render at all, since `themeGraphvizSvg` paints
`var(--*)` tokens. Two signals drive it, because neither covers every path:
`beforeprint` / `afterprint` (a real Cmd+P and print preview — the class write
happens INSIDE the handler, since the print snapshot is taken before React
would flush a state update) and a `matchMedia('print')` change (headless
`page.emulateMedia({ media: 'print' })`, where the async diagram re-render also
lands). The stored preference is never written, and a light-mode user sees no
change. `usePrintMode` shares the subscription, so `.plannotator-print` is
applied under print emulation too.

`print.css` exempts diagram content from its typography rules with
`:not([data-diagram-block] *)` on the blanket `body, div, span, p, …` selector
and its `strong` / `em` / `p` siblings. A diagram colours itself and its own
`<style>` carries no `!important`, so the blanket rule beat it: Mermaid 12
draws node and edge labels as real HTML inside `<foreignObject>`
(`span.nodeLabel > p`, `span.edgeLabel`), which is how a dark-palette flowchart
used to print as empty boxes — near-black text on a near-black node fill. The
zoom strip stays `data-print-hide`; rings and badges still print.

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
