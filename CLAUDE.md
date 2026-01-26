# Plannotator

A plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. Also provides code review for git diffs.

## Project Structure

```
plannotator/
├── apps/
│   ├── hook/                     # Claude Code plugin
│   │   ├── .claude-plugin/plugin.json
│   │   ├── commands/             # Slash commands (plannotator-review.md, plannotator-annotate.md)
│   │   ├── hooks/hooks.json      # PermissionRequest hook config
│   │   ├── server/index.ts       # Entry point (plan + review + annotate subcommands)
│   │   └── dist/                 # Built single-file apps (index.html, review.html)
│   └── review/                   # Standalone review server (for development)
│       ├── index.html
│       ├── index.tsx
│       └── vite.config.ts
├── packages/
│   ├── core/                     # Shared types and utilities (CUSTOM)
│   │   ├── types.ts              # AnnotationType, ReviewTag, Annotation, Block
│   │   ├── parser.ts             # parseMarkdownToBlocks(), exportDiff()
│   │   ├── markers.ts            # injectValidationMarkers(), extractValidationMarkers()
│   │   └── index.ts              # Re-exports
│   ├── server/                   # Shared server implementation
│   │   ├── index.ts              # startPlannotatorServer(), handleServerReady()
│   │   ├── annotate.ts           # startAnnotateServer() (CUSTOM)
│   │   ├── review.ts             # startReviewServer(), handleReviewServerReady()
│   │   ├── storage.ts            # Plan saving to disk (getPlanDir, savePlan, etc.)
│   │   ├── remote.ts             # isRemoteSession(), getServerPort()
│   │   ├── browser.ts            # openBrowser()
│   │   ├── integrations.ts       # Obsidian, Bear integrations
│   │   └── project.ts            # Project name detection for tags
│   ├── ui/                       # Shared React components
│   │   ├── components/           # Viewer, Toolbar, Settings, etc.
│   │   ├── utils/                # sharing.ts, storage.ts, planSave.ts, agentSwitch.ts
│   │   ├── hooks/                # useSharing.ts
│   │   └── types.ts              # Re-exports from @plannotator/core
│   ├── editor/                   # Plan review App.tsx
│   └── review-editor/            # Code review UI
│       ├── App.tsx               # Main review app
│       ├── components/           # DiffViewer, FileTree, ReviewPanel
│       ├── demoData.ts           # Demo diff for standalone mode
│       └── index.css             # Review-specific styles
├── .claude-plugin/marketplace.json  # For marketplace install
└── legacy/                       # Old pre-monorepo code (reference only)
```

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
| `PLANNOTATOR_REMOTE` | Set to `1` or `true` for remote mode (devcontainer, SSH). Uses fixed port and skips browser open. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |

**Legacy:** `SSH_TTY` and `SSH_CONNECTION` are still detected. Prefer `PLANNOTATOR_REMOTE=1` for explicit control.

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
plannotator review subcommand runs
        ↓
git diff captures unstaged changes
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → feedback sent to agent session
Approve → "LGTM" sent to agent session
```

## Server API

### Plan Server (`packages/server/index.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/plan`           | GET    | Returns `{ plan, origin }`                 |
| `/api/approve`        | POST   | Approve plan (body: planSave, agentSwitch, obsidian, bear, feedback) |
| `/api/deny`           | POST   | Deny plan (body: feedback, planSave)       |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns temp path            |
| `/api/obsidian/vaults`| GET    | Detect available Obsidian vaults           |

### Review Server (`packages/server/review.ts`)

| Endpoint              | Method | Purpose                                    |
| --------------------- | ------ | ------------------------------------------ |
| `/api/diff`           | GET    | Returns `{ rawPatch, gitRef, origin }`     |
| `/api/feedback`       | POST   | Submit review (body: feedback, annotations, agentSwitch) |
| `/api/image`          | GET    | Serve image by path query param            |
| `/api/upload`         | POST   | Upload image, returns temp path            |

Both servers use random ports locally or fixed port (`19432`) in remote mode.

## Data Types

**Location:** `packages/core/types.ts` (re-exported from `packages/ui/types.ts`)

```typescript
enum AnnotationType {
  DELETION = "DELETION",
  INSERTION = "INSERTION",
  REPLACEMENT = "REPLACEMENT",
  COMMENT = "COMMENT",
  GLOBAL_COMMENT = "GLOBAL_COMMENT",
}

// Review methodology tags for structured feedback
enum ReviewTag {
  // Modification (action required)
  TODO = "@TODO",
  FIX = "@FIX",
  CLARIFY = "@CLARIFY",
  MISSING = "@MISSING",
  ADD_EXAMPLE = "@ADD-EXAMPLE",
  // Verification (fact-checking)
  VERIFY = "@VERIFY",
  VERIFY_SOURCES = "@VERIFY-SOURCES",
  CHECK_FORMULA = "@CHECK-FORMULA",
  CHECK_LINK = "@CHECK-LINK",
  // Validation
  OK = "@OK",
  APPROVED = "@APPROVED",
  LOCKED = "@LOCKED",
}

interface Annotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: AnnotationType;
  tag?: ReviewTag;      // Optional methodology tag
  isMacro?: boolean;    // [MACRO] flag - cross-document impact
  text?: string;        // For comment/replacement/insertion
  originalText: string; // The selected text
  createdAt: number;    // Timestamp
  author?: string;      // Tater identity
  imagePaths?: string[];
  startMeta?: { parentTagName; parentIndex; textOffset };
  endMeta?: { parentTagName; parentIndex; textOffset };
}

interface Block {
  id: string;
  type: "paragraph" | "heading" | "blockquote" | "list-item" | "code" | "hr" | "table";
  content: string;
  level?: number;    // For headings (1-6)
  language?: string; // For code blocks
  checked?: boolean; // For checkbox list items
  order: number;
  startLine: number;
}
```

## Custom Features (Fork Extensions)

### Review Tags

Structured methodology tags for annotations. Available in toolbar dropdown:

| Category | Tags | Purpose |
|----------|------|---------|
| Modification | `@TODO`, `@FIX`, `@CLARIFY`, `@MISSING`, `@ADD-EXAMPLE` | Action required |
| Verification | `@VERIFY`, `@VERIFY-SOURCES`, `@CHECK-FORMULA`, `@CHECK-LINK` | Fact-checking |
| Validation | `@OK`, `@APPROVED`, `@LOCKED` | Section validation |

### [MACRO] Flag

Toggle button in toolbar to mark annotations with cross-document impact. When enabled:
- Badge appears in annotation panel
- Export includes `[MACRO]` prefix: `## 1. @FIX [MACRO] Feedback on:`
- Claude understands to check related documents

### Annotate Mode

Annotate any markdown file (not just plans from ExitPlanMode):

```bash
plannotator annotate <file.md>
# Or via slash command:
/plannotator-annotate README.md
```

Features:
- File path shown in header
- Save Markers button (validation markers only)
- Feedback exported to stdout

### Persistent Validation Markers

Validation tags (@OK, @APPROVED, @LOCKED) can be saved to source file as HTML comments:

```markdown
<!-- @APPROVED -->
## Step 1: Initialize
```

API endpoint: `POST /api/save-markers` (annotate mode only)

### Annotate Server (`packages/server/annotate.ts`)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan` | GET | Returns `{ plan, mode: "annotate", filePath, existingMarkers }` |
| `/api/save-markers` | POST | Write validation markers to source file |
| `/api/feedback` | POST | Submit feedback (resolves with feedback text) |

## Markdown Parser

**Location:** `packages/ui/utils/parser.ts`

`parseMarkdownToBlocks(markdown)` splits markdown into Block objects. Handles:

- Headings (`#`, `##`, etc.)
- Code blocks (``` with language extraction)
- List items (`-`, `*`, `1.`)
- Blockquotes (`>`)
- Horizontal rules (`---`)
- Paragraphs (default)

`exportDiff(blocks, annotations)` generates human-readable feedback for Claude.

## Annotation System

**Selection mode:** User selects text → toolbar appears → choose annotation type
**Redline mode:** User selects text → auto-creates DELETION annotation

Text highlighting uses `web-highlighter` library. Code blocks use manual `<mark>` wrapping (web-highlighter can't select inside `<pre>`).

## URL Sharing

**Location:** `packages/ui/utils/sharing.ts`, `packages/ui/hooks/useSharing.ts`

Shares full plan + annotations via URL hash using deflate compression.

**Payload format:**

```typescript
interface SharePayload {
  p: string; // Plan markdown
  a: ShareableAnnotation[]; // Compact annotations
}

type ShareableAnnotation =
  | ["D", string, string | null] // [type, original, author]
  | ["R", string, string, string | null] // [type, original, replacement, author]
  | ["C", string, string, string | null] // [type, original, comment, author]
  | ["I", string, string, string | null] // [type, context, newText, author]
  | ["G", string, string | null]; // [type, comment, author] - global comment
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

Uses cookies (not localStorage) because each hook invocation runs on a random port. Settings include identity and plan saving (enabled/custom path).

## Syntax Highlighting

Code blocks use bundled `highlight.js`. Language is extracted from fence (```rust) and applied as `language-{lang}`class. Each block highlighted individually via`hljs.highlightElement()`.

## Requirements

- Bun runtime
- Claude Code with plugin/hooks support
- Cross-platform: macOS (`open`), Linux (`xdg-open`), Windows (`start`)

## Development

```bash
bun install

# Run any app
bun run dev:hook       # Hook server (plan review)
bun run dev:review     # Review editor (code review)
bun run dev:portal     # Portal editor
bun run dev:marketing  # Marketing site
```

## Build

```bash
bun run build:hook       # Single-file HTML for hook server (main target)
bun run build:review     # Code review editor
bun run build:portal     # Static build for share.plannotator.ai
bun run build:marketing  # Static build for plannotator.ai
bun run build            # Alias for build:hook
```

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
