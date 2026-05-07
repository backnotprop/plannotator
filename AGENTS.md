# Plannotator

A daemon-backed plan review UI for Claude Code that intercepts `ExitPlanMode` via hooks, letting users approve or request changes with annotated feedback. Also provides code review for git diffs and annotation of arbitrary markdown files.

The public runtime surface is the local daemon:

- `plannotator daemon start|stop|status` owns the long-lived review server lifecycle.
- `plannotator submit|review|annotate|wait|clear|open` shell out through that daemon instead of spinning up per-invocation servers.

## Task Complexity And Model Routing

Use a `complexityScore` on a 0-100 scale to decide which model and reasoning
effort should own a task.

### Complexity rubric

- `0-20`: Trivial, tightly bounded, low ambiguity, easy to verify
- `21-40`: Small implementation task, limited coupling, cheap mistakes
- `41-60`: Moderate multi-step task, some refactor or coordination burden
- `61-80`: High complexity, cross-module work, real ambiguity, meaningful
  verification burden
- `81-100`: Architecture-level or correctness-critical work with broad coupling,
  recovery concerns, or expensive failure modes

### Routing table

- `0-20` → `gpt-5.4-mini` at `medium`
- `21-45` → `gpt-5.4` at `medium`
- `46-65` → `gpt-5.4` at `high`
- `66-80` → `GPT-5.5` at `medium`
- `81-90` → `GPT-5.5` at `high`
- `91-100` → `GPT-5.5` at `xhigh`

### Override rules

- Prefer `GPT-5.5` earlier than the table suggests when failure creates
  meaningful cleanup debt or negative progress.
- Prefer `GPT-5.5` at `high` or `xhigh` for architecture, state machines,
  concurrency, recovery, migration, delegation-heavy work, or tasks prone to
  gaming, drift, or shallow shortcutting.
- Prefer `gpt-5.4` when the work is fully specified, locally verifiable, and a
  later `GPT-5.5` audit or patch pass is cheaper than running `GPT-5.5` as the
  primary implementer for the entire task.
- Do not route difficult tasks to older or weaker models just to save usage if
  the likely result is review debt, rewrite debt, or false confidence.

## Current Task Poset

Unified DAG: `NIM-R` replaces legacy `NIM-1` + `NIM-22`. NIM-1 and NIM-22 remain in `.agents/plans/` as historical sources.

```mermaid
graph TD
    NR["NIM-R: Daemon refactor + E2E certified"]

    %% GATES
    G0["G0: Semantics frozen"]
    G1["G1: E2E infrastructure"]
    G2["G2: Slice TDD + impl"]
    G3["G3: E2E specs complete"]
    G4["G4: Final verification"]

    NR --> G0
    NR --> G1
    NR --> G2
    NR --> G3
    NR --> G4

    %% SEMANTIC DECISIONS
    D1["D1: Exit codes"]
    D2["D2: Verdict broadcast"]
    D3["D3: Crash recovery"]
    D4["D4: State-dir"]
    D5["D5: Signals"]
    D6["D6: Concurrent hooks"]

    G0 --> D1
    G0 --> D2
    G0 --> D3
    G0 --> D4
    G0 --> D5
    G0 --> D6

    %% INFRA
    N23["NIM-23: E2E infra"]
    G1 --> N23

    %% SLICE TDD → IMPL (local blocking, parallel across slices)
    N12["NIM-12: TDD policy"]
    N13["NIM-13: TDD S-1"] --> N2["NIM-2: S-1 Delete remote"]
    N14["NIM-14: TDD S-2"] --> N3["NIM-3: S-2 State machine"]
    N15["NIM-15: TDD S-3"] --> N4["NIM-4: S-3 Router"]
    N16["NIM-16: TDD S-4"] --> N5["NIM-5: S-4 Daemon lifecycle"]
    N17["NIM-17: TDD S-5"] --> N6["NIM-6: S-5 Submit/Wait/Clear"]
    N18["NIM-18: TDD S-6"] --> N7["NIM-7: S-6 CLI"]
    N19["NIM-19: TDD S-7"] --> N8["NIM-8: S-7 Notifications"]
    N20["NIM-20: TDD S-8"] --> N9["NIM-9: S-8 Agent wrappers"]
    N21["NIM-21: TDD S-9"] --> N10["NIM-10: S-9 Build/packaging"]

    N12 --> N13
    N12 --> N14
    N12 --> N15
    N12 --> N16
    N12 --> N17
    N12 --> N18
    N12 --> N19
    N12 --> N20
    N12 --> N21

    G2 --> N12
    G2 --> N2
    G2 --> N3
    G2 --> N4
    G2 --> N5
    G2 --> N6
    G2 --> N7
    G2 --> N8
    G2 --> N9
    G2 --> N10

    %% E2E SPECS (integration nodes with multiple parents)
    E01["E01: Binary surface"]
    E02["E02: Daemon lifecycle"]
    E03["E03: State machine"]
    E04["E04: Submit plan"]
    E05["E05: Review mode"]
    E06["E06: Annotate mode"]
    E07["E07: Clear contingency"]
    E08["E08: Crash recovery"]
    E09["E09: History/storage"]
    E10["E10: UI actions"]
    E11["E11: Cancel/Reset"]
    E12["E12: JSON output"]
    E13["E13: Claude hook shim"]
    E14["E14: OpenCode shim"]
    E15["E15: Packaging"]
    E99["E99: Full scenario"]

    G3 --> E01
    G3 --> E02
    G3 --> E03
    G3 --> E04
    G3 --> E05
    G3 --> E06
    G3 --> E07
    G3 --> E08
    G3 --> E09
    G3 --> E10
    G3 --> E11
    G3 --> E12
    G3 --> E13
    G3 --> E14
    G3 --> E15
    G3 --> E99

    %% Key integration deps (semantic decisions + impl slices)
    E01 --> N10
    E02 --> D3
    E02 --> D4
    E02 --> D5
    E02 --> N5
    E02 --> N7
    E03 --> D1
    E03 --> D2
    E03 --> N3
    E03 --> N6
    E03 --> N7
    E04 --> D2
    E04 --> N3
    E04 --> N4
    E04 --> N6
    E05 --> N4
    E05 --> N6
    E06 --> D2
    E06 --> N6
    E06 --> N7
    E07 --> D1
    E07 --> N6
    E07 --> N7
    E08 --> D3
    E08 --> D4
    E08 --> D5
    E08 --> N3
    E08 --> N5
    E08 --> N6
    E08 --> N7
    E09 --> D4
    E09 --> N5
    E09 --> N6
    E10 --> N4
    E10 --> N6
    E10 --> N8
    E11 --> D5
    E11 --> N6
    E11 --> N7
    E12 --> D1
    E12 --> N6
    E12 --> N7
    E13 --> D2
    E13 --> D6
    E13 --> N3
    E13 --> N5
    E13 --> N6
    E13 --> N9
    E14 --> N7
    E14 --> N9
    E15 --> N2
    E15 --> N10
    E99 --> E01
    E99 --> E02
    E99 --> E03
    E99 --> E04
    E99 --> E05
    E99 --> E06
    E99 --> E07
    E99 --> E08
    E99 --> E09
    E99 --> E10
    E99 --> E11
    E99 --> E12
    E99 --> E13
    E99 --> E14
    E99 --> E15

    %% G4 depends on all gates
    G4 --> G0
    G4 --> G1
    G4 --> G2
    G4 --> G3

    %% All specs depend on N23
    N23 -.-> E01
    N23 -.-> E02
    N23 -.-> E03
    N23 -.-> E04
    N23 -.-> E05
    N23 -.-> E06
    N23 -.-> E07
    N23 -.-> E08
    N23 -.-> E09
    N23 -.-> E10
    N23 -.-> E11
    N23 -.-> E12
    N23 -.-> E13
    N23 -.-> E14
    N23 -.-> E15
```

### Structural rules

1. **TDD blocks only its implementation slice** — NIM-14 blocks NIM-3 but not NIM-4
2. **Semantic decisions block specs and implementations that encode those semantics** — D2 blocks E03, E04, E06, E13
3. **Integration specs have multiple parents** — E08 crash recovery depends on D3, D4, D5, NIM-3, NIM-5, NIM-6, NIM-7, NIM-23
4. **Single terminal meaning of completion** — root is not satisfied by passing unit tests alone; requires fresh E2E run from built artifacts
5. **NIM-23 (E2E infrastructure) is a prerequisite for all E2E specs** (dashed lines)

## Delegation Workflows

When a task is delegated to a subagent, treat that delegation as the active
execution path unless the delegate is explicitly replaced or abandoned.

### Blocking delegation

Use this for real implementation, proof-authoring, refactors, and other
substantive tasks where overlapping work would create confusion or duplicate
effort.

- Create a git checkpoint commit before assigning the task to a subagent.
- Assign the task to a single subagent with a bounded scope.
- Do not work on the same task locally while the subagent owns it.
- Do not treat a polling timeout as permission to take over the task.
- Wait until the subagent actually reports completion, then review the result.
- After review, either accept the work, request changes, or explicitly replace
  the delegate.
- When the subagent is done, stage and commit the full delegated change as one
  unit before final acceptance.
- Review the resulting git diff or commit diff to ensure the work actually
  matches the assigned task and did not drift or game the request.

### Delegation loop

Delegation is not fire-and-forget. The main agent must stay in the loop until
the delegated task is either accepted or explicitly reassigned.

- After delegation, continue checking the delegate on long intervals instead of
  assuming the task will call back on its own.
- Use long waits or status checks in a loop, on the order of 5-10 minutes when
  appropriate for substantive work.
- Do not end the main workflow merely because the delegated task is in
  progress.
- When the delegate finishes, review the work immediately.
- If the work is insufficient, send revision instructions and continue the
  wait-review loop until the result is acceptable.
- Only after acceptance should the main agent commit the delegated change,
  update tracker state, and move on to the next task in the poset.

### Status polling

Timed waits are allowed only for status checks. They are not completion signals.

- A timed wait expiring means only: no result has been returned yet.
- It does not mean the subagent failed.
- It does not mean the task should be taken over locally.
- It does not mean overlapping work is now acceptable.
- It does not mean the main workflow should stop; continue the wait loop until
  the delegate finishes or is explicitly replaced.

### Delegate replacement

If a delegated task must be rerouted:

- Explicitly abandon or replace the current delegate.
- Record the reassignment in the tracker.
- Send the replacement delegate the full task specification, concrete repo
  context, success criteria, non-goals, and write-scope boundaries.
- Only after explicit replacement may a different agent or the main agent take
  over the task.

### Handoff requirements

Do not compress the task into a vague summary when delegating.

- Give the delegate the full task specification, ideally verbatim from the
  tracker or plan.
- Include the task's place in the dependency order or poset when that affects
  sequencing or scope.
- Include concrete repo entry points, relevant files, and expected proof or
  verification commands.
- State the expected deliverable format: changed files, verification run,
  blockers, and unresolved questions.
- State non-goals explicitly so the delegate does not wander into adjacent work.

### Lessons learned

- A status polling timeout is not a completion signal.
- No local overlap is allowed while a delegate still owns the task.
- A missing or delayed result should trigger better orchestration, not silent
  takeover of the task.
- Delegates need the full task specification, not a compressed paraphrase.
- Delegated work should be checkpointed before handoff and committed as a unit
  when returned so the diff can be reviewed against task compliance.
- Delegated tasks do not reliably call back into the main workflow; the main
  agent must keep polling, reviewing, and iterating until the task is accepted.

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
│   ├── opencode-plugin/          # OpenCode plugin
│   │   ├── commands/             # Slash commands (plannotator-review.md, plannotator-annotate.md)
│   │   ├── index.ts              # Plugin entry with submit_plan tool + review/annotate event handlers
│   │   ├── plannotator.html      # Built plan review app
│   │   └── review-editor.html    # Built code review app
│   ├── review/                   # Standalone review server (for development)
│   │   ├── index.html
│   │   ├── index.tsx
│   │   └── vite.config.ts
│   └── vscode-extension/         # VS Code extension — opens plans in editor tabs
│       ├── bin/                   # Router scripts (open-in-vscode, xdg-open)
│       ├── src/                   # extension.ts, cookie-proxy.ts, ipc-server.ts, panel-manager.ts, editor-annotations.ts, vscode-theme.ts
│       └── package.json           # Extension manifest (publisher: backnotprop)
├── packages/
│   ├── server/                   # Shared server implementation
│   │   ├── index.ts              # standalone server entrypoint, ready-hook orchestration
│   │   ├── review.ts             # startReviewServer(), handleReviewServerReady()
│   │   ├── annotate.ts           # startAnnotateServer(), handleAnnotateServerReady()
│   │   ├── storage.ts            # Plan saving to disk (getPlanDir, savePlan, etc.)
│   │   ├── port.ts               # Local port selection
│   │   ├── remote/               # Compatibility shim for legacy remote tests/imports
│   │   ├── browser.ts            # openBrowser()
│   │   ├── draft.ts              # Annotation draft persistence (~/.plannotator/drafts/)
│   │   ├── integrations.ts       # Obsidian, Bear integrations
│   │   ├── ide.ts                # VS Code diff integration (openEditorDiff)
│   │   ├── editor-annotations.ts  # VS Code editor annotation endpoints
│   │   └── project.ts            # Project name detection for tags
│   ├── ui/                       # Shared React components
│   │   ├── components/           # Viewer, Toolbar, Settings, etc.
│   │   │   ├── plan-diff/        # PlanDiffBadge, PlanDiffViewer, clean/raw diff views
│   │   │   └── sidebar/          # SidebarContainer, SidebarTabs, VersionBrowser
│   │   ├── utils/                # parser.ts, annotationWireFormat.ts, storage.ts, planSave.ts, agentSwitch.ts, planDiffEngine.ts
│   │   ├── hooks/                # usePlanDiff.ts, useSidebar.ts, useLinkedDoc.ts, useAnnotationDraft.ts, useCodeAnnotationDraft.ts
│   │   └── types.ts
│   ├── shared/                   # Cross-package types (EditorAnnotation)
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
| --- | --- |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random local port. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |

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
git diff captures unstaged changes
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → feedback sent to agent session
Approve → "LGTM" sent to agent session
```

## Annotate Flow

```
User runs /plannotator-annotate <file.md> command
        ↓
Claude Code: plannotator annotate subcommand runs
OpenCode: event handler intercepts command
        ↓
Markdown file read from disk
        ↓
Annotate server starts (reuses plan editor HTML with mode:"annotate")
        ↓
User annotates markdown, provides feedback
        ↓
Send Annotations → feedback sent to agent session
```

## Server API

### Plan Server (`packages/server/index.ts`)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/plan` | GET | Returns `{ plan, origin, previousPlan, versionInfo }` |
| `/api/plan/version` | GET | Fetch specific version (`?v=N`) |
| `/api/plan/versions` | GET | List all versions of current plan |
| `/api/plan/history` | GET | List all plans in current project |
| `/api/approve` | POST | Approve plan (body: planSave, agentSwitch, obsidian, bear, feedback) |
| `/api/deny` | POST | Deny plan (body: feedback, planSave) |
| `/api/image` | GET | Serve image by path query param |
| `/api/upload` | POST | Upload image, returns `{ path, originalName }` |
| `/api/obsidian/vaults` | GET | Detect available Obsidian vaults |
| `/api/reference/obsidian/files` | GET | List vault markdown files as nested tree (`?vaultPath=<path>`) |
| `/api/reference/obsidian/doc` | GET | Read a vault markdown file (`?vaultPath=<path>&path=<file>`) |
| `/api/plan/vscode-diff` | POST | Open diff in VS Code (body: baseVersion) |
| `/api/doc` | GET | Serve linked .md/.mdx file (`?path=<path>`) |
| `/api/draft` | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |
| `/api/editor-annotations` | GET | List editor annotations (VS Code only) |
| `/api/editor-annotation` | POST/DELETE | Add or remove an editor annotation (VS Code only) |

### Review Server (`packages/server/review.ts`)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/diff` | GET | Returns `{ rawPatch, gitRef, origin }` |
| `/api/file-content` | GET | Returns `{ oldContent, newContent }` for expandable diff context |
| `/api/git-add` | POST | Stage/unstage a file (body: `{ filePath, undo? }`) |
| `/api/feedback` | POST | Submit review (body: feedback, annotations, agentSwitch) |
| `/api/image` | GET | Serve image by path query param |
| `/api/upload` | POST | Upload image, returns `{ path, originalName }` |
| `/api/draft` | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |
| `/api/editor-annotations` | GET | List editor annotations (VS Code only) |
| `/api/editor-annotation` | POST/DELETE | Add or remove an editor annotation (VS Code only) |

### Annotate Server (`packages/server/annotate.ts`)

| Endpoint | Method | Purpose |
| --- | --- | --- |
| `/api/plan` | GET | Returns `{ plan, origin, mode: "annotate", filePath }` |
| `/api/feedback` | POST | Submit annotations (body: feedback, annotations) |
| `/api/image` | GET | Serve image by path query param |
| `/api/upload` | POST | Upload image, returns `{ path, originalName }` |
| `/api/draft` | GET/POST/DELETE | Auto-save annotation drafts to survive server crashes |

All servers use random ports locally unless `PLANNOTATOR_PORT` is set.

## Plan Version History

Every plan is automatically saved to `~/.plannotator/history/{project}/{slug}/` on arrival, before the user sees the UI. Versions are numbered sequentially (`001.md`, `002.md`, etc.). The slug is derived from the plan's first `# Heading` + today's date via `generateSlug()`, scoped by project name (git repo or cwd). Same heading on the same day = same slug = same plan being iterated on. Identical resubmissions are deduplicated (no new file if content matches the latest version).

This powers the version history API (`/api/plan/version`, `/api/plan/versions`, `/api/plan/history`) and the plan diff system.

History saves independently of the `planSave` user setting (which controls decision snapshots in `~/.plannotator/plans/`). Storage functions live in `packages/server/storage.ts`. Slug format: `{sanitized-heading}-YYYY-MM-DD` (heading first for readability).

## Plan Diff

When a user denies a plan and Claude resubmits, the UI shows what changed between versions. A `+N/-M` badge appears below the document card; clicking it toggles between normal view and diff view.

**Diff engine** (`packages/ui/utils/planDiffEngine.ts`): Uses the `diff` npm package (`diffLines()`) to compute line-level diffs. Groups consecutive remove+add into "modified" blocks. Returns `PlanDiffBlock[]` and `PlanDiffStats`.

**Two view modes** (toggle via `PlanDiffModeSwitcher`):
- **Rendered** (`PlanCleanDiffView`): Color-coded left borders — green (added), red (removed/strikethrough), yellow (modified)
- **Raw** (`PlanRawDiffView`): Monospace `+/-` lines, git-style

**State** (`packages/ui/hooks/usePlanDiff.ts`): Manages base version selection, diff computation, and version fetching. The server sends `previousPlan` with the initial `/api/plan` response; the hook auto-diffs against it. Users can select any prior version from the sidebar Version Browser.

**Sidebar** (`packages/ui/hooks/useSidebar.ts`): Shared left sidebar with two tabs — Table of Contents and Version Browser. The "Auto-open Sidebar" setting controls whether it opens on load (TOC tab only).

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
  text?: string; // For comment/replacement/insertion
  originalText: string; // The selected text
  createdA: number; // Timestamp
  author?: string; // Tater identity
  images?: ImageAttachment[]; // Attached images with names
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

`exportAnnotations(blocks, annotations, globalAttachments)` generates human-readable feedback for Claude. Images are referenced by name: `[image-name] /tmp/path...`.

## Annotation System

**Selection mode:** User selects text → toolbar appears → choose annotation type
**Redline mode:** User selects text → auto-creates DELETION annotation

Text highlighting uses `web-highlighter` library. Code blocks use manual `<mark>` wrapping (web-highlighter can't select inside `<pre>`).

## Annotation Draft Storage

**Location:** `packages/ui/hooks/useAnnotationDraft.ts`, `packages/ui/utils/annotationWireFormat.ts`

Annotation drafts are persisted locally through `/api/draft`. The compact wire format stores annotations and attached images without the deleted share-link flow.

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
bun run dev:vscode     # VS Code extension (watch mode)
```

## Build

```bash
bun run build:hook       # Single-file HTML for hook server
bun run build:review     # Code review editor
bun run build:opencode   # OpenCode plugin (copies HTML from hook + review)
bun run build:vscode     # VS Code extension bundle
bun run package:vscode   # Package .vsix for marketplace
bun run build            # Build hook + opencode (main targets)
```

**Important:** The OpenCode plugin copies pre-built HTML from `apps/hook/dist/` and `apps/review/dist/`. When making UI changes (in `packages/ui/`, `packages/editor/`, or `packages/review-editor/`), you must rebuild the hook/review first:

```bash
bun run build:hook && bun run build:opencode   # For UI changes
```

Running only `build:opencode` will copy stale HTML files.

## Test plugin locally

```
claude --plugin-dir ./apps/hook
```
