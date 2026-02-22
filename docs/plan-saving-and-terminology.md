# Plan Saving & Annotation/Diff Terminology Overview

Internal reference documenting how plans are saved, when saving occurs, file naming conventions, and how the terms "diff" and "annotation" are used (and conflated) across the codebase.

---

## 1. Plan Saving to Disk

### When saving happens

Plans are saved to disk on **both approve and deny**, controlled by a user-togglable setting (`planSave.enabled`, defaults to `true`).

| User action | Files written (if `planSave.enabled`) |
|---|---|
| **Approve** (with annotations) | `{slug}.diff.md` + `{slug}-approved.md` |
| **Approve** (no annotations) | `{slug}-approved.md` only |
| **Deny** | `{slug}.diff.md` + `{slug}-denied.md` |
| **Annotate mode** `/plannotator-annotate` | Nothing saved to disk — feedback sent to agent only |
| **Code review** `/plannotator-review` | Nothing saved to disk — feedback sent to agent only |

### Storage location

- **Default**: `~/.plannotator/plans/`
- **Custom**: User-configurable via Settings UI, stored in cookie `plannotator-save-path`
- **Tilde expansion**: Custom paths starting with `~` are expanded via `os.homedir()`
- **Auto-created**: Directory is created recursively on first save

### File naming

**Slug generation** (`packages/server/storage.ts:generateSlug`):

```
Format: YYYY-MM-DD-{sanitized-first-h1-heading}
Fallback: YYYY-MM-DD-plan (if no H1 heading found)
```

**Files produced per plan decision:**

```
~/.plannotator/plans/
├── 2026-02-22-user-auth.diff.md           # Annotations only (exportDiff output)
├── 2026-02-22-user-auth-approved.md       # Plan + annotations combined
├── 2026-02-22-refactor-api.diff.md
└── 2026-02-22-refactor-api-denied.md
```

### What each file contains

| File | Contents |
|---|---|
| `{slug}.diff.md` | Output of `exportDiff()` — human-readable annotation feedback |
| `{slug}-approved.md` | Original plan markdown + `\n\n---\n\n` + diff output (if any) |
| `{slug}-denied.md` | Original plan markdown + `\n\n---\n\n` + diff output |

Note: `savePlan()` (writes `{slug}.md` with raw plan markdown) exists in `storage.ts` but is **never called** in the current codebase. Only `saveAnnotations()` and `saveFinalSnapshot()` are used.

### Server-side flow

In `packages/server/index.ts`:

**`POST /api/approve`** (lines 312-320):
1. If `planSaveEnabled`: save annotations via `saveAnnotations(slug, diff, customPath)`
2. Save combined snapshot via `saveFinalSnapshot(slug, "approved", plan, diff, customPath)`
3. Return `{ ok: true, savedPath }` to the client

**`POST /api/deny`** (lines 349-354):
1. If `planSaveEnabled`: save annotations via `saveAnnotations(slug, feedback, customPath)`
2. Save combined snapshot via `saveFinalSnapshot(slug, "denied", plan, feedback, customPath)`
3. Return `{ ok: true, savedPath }` to the client

### Settings persistence

Settings are stored in **cookies** (not localStorage) because each hook invocation runs on a random port, and localStorage is scoped by origin+port while cookies are scoped by domain only.

| Cookie key | Value | Default |
|---|---|---|
| `plannotator-save-enabled` | `"true"` / `"false"` | `true` |
| `plannotator-save-path` | Custom path string or absent | absent (use default) |

Source: `packages/ui/utils/planSave.ts`

---

## 2. Other Save/Export Pathways

### Obsidian integration

- Saves the **original plan only** (no annotations) with frontmatter and backlink
- File format: `{Title} - {Mon D, YYYY H-MMam}.md` (e.g., `User Auth - Feb 22, 2026 2-30pm.md`)
- Adds YAML frontmatter: `created`, `source: plannotator`, `tags: [...]`
- Adds `[[Plannotator Plans]]` backlink
- Tags auto-extracted from: project name, H1 title words, code fence languages
- Vault detection reads platform-specific Obsidian config
- Triggered on approve only (UI sends `obsidian` config in request body)

Source: `packages/server/integrations.ts:saveToObsidian`

### Bear integration

- Saves **original plan only** with appended hashtags
- Uses `bear://x-callback-url/create` scheme
- macOS only (`open` command)
- Triggered on approve only

Source: `packages/server/integrations.ts:saveToBear`

### URL sharing

- Compresses plan + annotations into URL hash via `deflate-raw` + base64url
- Hosted at `https://share.plannotator.ai`
- Lossy: `blockId`, offsets, and `startMeta`/`endMeta` are cleared; positions are re-established by text search on import
- Supports importing teammate annotations with deduplication
- Available from Export modal "Share" tab

Source: `packages/ui/utils/sharing.ts`, `packages/ui/hooks/useSharing.ts`

### Download .diff file

- Downloads `exportDiff()` output as `annotations.diff`
- Available from Export modal "Raw Diff" tab and quick-save dropdown
- Also the `Cmd+S` / `Ctrl+S` shortcut target when "Download Diff" is the default save action

Source: `packages/editor/App.tsx:handleDownloadDiff`

---

## 3. Terminology: "Diff" vs "Annotation"

The codebase uses both terms, sometimes inconsistently. Here is a complete mapping.

### Two distinct annotation systems

| | Plan Annotations | Code Review Annotations |
|---|---|---|
| **Type name** | `Annotation` | `CodeAnnotation` |
| **Enum** | `AnnotationType` (DELETION, INSERTION, REPLACEMENT, COMMENT, GLOBAL_COMMENT) | `CodeAnnotationType` (`'comment'`, `'suggestion'`, `'concern'`) |
| **Targeting** | Text-based selection within markdown blocks | Line-based ranges within git diff hunks |
| **Position data** | `blockId`, `startOffset`/`endOffset`, `startMeta`/`endMeta` (web-highlighter) | `filePath`, `lineStart`/`lineEnd`, `side` (`'old'`/`'new'`) |
| **Image support** | Yes (`ImageAttachment[]`) | No |
| **Global comments** | Yes (`GLOBAL_COMMENT` type) | No |
| **Export function** | `exportDiff()` | `exportReviewFeedback()` |
| **Saved to disk** | Yes (`.diff.md` + snapshot) | No |
| **Shareable via URL** | Yes | No |
| **Used in** | Plan review, Annotate mode | Code review (`/plannotator-review`) |

Both are defined in `packages/ui/types.ts`.

### Where "diff" is used

#### Meaning: git diff (code review context)

| Location | Usage |
|---|---|
| `packages/server/review.ts` | `GET /api/diff` endpoint serves raw git patch |
| `packages/server/review.ts` | `POST /api/diff/switch` switches diff type (staged/unstaged/commit) |
| `packages/server/git.ts` | `DiffResult`, `DiffOption`, `runGitDiff()` — actual git operations |
| `packages/review-editor/App.tsx` | `DiffFile`, `DiffData`, `parseDiffToFiles()`, `diffStyle` state |
| `packages/review-editor/components/DiffViewer.tsx` | Renders unified/split diff view |
| `packages/ui/types.ts` | `DiffResult` interface, `DiffAnnotationMetadata`, `SelectedLineRange` |

#### Meaning: exported plan feedback (NOT a git diff)

| Location | Usage | Notes |
|---|---|---|
| `packages/ui/utils/parser.ts` | `exportDiff()` function | **Misnomer** — exports plan `Annotation[]` as human-readable markdown feedback |
| `packages/server/storage.ts` | `saveAnnotations(slug, diffContent)` | Parameter named `diffContent`, file saved as `.diff.md` |
| `packages/server/storage.ts` | `saveFinalSnapshot(slug, status, plan, diff)` | Parameter named `diff` |
| `packages/server/index.ts` | `const diff = feedback \|\| ""` | Local variable aliasing feedback as "diff" |
| `packages/editor/App.tsx` | `diffOutput` variable, `handleDownloadDiff()` | Holds `exportDiff()` result |
| `packages/ui/components/ExportModal.tsx` | "Raw Diff" tab, `diffOutput` prop, `handleCopyDiff()`, `handleDownloadDiff()` | UI labels the annotation export as "diff" |
| `packages/ui/components/Settings.tsx` | "Download Diff" option for default save action | Settings label |
| `packages/editor/App.tsx` | Downloaded filename: `annotations.diff` | File extension uses `.diff` |

### Where "annotation" is used

| Location | Usage |
|---|---|
| `packages/ui/types.ts` | `Annotation` interface, `AnnotationType` enum, `CodeAnnotation` interface |
| `packages/ui/components/AnnotationPanel.tsx` | Lists and manages plan annotations |
| `packages/ui/components/AnnotationToolbar.tsx` | Selection-based annotation creation toolbar |
| `packages/ui/components/AnnotationSidebar.tsx` | Alternative sidebar display for annotations |
| `packages/ui/utils/annotationHelpers.ts` | Helper utilities for annotation operations |
| `packages/editor/App.tsx` | `useState<Annotation[]>` state, export/import/share logic |
| `packages/review-editor/App.tsx` | `useState<CodeAnnotation[]>` state |
| `packages/review-editor/components/ReviewPanel.tsx` | Code annotation list in review UI |
| `packages/server/storage.ts` | `saveAnnotations()` function name |
| `packages/server/annotate.ts` | Entire annotate server |
| `packages/ui/utils/sharing.ts` | `toShareable()`, `fromShareable()` — annotation serialization |

### The naming inconsistency

The core confusion is `exportDiff()` in `packages/ui/utils/parser.ts`. This function:

- Takes `Annotation[]` (plan annotations) and `Block[]`
- Produces human-readable markdown like `# Plan Feedback\n\n## 1. Remove this\n...`
- Has **nothing to do with git diff or unified diff format**
- Its output is stored in files with `.diff.md` extension
- The UI labels this as "Raw Diff" and "Download Diff"

Meanwhile, the code review system uses `exportReviewFeedback()` (a clearer name) for the analogous operation on `CodeAnnotation[]`.

The `storage.ts` layer also uses `diff` as the parameter name (`diffContent`, `diff`) when what's actually being passed is the feedback string from `exportDiff()`.

### Downloaded file naming

```
annotations.diff    ← Downloaded from Export modal (plan annotations formatted as feedback)
```

The filename `annotations.diff` is itself a mix — "annotations" (correct term) + `.diff` extension (misleading, not a unified diff).

---

## 4. Data Flow Summary

### Plan review flow

```
User creates Annotation[] in plan editor
         │
         ▼
exportDiff(blocks, annotations, globalAttachments)
         │
         ▼
Human-readable markdown feedback string (called "diff" in variables)
         │
         ├──► POST /api/approve { feedback: <diff string>, planSave: {...} }
         │         │
         │         ├──► saveAnnotations(slug, diff)  →  {slug}.diff.md
         │         ├──► saveFinalSnapshot(slug, "approved", plan, diff)  →  {slug}-approved.md
         │         ├──► saveToObsidian()  (plan only, no annotations)
         │         └──► saveToBear()  (plan only, no annotations)
         │
         ├──► POST /api/deny { feedback: <diff string>, planSave: {...} }
         │         │
         │         ├──► saveAnnotations(slug, diff)  →  {slug}.diff.md
         │         └──► saveFinalSnapshot(slug, "denied", plan, diff)  →  {slug}-denied.md
         │
         ├──► URL sharing  →  compress({p: plan, a: ShareableAnnotation[], g: images})
         │
         └──► Download  →  annotations.diff file
```

### Code review flow

```
User creates CodeAnnotation[] on git diff
         │
         ▼
exportReviewFeedback(annotations, files)
         │
         ▼
Human-readable markdown grouped by file/line
         │
         └──► POST /api/feedback { feedback: <string>, annotations: CodeAnnotation[] }
                      │
                      └──► Sent to agent session (no disk persistence)
```

### Annotate flow

```
User creates Annotation[] on arbitrary markdown file
         │
         ▼
exportDiff(blocks, annotations, globalAttachments)
         │
         ▼
Human-readable markdown feedback string
         │
         └──► POST /api/feedback { feedback: <string>, annotations: Annotation[] }
                      │
                      └──► Sent to agent session (no disk persistence)
```

---

## 5. Key Observations

1. **Only plan review saves to disk.** Code review and annotate mode send feedback to the agent session and don't persist anything.

2. **`savePlan()` is dead code.** The function exists in `storage.ts` but is never called. Plans are only saved as part of `saveFinalSnapshot()`, which combines plan + annotations.

3. **Obsidian/Bear save plan only.** These integrations receive the raw plan markdown, not the annotated feedback. Annotations are only preserved in the `.diff.md` file and the combined snapshot.

4. **`exportDiff()` is a misnomer.** The function produces plan feedback from `Annotation[]` objects, not a diff in any standard sense. The code review equivalent (`exportReviewFeedback`) has a clearer name.

5. **The term "diff" is overloaded across three meanings:**
   - Git unified diff format (code review: `DiffViewer`, `/api/diff`, `runGitDiff()`)
   - Plan annotation feedback string (output of `exportDiff()`, stored as `.diff.md`)
   - The `.diff` file extension used for downloaded annotation exports (`annotations.diff`)

6. **"Annotation" is used consistently for the data structures** (`Annotation`, `CodeAnnotation`, `AnnotationType`), but the exported/serialized form is called "diff" in the plan editor context.

7. **No deletion of saved plans.** Files are permanent; there's no cleanup mechanism or UI to manage saved plans.

8. **Backwards compatibility default:** If `planSave` is not present in the request body (older clients), saving defaults to enabled.
