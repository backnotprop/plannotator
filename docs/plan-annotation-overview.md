# Plan Annotation & Persistence Overview

How plans and annotations are saved, when persistence happens, naming conventions for "annotation" vs "diff," and how data flows through the system.

---

## 1. Three Distinct Flows

Plannotator has three separate user flows, each with different persistence behavior:

| Flow | Trigger | Persists to disk? | Output destination |
|------|---------|-------------------|--------------------|
| **Plan Review** | `ExitPlanMode` hook / `submit_plan` tool | Yes (if enabled) | Hook stdout → Claude Code / OpenCode agent |
| **Code Review** | `/plannotator-review` command | No | Feedback sent to agent session |
| **Annotate** | `/plannotator-annotate <file>` command | No | Feedback sent to agent session |

Key insight: **only plan review saves anything to disk.** Code review and annotate feedback is ephemeral — it's sent to the agent and then gone (unless the user shares via URL).

---

## 2. Plan Saving: What Gets Written to Disk

### Storage location

Default: `~/.plannotator/plans/`
Custom: user-configurable via Settings UI (stored in cookie `plannotator-save-path`)

The directory is created on first save via `mkdirSync(planDir, { recursive: true })`.

**Source:** `packages/server/storage.ts`

### File naming

Slug format: `YYYY-MM-DD-{sanitized-heading}`

- Date from `new Date().toISOString().split("T")[0]`
- Heading extracted from first `# ` line in the plan markdown
- Sanitized via `sanitizeTag()` (from `packages/server/project.ts`)
- Fallback if no heading: `YYYY-MM-DD-plan`

Example: `2026-02-22-add-user-authentication`

### Files created on approve/deny

Up to **two** files are written when `planSave.enabled === true`:

| File | Format | Contents |
|------|--------|----------|
| `{slug}.annotations.md` | Exported annotation markdown | Only the user's feedback (output of `exportAnnotations()`) |
| `{slug}-approved.md` or `{slug}-denied.md` | Combined snapshot | Plan markdown + `---` separator + annotations |

Note: there is a `savePlan()` function that would write `{slug}.md` (raw plan only), but it is **not currently called** by either the approve or deny endpoints. Only `saveAnnotations()` and `saveFinalSnapshot()` are called.

### Snapshot format

```markdown
# Original Plan Content
...plan markdown...

---

# Plan Feedback

I've reviewed this plan and have 3 pieces of feedback:

## 1. Remove this
...
```

The separator `---` is only added if annotations exist and aren't `"No changes detected."`.

### When saving is skipped

- `planSave.enabled === false` (user disabled in Settings)
- On approval with no annotations/feedback — `saveAnnotations()` is skipped but `saveFinalSnapshot()` still runs (writes plan-only snapshot)
- On deny, feedback defaults to `"Plan rejected by user"` if none provided

---

## 3. When Persistence Happens (Trigger Points)

### Plan Review Server (`packages/server/index.ts`)

**On approve** (`POST /api/approve`):
```
1. Save to Obsidian vault (if configured)
2. Save to Bear (if configured)
3. If planSave.enabled:
   a. saveAnnotations(slug, feedback)     → {slug}.annotations.md
   b. saveFinalSnapshot(slug, "approved") → {slug}-approved.md
4. Resolve decision promise → hook writes stdout → Claude continues
```

**On deny** (`POST /api/deny`):
```
1. If planSave.enabled:
   a. saveAnnotations(slug, feedback)     → {slug}.annotations.md
   b. saveFinalSnapshot(slug, "denied")   → {slug}-denied.md
2. Resolve decision promise → hook writes stdout → Claude revises plan
```

### Code Review Server (`packages/server/review.ts`)

**On feedback** (`POST /api/feedback`):
```
1. Resolve decision promise with { feedback, annotations, agentSwitch }
2. NO disk persistence
3. Feedback sent directly to agent session as markdown text
```

### Annotate Server (`packages/server/annotate.ts`)

**On feedback** (`POST /api/feedback`):
```
1. Resolve decision promise with { feedback, annotations }
2. NO disk persistence
3. Feedback sent to agent session as: "# Markdown Annotations\n\nFile: {path}\n\n{feedback}"
```

---

## 4. Annotation Export Format

All three flows use `exportAnnotations()` from `packages/ui/utils/parser.ts` to convert structured `Annotation[]` objects into human-readable markdown before sending feedback.

Output structure:
```markdown
# Plan Feedback

## Reference Images
(global attachments, if any)
1. [image-name] `/path/to/image`

I've reviewed this plan and have N pieces of feedback:

## 1. Remove this
```
selected text
```
> I don't want this in the plan.

## 2. Add this
```
new text to insert
```

## 3. Change this
**From:**
```
original text
```
**To:**
```
replacement text
```

## 4. Feedback on: "selected text"
> user's comment

## 5. General feedback about the plan
> global comment

---
```

Per-annotation images are listed inline as `**Attached images:**` blocks.

---

## 5. Terminology: "Annotation" vs "Diff"

These two terms refer to distinct concepts and are used consistently throughout the codebase.

### "Annotation" = user feedback markup

Annotations are things the user creates by interacting with the UI. There are two separate type systems:

**Plan annotations** (`Annotation` in `packages/ui/types.ts`):
- Types: `DELETION`, `INSERTION`, `REPLACEMENT`, `COMMENT`, `GLOBAL_COMMENT`
- Attached to plan text via block ID and character offsets
- Used in: plan review, annotate mode

**Code annotations** (`CodeAnnotation` in `packages/ui/types.ts`):
- Types: `comment`, `suggestion`, `concern`
- Attached to diff lines via file path, line numbers, and side (`old`/`new`)
- Used in: code review only

Where "annotation" appears:

| Location | Usage |
|----------|-------|
| `AnnotationType` enum | Plan annotation types (5 variants) |
| `CodeAnnotationType` type | Code review annotation types (3 variants) |
| `Annotation` interface | Plan annotation data structure |
| `CodeAnnotation` interface | Code review annotation data structure |
| `AnnotationToolbar.tsx` | UI for creating plan annotations |
| `AnnotationPanel.tsx` | Panel listing plan annotations |
| `AnnotationSidebar.tsx` | Sidebar with annotation list |
| `annotationHelpers.ts` | Counting annotations per section, TOC building |
| `exportAnnotations()` | Converts `Annotation[]` to markdown feedback |
| `saveAnnotations()` | Writes `{slug}.annotations.md` to disk |
| `{slug}.annotations.md` | On-disk filename for saved feedback |
| `ShareableAnnotation` | Compact tuple format for URL sharing |
| `DiffAnnotationMetadata` | Bridge type for `@pierre/diffs` library integration |
| `/api/feedback` body | Both review and annotate servers accept `annotations` array |

### "Diff" = git diff content being reviewed

Diffs are the raw git output that code review displays. The user doesn't create diffs — they're generated by git commands.

Where "diff" appears:

| Location | Usage |
|----------|-------|
| `DiffType` type | Git diff variants: `uncommitted`, `staged`, `unstaged`, `last-commit`, `branch` |
| `DiffOption` interface | UI dropdown options for switching diff type |
| `DiffResult` interface | Return type from `runGitDiff()`: `{ patch, label }` |
| `DiffResult` (in types.ts) | Unrelated: `{ original, modified, diffText }` — appears unused/legacy |
| `DiffViewer.tsx` | Component that renders parsed diff with syntax highlighting |
| `DiffAnnotationMetadata` | Bridge between `CodeAnnotation` and `@pierre/diffs` annotation format |
| `runGitDiff()` | Executes git diff commands |
| `/api/diff` endpoint | Returns raw patch + git ref + diff type |
| `/api/diff/switch` endpoint | Changes which diff type is displayed |
| `diffStyle` state | `'split'` or `'unified'` display mode in review UI |
| `parseDiffToFiles()` | Splits raw patch into per-file diff chunks |

### Where they overlap

`DiffAnnotationMetadata` is the one type that bridges both concepts — it maps a `CodeAnnotation` to the annotation format expected by the `@pierre/diffs` rendering library. It contains annotation data (`type`, `text`, `suggestedCode`) keyed by `annotationId`, positioned on diff lines.

### Naming convention summary

| Term | Domain | Created by | Example types |
|------|--------|------------|---------------|
| **Annotation** | User feedback | User in UI | `DELETION`, `COMMENT`, `suggestion` |
| **Diff** | Git changes | Git commands | `uncommitted`, `staged`, `branch` |
| **Feedback** | Exported text | `exportAnnotations()` | Markdown string sent to agent |
| **Snapshot** | Combined file | `saveFinalSnapshot()` | `{slug}-approved.md` |

---

## 6. Other Persistence Mechanisms

### URL Sharing (`packages/ui/utils/sharing.ts`)

Not disk persistence, but annotations can be serialized into a URL hash:

1. `Annotation[]` → compact tuples via `toShareable()` (e.g., `['C', 'text', 'comment', 'author']`)
2. JSON stringify → deflate-raw compress → Base64url encode
3. URL: `https://share.plannotator.ai/#<hash>`

This is the only way plan review annotations survive beyond a session without disk saving enabled.

### Obsidian Integration (`packages/server/integrations.ts`)

On approve/deny (if configured):
- Writes plan markdown with YAML frontmatter to an Obsidian vault folder
- Filename: `{Title} - {Mon D, YYYY H-MMam}.md`
- Auto-tags with project name, plan keywords, code languages
- Adds backlink to `[[Plannotator Plans]]` index note
- Does **not** include annotations — only the raw plan

### Bear Integration (`packages/server/integrations.ts`)

On approve/deny (if configured):
- Opens `bear://x-callback-url/create` with plan content
- Adds hashtags derived from plan content
- Does **not** include annotations — only the raw plan

### Cookie-Based Settings (`packages/ui/utils/storage.ts`)

Settings persisted across sessions via cookies (domain-scoped, not port-scoped):

| Cookie key | Purpose |
|------------|---------|
| `plannotator-save-enabled` | Whether disk saving is on (default: true) |
| `plannotator-save-path` | Custom save directory |
| `plannotator-auto-close` | Tab close delay after submit (`off`, `0`, `3`, `5`) |
| `plannotator-identity` | User identity for annotation authorship |

### Browser Download

The UI also supports downloading annotations as a file (`annotations.md`) via a download button in `ExportModal.tsx` and `App.tsx`. This is a manual user action, not automatic persistence.

---

## 7. Data Type Reference

### Plan Annotation (`Annotation`)

```typescript
interface Annotation {
  id: string;
  blockId: string;        // Which markdown block
  startOffset: number;    // Character offset in block
  endOffset: number;
  type: AnnotationType;   // DELETION | INSERTION | REPLACEMENT | COMMENT | GLOBAL_COMMENT
  text?: string;          // Comment text or replacement text
  originalText: string;   // The selected text
  createdA: number;       // Timestamp
  author?: string;        // User identity
  images?: ImageAttachment[];
  startMeta?: { parentTagName; parentIndex; textOffset };
  endMeta?: { parentTagName; parentIndex; textOffset };
}
```

### Code Annotation (`CodeAnnotation`)

```typescript
interface CodeAnnotation {
  id: string;
  type: CodeAnnotationType;  // 'comment' | 'suggestion' | 'concern'
  filePath: string;
  lineStart: number;
  lineEnd: number;
  side: 'old' | 'new';
  text?: string;
  suggestedCode?: string;
  createdAt: number;
  author?: string;
}
```

### Git Diff Types

```typescript
type DiffType = "uncommitted" | "staged" | "unstaged" | "last-commit" | "branch";
```

---

## 8. Key Observations

1. **Asymmetric persistence**: Plan review saves to disk; code review and annotate don't save anything. If you want a record of code review feedback, URL sharing is the only option.

2. **`savePlan()` exists but isn't called**: The function to save raw plan markdown (without annotations) is defined in `storage.ts` but never invoked by the server endpoints. Only `saveAnnotations()` and `saveFinalSnapshot()` are used.

3. **Annotations ≠ feedback**: In the codebase, "annotations" refers to the structured `Annotation[]` array (with offsets, types, etc.), while "feedback" refers to the exported markdown string. The disk files are named `.annotations.md` but contain the exported feedback text, not the raw annotation objects.

4. **No annotation round-tripping from disk**: Saved `.annotations.md` files contain human-readable markdown, not JSON. You can't reload them into the UI. Only URL sharing preserves the structured annotation data.

5. **Integrations save plans, not annotations**: Both Obsidian and Bear integrations save the raw plan markdown. Annotations/feedback are not included in integration saves.

6. **Cookie settings are domain-scoped**: Because each hook invocation uses a random port, localStorage (port-scoped) wouldn't work. Cookies on `localhost` are shared across all ports, enabling persistence.

7. **"Diff" is never used for plan annotations**: The term "diff" is strictly reserved for git diff operations in the code review flow. Plan feedback uses "annotation" and "feedback" exclusively. The one exception is `DiffResult` in `types.ts` which appears to be a legacy/unused type unrelated to code review.
