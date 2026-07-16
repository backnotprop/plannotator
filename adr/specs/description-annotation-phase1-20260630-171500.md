# Spec: Phase 1 — comment on the PR description

Date: 2026-06-30 (rev. 3 — final, code-verified)
Status: FINAL — every part verified as reuse against the code (see `adr/research/synthesis-description-annotation-20260630-174500.md`). Ready to build.

Implements the description slice of ADR 004. The renderer prerequisite is done: the description renders through `RenderedMarkdown` with `data-block-id` on every block, so the DOM is annotation-ready.

## The requirement (plain)

Select text in the PR description → a **comment box opens immediately** → type a comment (or Ask AI about it) → the comment appears in the **Annotations sidebar under a "PR description" group**, exactly like a diff comment: you select/edit/delete it there, it counts toward the review, and it goes to the agent on Send Feedback.

Comment-only. No toolbar, no quick-labels, no delete/redline picker. Deliberately simpler than plan/annotate.

## The flow

`select text in description`
→ web-highlighter fires → hook is in **`comment` mode** → opens `CommentPopover` directly (no toolbar)
→ user types a comment (or clicks **Ask AI**) → submit
→ builds an `Annotation` (`originalText` + `startMeta`/`endMeta`), highlights the text, adds to the `descriptionAnnotations` store
→ card appears in the Annotations sidebar under **"PR description"**; `totalAnnotationCount` ticks up → "Send Feedback" shows
→ Send Feedback → `feedbackMarkdown` includes a "PR Description Feedback" section → existing `/api/feedback` POST

## The build

### 1. Annotation engine on the description — comment-only
The description is a direct DOM container, so mount `useAnnotationHighlighter` **directly** (no iframe). In a new `AnnotatableDescription` wrapper (PRSummaryTab renders it in place of `RenderedMarkdown`; PRSummaryTab stays props-based, the wrapper pulls the store from `useReviewState`):
- `containerRef` around **only** the description `RenderedMarkdown` (not the `ChecksDisclosure`).
- `useAnnotationHighlighter({ containerRef, annotations: descriptionAnnotations, onAddAnnotation, onSelectAnnotation, selectedAnnotationId, mode: 'comment' })`.
- Render **only** `<CommentPopover>` (driven by `hook.commentPopover` + `hook.handleCommentSubmit`/`handleCommentClose`). Do **not** render `AnnotationToolbar` or `FloatingQuickLabelPicker` — comment mode skips the toolbar.
- Re-apply on change: `useEffect(() => hook.applyAnnotations(descriptionAnnotations), [descriptionAnnotations, <content key>])` so marks survive re-render (see Risks).

### 2. Store (App.tsx)
- `const [descriptionAnnotations, setDescriptionAnnotations] = useState<Annotation[]>([])`
- `const [selectedDescriptionAnnotationId, setSelectedDescriptionAnnotationId] = useState<string|null>(null)`
- Handlers: `onAddDescriptionAnnotation(ann)` (append + select), `onSelectDescriptionAnnotation(id)`, `onDeleteDescriptionAnnotation(id)`.
- Mirrors the plan editor's tiny surface (`packages/editor/App.tsx:2857-2868, 2912`).

### 3. Thread through `ReviewStateContext`
Add the store + handlers to the `ReviewState` interface, the provider value object, **and its deps array** (it's a big `useMemo` — a missed dep = stale). Import the `Annotation` type. `AnnotatableDescription` reads them via `useReviewState()`.

### 4. Sidebar — "PR description" group
`ReviewSidebar` already renders a second annotation type (`editorAnnotations`, with `onDeleteEditorAnnotation`) — **mirror that pattern**:
- Add props `descriptionAnnotations?: Annotation[]`, `onSelectDescriptionAnnotation`, `onDeleteDescriptionAnnotation`.
- Render a **"PR description"** group of cards (author, comment text, quoted `originalText`). Fold into `totalCount`.
- Card click → `onSelectDescriptionAnnotation(id)` → sets `selectedDescriptionAnnotationId` → the hook scrolls to + `.focused` the highlight in the description.
- Card delete → `onDeleteDescriptionAnnotation(id)` → `hook.removeHighlight(id)` + drop from store.
- Cross-panel note: selecting a description card focuses the highlight only if the **PR Overview panel is open**. If it's closed, either open it first or no-op. (v1: open/focus the overview panel — small, or accept no-op.)

### 5. Count + export (App.tsx)
- `totalAnnotationCount` (`:1712`) `+= descriptionAnnotations.length`.
- `feedbackMarkdown` (`:1704`) append `exportAnnotations(parseMarkdownToBlocks(prContext.body), descriptionAnnotations, [], 'PR Description Feedback', 'PR description')`. `App` already holds `prContext` (`:302`). No server change.

### 6. Highlight CSS
`.annotation-highlight` + `.deletion`/`.comment`/`.focused`/`:hover` live only in `packages/editor/index.css:118-161`. Bring into `packages/ui/theme.css` (shared; ~40 lines) so both editors use them. `--focus-highlight` is already defined in the theme files the review editor loads (it works in the plan editor), so `.focused` is safe.

### 7. Ask AI from the comment box — reuse (already supported)
Not new work after all. `AskAIParams` has a first-class **`scope`** field, and `buildDefaultPrompt` (`useAIChat.ts:78-82`) already builds a **labeled, file-less "selection" ask** — `Re: {label}` + `Source:` + `Selected text: …` + the question. It's stored on the `AIQuestion` and is exactly what the HTML viewer feeds through `CommentPopover`'s `askAIContext`. So:
- Add `handleAskAIForDescription(question)` in App: `askAI({ prompt: question, scope: { kind: 'selection', label: 'PR description', text: selectedText } })` — **no filePath**.
- Wire the description `CommentPopover` with `onAskAI={handleAskAIForDescription}` and `askAIContext={{ kind: 'selection', label: 'PR description', text: selectedText }}`, mirroring `HtmlViewer.tsx:313-325`.
- The answer lands in the AI sidebar. Because `scope` is stored on the question, the card carries its "PR description" context. Currently file-less asks bucket under "general" (`AITab.tsx:75`); an optional one-branch tweak groups by `question.scope?.label` so PR-description asks cluster under their own heading. Nice-to-have, not required for it to work.

No new AI plumbing — same mechanism the HTML viewer already uses.

## Reuse map

| Need | Reuse (no change) |
|---|---|
| select → comment box | `useAnnotationHighlighter` in `mode: 'comment'` |
| comment entry + Ask AI | `CommentPopover` (`onAskAI`/`askAIContext`) |
| consumer template | `HtmlViewer.tsx:295-328` (the `CommentPopover` portal only) |
| store shape | `editor/App.tsx:2857-2868, 2912` |
| sidebar 2nd-type pattern | `ReviewSidebar` `editorAnnotations` path |
| Ask AI on a selection | `askAI({ scope: { kind:'selection', label, text } })` (`useAIChat.ts:78-82`) — as `HtmlViewer` does |
| export | `exportAnnotations(blocks, anns, [], title, subject)` |

## Risks

1. **React vs web-highlighter marks (main).** The hook injects `<mark>` into React DOM; a `RenderedMarkdown` re-render can clobber them. Mitigation (all verified/standard): (a) `React.memo` the `AnnotatableDescription` so it re-renders only when `markdown`/`descriptionAnnotations` change — avoids incidental reconciliation; (b) re-run `applyAnnotations` in a `useEffect` keyed to `[descriptionAnnotations, <markdown key>]` — `applyAnnotationsInternal` is **idempotent** (skips already-marked ids), so this is safe to call liberally; (c) it falls back to `findTextInDOM(originalText)` if `startMeta` no longer resolves. Verify marks survive a panel re-render and a PR-context SSE tick.
2. **Live-context refresh.** Description body can change via SSE; an annotation's text anchor may not re-bind. Low frequency; v1 accepts (falls back to text-search or drops).

With Ask AI now confirmed as reuse (§7), the whole of Phase 1 is reuse — no genuinely new subsystem. Risk 1 (mark persistence) is the only real one.

## Decisions locked

- Comment-only, `comment` mode, only `CommentPopover`. ✓
- Shows in the Annotations sidebar under "PR description"; select/delete there. ✓
- Ask AI = reuse the existing `scope`-selection ask (as HtmlViewer does); answer in the AI sidebar with its "PR description" context. Optional: group the AI tab by `scope.label`. ✓
- Description first; comments (button-per-card) are Phase 2.

## Verification

- Select description text → comment box opens immediately (no toolbar) → add comment → highlight persists.
- Card appears in Annotations sidebar under "PR description"; count includes it; "Send Feedback" appears.
- Select the card → scrolls/focuses the highlight; delete the card → highlight + entry gone.
- Ask AI from the box → answer shows in the AI sidebar.
- Sent feedback contains a "PR Description Feedback" section.
- Marks survive a panel re-render + PR-context refresh. Plan editor + non-PR reviews unaffected.

## Preflight findings (verified against code, 2026-06-30)

All spec anchors confirmed. Three small implementation additions surfaced — none change the design:

1. **New sidebar card.** `EditorAnnotationCard` is typed to `EditorAnnotation` (label + filePath), so it doesn't fit the prose `Annotation` shape. Build a tiny `DescriptionAnnotationCard` (comment text + quoted `originalText` + author + delete + `isSelected`), rendered in the "PR description" group exactly where the `editorAnnotations` block sits (`ReviewSidebar.tsx:363-382`).
2. **Two counters, not one.** Update **both** `App.tsx:1712` `totalAnnotationCount` (gates Send Feedback) **and** `ReviewSidebar.tsx:149` `totalCount` (sidebar count/empty-state) to include `descriptionAnnotations.length`.
3. **Export details.** `exportAnnotations` leads with `# {title}` and sorts by `blockId`/`startOffset` — prose annotations carry both, and the block ids match because we parse the same `prContext.body`. When appending to `feedbackMarkdown`, prepend `\n\n` and guard on `prContext?.body`.

Confirmed exactly as spec'd: `exportAnnotations` signature (`blocks, annotations, [], title, subject`), `CommentPopover` props (`anchorEl/contextText/isGlobal/initialText/onSubmit/onClose/onAskAI/askAIContext`), the `feedbackMarkdown`/`totalAnnotationCount` insertion points, the `ReviewStateContext` `// Annotations` slot, and the sidebar invocation props.

**Greenlit.**

## References

- ADR: `adr/decisions/004-annotate-pr-description-and-comments-20260630-155000.md`
- Renderer spikes: `adr/research/SPIKE-renderer-migration-20260630-155500.md`, `adr/research/SPIKE-renderer-density-parameterization-20260630-160500.md`
