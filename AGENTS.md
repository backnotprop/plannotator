# Plannotator

A plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. Also provides code review for git diffs and annotation of arbitrary markdown files.

> **Reusing the document UI (theme / markdown / editor / settings / comments / layout) in the commercial Workspaces app? Read `packages/ui/README.md` FIRST.** It explains the published `@plannotator/ui` + `@plannotator/core` packages and the host-override seams a host plugs its own backend into via `configurePlannotatorUI()`. A prior from-scratch reimplementation of this UI broke the app and was reverted — do **not** rebuild it or recreate `packages/document-ui`. Add a seam to `@plannotator/ui` instead, keep Plannotator's app unchanged, and never delete working code until a human confirms parity in the browser.

## Project Structure

The monorepo layout: every app and package directory (hook, opencode-plugin, paste-service, server, ui, core and others) with what each file or folder is for.

Details: [docs/overview/project-structure.md](docs/overview/project-structure.md) — read it before working on Project Structure.

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

How every submitted review is durably archived at decision-settlement time, the per-project layout and JSONL line format, and the one exception for reviews posted straight to a Git host.

Details: [docs/overview/feedback-archive.md](docs/overview/feedback-archive.md) — read it before working on Feedback Archive.

## Plan Diff

How the UI shows what changed between plan versions: the diff engine, the Classic, Rendered and Raw view modes, base-version state, and diff annotations.

Details: [docs/overview/plan-diff.md](docs/overview/plan-diff.md) — read it before working on Plan Diff.

## Portable Guided Reviews

How a Guided Review exports as one self-contained HTML file, the invariants that keep the exported diff and viewer stable, and hosted share links.

Details: [docs/overview/portable-guided-reviews.md](docs/overview/portable-guided-reviews.md) — read it before working on Portable Guided Reviews.

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

How an agent asks the reviewer a question with `:::question`, `:::question-multi` or `:::question-text` blocks, how an answer is stored as one annotation, and how answers reach the agent, the archive and WebMCP.

Details: [docs/overview/question-blocks.md](docs/overview/question-blocks.md) — read it before working on Question blocks.

## WebMCP (browser-agent tools)

The WebMCP tools that plan review and annotate sessions expose to browser agents: the engine in `packages/ui/webmcp/`, the tool catalog, the rules (decisions stay human), folder sessions and `inReplyTo`.

Details: [docs/overview/webmcp-browser-agent-tools.md](docs/overview/webmcp-browser-agent-tools.md) — read it before working on WebMCP (browser-agent tools).

## Keyboard Shortcuts

The shortcut system: the engine, per-surface scopes and the plan review, annotate and code review surfaces, plus the convention for adding a shortcut and the generated marketing reference.

Details: [docs/overview/keyboard-shortcuts.md](docs/overview/keyboard-shortcuts.md) — read it before working on Keyboard Shortcuts.

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

## Development

This document describes the technical details behind Plannotator's development. If you would like to open a pull request or implement a new feature in Plannotator, read [DEVELOPMENT.md](DEVELOPMENT.md).

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
