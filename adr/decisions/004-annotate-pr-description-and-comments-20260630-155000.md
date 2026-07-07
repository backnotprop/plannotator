# 4. Annotate the PR description and comments, feeding the agent-feedback pipeline

Date: 2026-06-30

## Status

Accepted

## Context

The PR Overview panel shows the PR description and the comments timeline, but both are read-only. We want to select and comment on any part of the description (like the plan/annotate app), and to comment on individual PR comments, and have those notes flow into the feedback we send the agent — alongside the existing diff annotations.

Two annotation systems already exist:

- **Code review** (`CodeAnnotation`) anchors to diff lines (file + line + side). It cannot anchor to prose.
- **Plan/annotate** (`Annotation`) anchors to selected text in rendered markdown, using web-highlighter (`startMeta`/`endMeta` + `originalText`). Its engine — `useAnnotationHighlighter` + `AnnotationToolbar` + `CommentPopover` + `FloatingQuickLabelPicker` — lives entirely in `packages/ui` and has no plan-specific dependencies. It is already reused on a second surface (`useHtmlAnnotation.ts`, over an iframe), proving it is surface-agnostic.

The PR description/comments render through `MarkdownBody` in `PRSummaryTab.tsx` — a trimmed-down copy of our custom markdown engine that only handles 5 block types (heading, code, list-item, blockquote, hr) and has no real rendering for tables, HTML blocks, directives, or alerts. The full renderer (`BlockRenderer` + the `blocks/` components) is the same custom parser (`parseMarkdownToBlocks`) with the complete component set, and it emits the `data-block-id` DOM the highlighter needs.

## Decision

1. **Use the prose engine, not `CodeAnnotation`.** Annotate the PR description/comments with the plan/annotate text-anchored `Annotation` system (`useAnnotationHighlighter` + `AnnotationToolbar` + `CommentPopover` + `FloatingQuickLabelPicker`). Reuse the hook + those three components — **not** the whole plan `Viewer` (it carries ~50 plan-only props).

2. **Upgrade the renderer.** Replace the trimmed `MarkdownBody` for PR prose with the full shared block renderer. Extract the block-dispatch out of `Viewer` into a small shared `RenderedMarkdown` component so the plan viewer and the PR panels share one renderer (no duplication). This fixes HTML/table/alert rendering and makes the text annotatable in the same move.

3. **Two interaction styles — comment-only (intentionally simpler than plan/annotate).**
   - **Description** → select text and the **comment box opens immediately**. Comment-only: no toolbar, no quick-labels, no delete/redline picker. This maps to the highlighter's `comment` mode (select → `CommentPopover` directly). This is a deliberate divergence from plan/annotate, which shows a multi-option toolbar.
   - **Each comment** → a small "comment" button on the card that opens the same `CommentPopover` and attaches a note to that comment. No text-selection inside comment cards (avoids fighting the cards' click/collapse handlers).

4. **One comment popover, with Ask AI.** Use the existing shared `CommentPopover` — the same component the code review uses for file comments. Wire its **Ask AI** action so you can ask AI about the selected description text (reusing the review editor's existing Ask AI backbone). No new popover.

5. **Separate store.** Keep a new `Annotation[]` (prose) store, lifted to `review-editor/App.tsx` and threaded via `ReviewStateContext`, distinct from the existing `CodeAnnotation[]`. The two models stay separate in memory.

6. **Show it in the Annotations sidebar under "PR description".** Description comments render in the existing review Annotations sidebar, in their own "PR description" group, alongside diff comments — select, edit, and delete there, just like any annotation. The sidebar already renders a second annotation type (`editorAnnotations`, with its own delete path), so this follows that established pattern rather than a novel merge. Delete/select therefore come "for free" from the sidebar — no separate affordance on the highlight.

7. **Feed the existing pipeline, no server change.** Prose annotations count toward `totalAnnotationCount` (so "Send Feedback" appears) and are appended to `feedbackMarkdown` via `exportAnnotations` (description) / `exportMessageAnnotations` (comments). Rides the existing `/api/feedback` POST — no new endpoints.

8. **Phasing.** Description first (proves the full pipeline end to end — select → comment → sidebar → send), comments second.

## Consequences

- The review editor will hold two annotation models at once (`CodeAnnotation[]` for the diff, `Annotation[]` for prose). They stay separate in memory and are joined only at the presentation edges — the Annotations sidebar (a new "PR description" group, mirroring the existing `editorAnnotations` render/delete pattern) and the exported feedback markdown.
- Swapping the description renderer to `RenderedMarkdown` will shift the panel's spacing/styling; that needs to be matched back.
- Prose annotations have no real file/line; the export labels them by source ("PR description" / "comment by @x") instead of `file:line`. `exportAnnotations` already degrades gracefully without line numbers.
- Extracting `RenderedMarkdown` touches the plan `Viewer` (it starts consuming the shared component). Low risk, but it is a shared-code change, not isolated to the review editor.
- No server, endpoint, or Pi-runtime changes — the work is contained to `packages/ui` (shared renderer + reused annotation components) and `packages/review-editor` (state, wiring, the per-comment button).
- The comment-card click conflict is designed out (button instead of selection), so it is not a runtime risk.
