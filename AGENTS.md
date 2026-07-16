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
│   │   ├── index.ts              # Plugin entry with submit_plan tool + review/annotate event handlers
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
│       └── extra/                 # EXTRA skills — NOT default-installed (except Kiro); add via `npx skills add backnotprop/plannotator/apps/skills/extra`
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
| `PLANNOTATOR_REMOTE` | Set to `1` / `true` for remote mode, `0` / `false` for local mode, or leave unset for SSH auto-detection. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. |
| `PLANNOTATOR_AGENT_TERMINAL_REMOTE` | Set to `1` / `true` to enable the annotate-mode agent terminal while `PLANNOTATOR_REMOTE` is active. Off by default because remote mode binds beyond localhost. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_SHARE` | Set to `disabled` to turn off URL sharing entirely. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "share": "disabled" }`); the env var takes precedence. |
| `PLANNOTATOR_SHARE_URL` | Custom base URL for share links (self-hosted portal). Default: `https://share.plannotator.ai`. |
| `PLANNOTATOR_PASTE_URL` | Base URL of the paste service API for short URL sharing. Default: `https://plannotator-paste.plannotator.workers.dev`. |
| `PLANNOTATOR_ORIGIN` | Explicit agent-origin override at the top of the detection chain. Valid values: `claude-code`, `amp`, `droid`, `opencode`, `codex`, `copilot-cli`, `gemini-cli`, `kiro-cli`, `pi`. Invalid values silently fall through to env-based detection. Unset by default. |
| `PLANNOTATOR_JINA` | Set to `0` / `false` to disable Jina Reader for URL annotation, or `1` / `true` to enable. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "jina": false }`) or per-invocation via `--no-jina`. |
| `PLANNOTATOR_ANNOTATE_HISTORY` | Set to `0` / `false` to disable per-file version history in annotate mode (no copies of annotated files are written to the data dir; the annotate version diff is unavailable). Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "annotateHistory": false }`); the env var takes precedence. |
| `JINA_API_KEY` | Optional Jina Reader API key for higher rate limits (500 RPM vs 20 RPM unauthenticated). Free keys include 10M tokens. |
| `PLANNOTATOR_DATA_DIR` | Override the base data directory. Supports `~` expansion. Default: `~/.plannotator`. All data (plans, history, drafts, config, hooks, sessions, debug logs, IPC registry) is stored under this directory. |
| `PLANNOTATOR_FILE_BROWSER_MAX_FILES` | File-discovery limit: regular files inspected by CLI markdown/folder resolution and startup code-file warming, and supported files returned by the file browser. Must be a positive integer; invalid, zero, or negative values use the default of `5000`. |
| `PLANNOTATOR_GLIMPSE` | Set to `0` / `false` to disable the Glimpse native window even when `glimpseui` is installed. Default: enabled. Can also be set via `~/.plannotator/config.json` (`{ "glimpse": false }`). |
| `PLANNOTATOR_GLIMPSE_WIDTH` | Width in pixels for the Glimpse native window. Default: `1280`. |
| `PLANNOTATOR_GLIMPSE_HEIGHT` | Height in pixels for the Glimpse native window. Default: `900`. |
| `PLANNOTATOR_VERIFY_ATTESTATION` | **Read by the install scripts only**, not by the runtime binary. Set to `1` / `true` to have `scripts/install.sh` / `install.ps1` / `install.cmd` run `gh attestation verify` on every install. Off by default. Can also be set persistently via `~/.plannotator/config.json` (`{ "verifyAttestation": true }`) or per-invocation via `--verify-attestation`. Requires `gh` installed and authenticated. |
| `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL` | Set to `1` / `true` to skip installing the managed Node/WebTUI runtime used by compiled Bun builds for the annotate-mode agent terminal. Read by `plannotator install-runtime agent-terminal`, which the installers call automatically. |
| `PLANNOTATOR_MINIMAL` | **Read by the install scripts only**, not by the runtime binary. Set to `1` / `true` / `yes` to have `scripts/install.sh` / `install.ps1` / `install.cmd` install **only** the `plannotator` binary — skipping the sem sidecar, the agent-terminal runtime, and all per-agent skills, hooks, slash commands, and config. Equivalent to the `--minimal` (aliased `--binary-only`) flag; `--no-minimal` overrides it. Off by default. |
| `PLANNOTATOR_SKIP_SEM_INSTALL` | **Read by the install scripts only.** Set to `1` / `true` to skip installing the optional `sem` semantic-diff sidecar (used by code review). Off by default. |

**Config-only settings (`~/.plannotator/config.json`)**: Some settings have no env-var equivalent and are toggled by editing the config file directly:

- `pfmReminder` (`true` / `false`, default `false`) — when enabled, a Plannotator Flavored Markdown reminder is injected at plan-time describing the renderer's extensions (code-file links, callouts, tables, diagrams, task lists, hex swatches, wiki-links). Lets the planning agent enrich plans with PFM features without having to discover them. Composes cleanly with the compound-skill improvement hook. Supported across all three runtimes: Claude Code (`improve-context` PreToolUse hook in `apps/hook/server/index.ts`), OpenCode (`experimental.chat.system.transform` in `apps/opencode-plugin/index.ts`), and Pi (`before_agent_start` in `apps/pi-extension/index.ts`).

**Legacy:** `SSH_TTY` and `SSH_CONNECTION` are still detected when `PLANNOTATOR_REMOTE` is unset. Set `PLANNOTATOR_REMOTE=1` / `true` to force remote mode or `0` / `false` to force local mode.

**Devcontainer/SSH usage:**
```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999
```

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
VCS diff captures local changes (git diff or jj diff). When review runs from a
non-VCS parent that contains nested Git repos, child diffs are combined with
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

The default code-review diff is **`since-base`** — a composite of `merge-base(base, HEAD)` vs the working tree plus untracked files ("everything a PR would show if you committed and pushed now"). It renders as a three-section **git status** panel (Committed / Changes / Untracked) via `SectionsPanel`, with a `Git status | Tree | Commits` toggle (`PanelViewToggle`). The Commits segment (git-local sessions only) is a linear `--first-parent` history rail (`CommitsPanel`): clicking a commit opens its own diff (`commit:<sha>`, vs its first parent) as the all-files view headed by the commit message rendered as markdown. The toggle is fully SESSION-scoped — it never writes settings. The OPENING view is persisted in the cookie-only `reviewPanelView` config (`sections` | `tree` — never `commits`; the Commits view is session-only) and is written only by Settings and `ReviewSetupDialog`; the diff default lives in `defaultDiffType`. The persisted pair is coupled: the Sections view only renders `since-base`, so choosing a classic diff default snaps the persisted view to Tree and vice-versa (enforced in `ReviewSetupDialog`, the Settings Git tab, and the App first-run reset).

**Staging display invariant:** `useGitAdd`'s `stagedFiles` is the EFFECTIVE staged set (sections-sidecar snapshot + session stage/unstage overrides) and is the only source any surface may render staging state from. The sidecar entry's `staged` flag is a snapshot — ORing it back in makes files unstaged mid-session render as staged (and inverts the next toggle).

`since-base` is only offered when the base ref actually resolves — on a repo whose trunk isn't discoverable (`trunk`, no `origin/HEAD`) `getGitContext` omits it and the default falls through to `uncommitted`, so committed branch work is never silently hidden. The since-base patch/sections/fingerprint/file-content paths all degrade to `HEAD` together when merge-base fails for a resolvable-but-unrelated base. First-run shows `ReviewSetupDialog` (replaces the removed `DiffTypeSetupDialog`), which resets everyone to Git-status + since-base once and is reopenable from the review header menu. A one-time `GuideIntroDialog` (guided-reviews announcement) precedes it in the dialog chain (guide intro → look-and-feel → review setup); the three never stack.

### Code-review Ask AI context

Ask AI's "changes under review" context for **code review** is generated by the shared agent-review prompt machine (`buildAgentReviewUserMessage` / `buildAgentReviewUserMessageForTarget` in `packages/server/agent-review-message.ts`) — the same machine the launchable review jobs use — and is **delivered on the user's messages, not the system prompt**. The review server computes it for the current view (`buildCurrentAiReviewContext` in `packages/server/review.ts`, mirrored in `apps/pi-extension/server/serverReview.ts`) and ships it as `aiReviewContext` in the diff payloads (`/api/diff` and the switch/PR endpoints). The client (`packages/review-editor`) latches it onto each question via `buildReviewContextPreamble` (`packages/ui/utils/aiPrompt.ts`): the full block on the first message and whenever the view changes, a short reminder otherwise (never re-pasting a large diff). This keeps the agent looking at exactly the on-screen changeset across every mode (uncommitted/untracked, branch, merge-base, stacked-PR full-stack, hide-whitespace, PR worktrees, workspace, jj). The code-review system prompt (`buildCodeReviewPrompt` in `packages/ai/context.ts`) is intentionally role-only.

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

Per-origin choices are persisted in cookies, so a user can override the automatic match for one agent without changing the default for another.

> **Codex transport note:** the `codex-sdk` provider id is a stable identifier only — it no longer uses `@openai/codex-sdk` / `codex exec`. It drives a long-lived `codex app-server` process over JSON-RPC (`packages/ai/providers/codex-app-server.ts`), which respects the user's/enterprise-managed approval policy and supports interactive Allow/Deny approvals. The id stays `codex-sdk` to preserve saved cookie preferences, the `agents.ts` mapping, and the UI reasoning-effort gate.

## Annotate Flow

```
User runs /plannotator-annotate <file.md | file.html | https://... | folder/>
        ↓
Claude Code: plannotator annotate subcommand runs
OpenCode/Pi: event handler intercepts command
        ↓
Input type detected:
  .md/.mdx   → file read from disk
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

## Archive Flow

```
User runs plannotator archive (CLI)
        ↓
Server starts in mode:"archive", reads ~/.plannotator/plans/
        ↓
Browser opens read-only archive viewer (sharing disabled)
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
| `/api/diff`           | GET    | Returns `{ rawPatch, gitRef, snapshotId, origin, mode?, diffType, base, hideWhitespace, gitContext, agentCwd?, semanticDiff?, sections?, commitInfo?, baseBehindRemote? }`. `snapshotId` identifies this diff snapshot; the client echoes it on `/api/diff/fresh` probes (also returned by the switch/PR endpoints). `sections` is the since-base sidecar (Committed/Changes/Untracked partition); `commitInfo` is the commit-metadata sidecar (subject, markdown body, author + avatar) present only while a `commit:<sha>` diff is active; `baseBehindRemote` flags that the diff base is behind its remote tip. Workspace mode returns `mode: "workspace"` with folder-prefixed paths and no `gitContext`. |
| `/api/diff/switch`    | POST   | Switch diff type, base branch, or whitespace mode (body: `{ diffType, base?, hideWhitespace?, explicitBase? }` — `diffType` includes the `commit:<sha>` family). `explicitBase: true` marks a base the user picked from the picker — the server then honors it verbatim and permanently disables the bare-local-name → `origin/*` canonicalization for the session (echoed bases stay canonicalizable). Response includes `semanticDiff?`, `sections?`, `commitInfo?`, `baseBehindRemote?`, or `{ superseded: true }` when a newer concurrent switch has taken over (client ignores it). |
| `/api/commits`        | GET    | One page of the branch's linear `--first-parent` history for the Commits panel (`?limit=&before=`) → `{ commits, hasMore, base }`. Rows carry `isHead` / `isPastBase` (where the branch meets the active base) and best-effort author `avatarUrl`. Plain local git sessions only (PR/workspace/jj/p4 → 400); computed against the active diff's cwd, so worktree sessions list the worktree's history. |
| `/api/diff/fresh`     | GET    | Cheap staleness probe: recomputes the VCS fingerprint captured with the current diff snapshot and returns `{ fresh, fingerprint?, baseBehindRemote?, agentCwd? }`. Accepts `?snapshot=<id>` — the client echoes the `snapshotId` it received with its diff, and a mismatch with the server's current snapshot reports stale PER CLIENT (covers the startup base upgrade and cross-tab switches even when the VCS fingerprint matches). `baseBehindRemote` is carried on every response (omitting it would flicker the "behind GitHub" banner); `agentCwd` re-advertises the PR checkout in PR mode. Unfingerprintable modes (e.g. P4) always report fresh to a matching snapshot. Polled by the UI's "Diff out of date · Refresh" notice. |
| `/api/fetch-base`     | POST   | Runs `git fetch` for the base's remote tracking ref, then re-queries the remote tip (fresh `ls-remote`) so narrow-refspec fetches report honestly. Backs the "Baseline is behind GitHub · Fetch" banner. Git-only, base-relative diff types only. |
| `/api/semantic-diff`  | GET    | Runs semantic diff for the active patch and returns parsed sem output or an unavailable/error response (`?fileExt=` / `?fileExts=` optional). |
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
| `/api/agents/jobs/stream` | GET | SSE stream for real-time agent job status updates |
| `/api/agents/jobs` | GET | Snapshot of agent jobs (polling fallback, `?since=N` for version gating) |
| `/api/agents/jobs` | POST | Launch an agent job (body: `{ provider, command, label, engine?, model?, effort?, reasoningEffort?, thinking?, fastMode?, reviewProfileId?, repairOf? }`) |
| `/api/agents/jobs` | DELETE | Kill all running agent jobs |
| `/api/agents/jobs/:id` | DELETE | Kill a specific agent job |
| `/api/pr-diff-scope` | POST | Switch between layer and full-stack diff scope. Response includes `semanticDiff?`. |
| `/api/pr-list` | GET | List PRs for the current repo (cached 30s) |
| `/api/pr-switch` | POST | Switch to a different PR in-place (body: `{ url }`). Response includes `semanticDiff?`. |
| `/api/tour/:jobId` | GET | Fetch Code Tour result (greeting, stops, checklist) for a completed tour job |
| `/api/tour/:jobId/checklist` | PUT | Persist checklist item state for a Code Tour |
| `/api/guide/:jobId` | GET | Fetch Guided Review result (ordered sections with overviews + file refs) for a completed guide job |
| `/api/guide/:jobId/reviewed` | PUT | Persist per-section reviewed state for a guide |
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
| `/api/draft`          | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |
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

**Annotate mode** also saves history on open, so the same version diff works when annotating a standalone `.md`/`.txt`/`.html` file. It keys the slug by **file path** — `annotate-{sanitized-basename}-{hash8}` — rather than heading + date, so re-opening the same file groups its versions even as its content (and headings) change. **Note this writes a copy of each annotated file's content** under `~/.plannotator/history/` (or `PLANNOTATOR_DATA_DIR`); disable via `PLANNOTATOR_ANNOTATE_HISTORY=0` or `{ "annotateHistory": false }` in `~/.plannotator/config.json` to keep annotate sessions stateless (the version diff is then unavailable). For `--render-html` files the diff is rendered as the real page with inline `<ins>`/`<del>` highlights via `htmlDiff()` (`packages/shared/html-diff.ts`).

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
  startMeta?: { parentTagName; parentIndex; textOffset };
  endMeta?: { parentTagName; parentIndex; textOffset };
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

## Settings Persistence

**Location:** `packages/ui/utils/storage.ts`, `planSave.ts`, `agentSwitch.ts`

Uses cookies (not localStorage) because each hook invocation runs on a random port. Settings include identity, plan saving (enabled/custom path), and agent switching (OpenCode only).

## Syntax Highlighting

Code blocks use bundled `highlight.js`. Language is extracted from fence (```rust) and applied as `language-{lang}`class. Each block highlighted individually via`hljs.highlightElement()`.

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
