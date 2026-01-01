# Plannotator

A plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback.

## Project Structure

```
plannotator/
├── apps/hook/                    # Claude Code plugin
│   ├── .claude-plugin/plugin.json
│   ├── hooks/hooks.json          # PermissionRequest hook config
│   ├── server/index.ts           # Bun server (reads stdin, serves UI)
│   └── dist/index.html           # Built single-file app
├── packages/
│   ├── ui/                       # Shared React components
│   │   ├── components/           # Viewer, Toolbar, Settings, etc.
│   │   ├── utils/                # parser.ts, sharing.ts, storage.ts
│   │   ├── hooks/                # useSharing.ts
│   │   └── types.ts
│   └── editor/                   # Main App.tsx
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

## Hook Flow

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

## Server API

| Endpoint       | Method | Purpose                           |
| -------------- | ------ | --------------------------------- |
| `/api/plan`    | GET    | Returns plan markdown as JSON     |
| `/api/approve` | POST   | User approved the plan            |
| `/api/deny`    | POST   | User denied with feedback in body |

**Location:** `apps/hook/server/index.ts`

The server reads the hook event from stdin, extracts `tool_input.plan`, and serves the UI. Random port (`Bun.serve({ port: 0 })`) enables multiple concurrent sessions.

## Data Types

**Location:** `packages/ui/types.ts`

```typescript
enum AnnotationType {
  DELETION = "DELETION",
  INSERTION = "INSERTION",
  REPLACEMENT = "REPLACEMENT",
  COMMENT = "COMMENT",
  GLOBAL_COMMENT = "GLOBAL_COMMENT",
}

interface Annotation {
  id: string;
  blockId: string;
  startOffset: number;
  endOffset: number;
  type: AnnotationType;
  text?: string; // For comment/replacement/insertion
  originalText: string; // The selected text
  createdA: number; // Timestamp
  author?: string; // Tater identity
  startMeta?: { parentTagName; parentIndex; textOffset };
  endMeta?: { parentTagName; parentIndex; textOffset };
}

interface Block {
  id: string;
  type: "paragraph" | "heading" | "blockquote" | "list-item" | "code" | "hr";
  content: string;
  level?: number; // For headings (1-6)
  language?: string; // For code blocks
  order: number;
  startLine: number;
}
```

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

**Location:** `packages/ui/utils/storage.ts`

Uses cookies instead of localStorage because each hook invocation runs on a random port, and localStorage is scoped by origin (including port). Cookies are scoped by domain only.

## Syntax Highlighting

Code blocks use bundled `highlight.js`. Language is extracted from fence (```rust) and applied as `language-{lang}`class. Each block highlighted individually via`hljs.highlightElement()`.

## Requirements

- Bun runtime
- Claude Code with plugin/hooks support
- macOS (uses `open` command for browser)

## Development

```bash
bun install

# Run any app
bun run dev:hook       # Hook server
bun run dev:portal     # Portal editor
bun run dev:marketing  # Marketing site
```

## Build

```bash
bun run build:hook       # Single-file HTML for hook server
bun run build:portal     # Static build for share.plannotator.ai
bun run build:marketing  # Static build for plannotator.ai
```

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
