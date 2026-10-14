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
