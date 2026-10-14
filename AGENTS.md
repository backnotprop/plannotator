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
│   ├── review/                   # Standalone review server (for development)
│   │   ├── index.html
│   │   ├── index.tsx
│   │   └── vite.config.ts
│   ├── guides-show/               # guides.show — portable Guided Review viewer (multi-file CDN build) + Cloudflare Worker (viewer/, worker/, share/, build/); the Worker is the only host target, self-hosting = deploying it under your own account
│   ├── relay/                     # The Inbox relay (mobile steps R1, R2, R3): a Cloudflare Worker + one Durable Object per mailbox (src/index.ts, src/mailbox.ts), holding only ciphertext and hashes: pushes, and the phone's reads and answers while it is away; src/apns-h2.ts is a standalone HTTP/2 client for APNs over connect(); src/fcm.ts sends Android pushes through FCM HTTP v1 with plain fetch. Private, own version line, owner-deployed (never from CI; README.md has the deploy); its proof (test/) runs `wrangler dev` in the relay workflow and is skipped by the root `bun test`
│   ├── vscode-extension/         # VS Code extension — opens plans in editor tabs
│   │   ├── bin/                   # Router scripts (open-in-vscode, xdg-open)
│   │   ├── src/                   # extension.ts, cookie-proxy.ts, ipc-server.ts, panel-manager.ts, editor-annotations.ts, vscode-theme.ts
│   │   └── package.json           # Extension manifest (publisher: backnotprop)
│   └── skills/                    # Agent skills (agentskills.io format)
│       ├── core/                  # CORE skills (single-sourced) — installed to ~/.claude/skills and ~/.agents/skills (Codex)
│       │   ├── plannotator/           # Knowledge layer: model-invocable CLI reference (subcommands, flags, exit codes) an agent loads on generic "use Plannotator" intent; freshness-guarded against apps/hook/server/cli.ts by plannotator-skill-reference.test.ts. Unreleased subcommands (`HIDDEN_SUBCOMMANDS` in cli.ts: today `t3` and `t3-hook`, the opt-in T3 Code connection; `inbox` was the last to launch) still run and keep `<sub> --help`, but stay out of `plannotator --help`, "Did you mean" suggestions and this skill (the test requires their absence); un-hide by deleting from that set, adding the top-level usage lines and documenting it here
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

## Environment Variables

Every `PLANNOTATOR_*` environment variable (remote mode, ports, browser, agent terminal and so on), with what each one does and its allowed values.

Details: [docs/overview/environment-variables.md](docs/overview/environment-variables.md) — read it before working on Environment Variables.

## Plan Review Flow

How a plan review runs from `ExitPlanMode` to the approve/deny result, per host: Claude Code, Codex, Pi, OpenCode and T3 Code, including the non-blocking modes and the `plannotator` tool.

Details: [docs/overview/plan-review-flow.md](docs/overview/plan-review-flow.md) — read it before working on Plan Review Flow.

## Code Review Flow

How `/plannotator-review` runs: the diff targets, the header decision control, drafts and PR pushes, file kinds, viewed-file progress, markdown and image previews, and Ask AI context.

Details: [docs/overview/code-review-flow.md](docs/overview/code-review-flow.md) — read it before working on Code Review Flow.

## Ask AI Provider Defaults

Which Ask AI provider the UI picks as the default for each Plannotator origin, and how installed CLIs are detected.

Details: [docs/overview/ask-ai-provider-defaults.md](docs/overview/ask-ai-provider-defaults.md) — read it before working on Ask AI Provider Defaults.

## Annotate Flow

How `/plannotator-annotate` runs on a file, URL, folder or live app: argument resolution, multi-file bundles, drafts, the header decision control, and strict-gate results.

Details: [docs/overview/annotate-flow.md](docs/overview/annotate-flow.md) — read it before working on Annotate Flow.

## Plannotator Inbox

The Inbox: the local server where agents leave messages, `:::question` blocks, files and guided reviews, how replies wake the asking session, and the command, storage and connection details.

Details: [docs/overview/plannotator-inbox.md](docs/overview/plannotator-inbox.md) — read it before working on Plannotator Inbox.

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

HTTP endpoint tables for the Plan, Review, Annotate and Inbox servers, plus the host allowlist, host session control and the paste service.

Details: [docs/overview/server-api.md](docs/overview/server-api.md) — read it before working on Server API.

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

- Headings (1 to 6 `#` then a space or end of line, CommonMark ATX; `#123 fixed` and `#hashtag` are text) with slug-derived anchor ids
- Code blocks (``` with language extraction)
- List items (`-`, `*`, `1.`)
- Blockquotes (`>`) — a run of consecutive `>` lines is ONE block whose `content` is the quote's own markdown (`>` plus one space stripped per line); `BlockquoteBlock` parses it again and renders fences, lists and nested quotes inside the one quote, with no `data-block-id` on the inner blocks, so the quote stays one annotatable block. GitHub alerts (`> [!NOTE|TIP|WARNING|CAUTION|IMPORTANT]`) set `alertKind` and keep `AlertBlock`
- Horizontal rules (`---`)
- Tables (pipe-delimited) — rendered via `TableBlock` with a `TableToolbar` (copy as markdown/CSV) and `TablePopout` overlay
- Raw HTML blocks (`<details>`, `<summary>`, etc.) — rendered via `HtmlBlock` through `marked` + DOMPurify
- Directive containers (`:::kind ... :::`) — rendered via `Callout`
- Paragraphs (default) with inline extras: bare URL autolinks, `@mentions` / `#issue-refs`, emoji shortcodes, smart punctuation

`exportAnnotations(blocks, annotations, globalAttachments)` generates human-readable feedback for Claude. Images are referenced by name: `[image-name] /tmp/path...`. Annotations with `diffContext` include `[In diff content]` labels.

## Annotation System

How annotations are created, anchored and rendered in the document UI: selection and redline modes, text highlighting, and the annotation types.

Details: [docs/overview/annotation-system.md](docs/overview/annotation-system.md) — read it before working on Annotation System.

## Question blocks

An agent can ask the reviewer a question inside a plan or document with a `:::question` (pick one), `:::question-multi` (pick any) or `:::question-text` (free text) directive; the reviewer answers on a card in place. Approved design: a spec plus the owner's approval, which overrides it (design record, not in this repo). Shipped as core+ui (#1637), editor (#1638) and the agent side (prompt, skill, archive, WebMCP).

- **Grammar and data** live in `@plannotator/core/question-block` (shim `packages/shared/question-block.ts`, vendored to Pi): `parseQuestionBlock` (tolerant, returns null rather than throwing; an unparseable block falls back to the ordinary `Callout`), `indexQuestionBlocks`, `questionKey` (`q-` + hash8 of kind + prompt, so a reworded prompt is a new question), `QuestionAnswer` + the fail-closed `parseQuestionAnswer`, `questionStatus`, `formatQuestionAnswersSection`, and `QUESTION_AUTHORING_GUIDE`. `- [x]` means **settled** (the agent's echo of an earlier answer), `Recommended:` names the recommendation, "Other…", note and skip are always offered, and nothing is required. A `Replaces: <message id>/<key>` line (the Inbox's replaced questions) is read into `replaces` only when every token on it is id-shaped; it is then never the prompt or context and does not change the key, and any other `Replaces:` line stays prose. A picked label is kept whole: `parseQuestionAnswer` caps each `selected` label at `MAX_QUESTION_SELECTED_CHARS` (the body cap), never at the 200-character `MAX_QUESTION_CHOICE_LABEL_CHARS` (that one only shortens a plain-bullet label at a sentence end), because task-list labels are never cut and a shorter cap made a long choice unpickable (the Inbox answered `422 … is not one of the question's choices`; fixed after 0.28.17). `canonicalQuestionAnswer` maps an answer cut at 200 by an older build back to its one choice.
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

The single Shiki-based highlighter (`@pierre/diffs`, JS regex engine) and its wrapper `packages/ui/utils/codeHighlight.ts`, used by code blocks and the diff pane.

Details: [docs/overview/syntax-highlighting.md](docs/overview/syntax-highlighting.md) — read it before working on Syntax Highlighting.

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
