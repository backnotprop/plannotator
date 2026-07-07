# Synthesis: PR description annotation (Phase 1) — confidence review

Date: 2026-06-30

Consolidates the research behind ADR 004 / the Phase 1 spec and records a final, code-verified confidence check. Bottom line: **every part of Phase 1 is reuse of an existing, in-production mechanism.** One risk is real (mark persistence) and has a known mitigation.

## What we're building

Select text in the PR description → comment box opens immediately (comment-only) → the note (optionally an Ask-AI) appears in the Annotations sidebar under a "PR description" group, counts toward the review, and ships to the agent on Send Feedback. Same lifecycle as a diff comment, anchored to prose.

## Research trail

- Annotation systems (two in-session spikes): code review uses `CodeAnnotation` (line-anchored); plan/annotate uses `Annotation` (text-anchored via web-highlighter). The prose system is the right fit and lives entirely in `packages/ui`, already reused on a second surface (`useHtmlAnnotation` over an iframe).
- Renderer: `SPIKE-renderer-migration` + `SPIKE-renderer-density-parameterization` → done. The description now renders through the shared `BlockRenderer` (`RenderedMarkdown`) with `data-block-id`, so the DOM is annotation-ready.
- This pass: verified the remaining load-bearing claims against the code.

## Verified against code (confidence check)

| Claim | Verified | Evidence |
|---|---|---|
| Comment-only (select → popover, no toolbar) | ✅ | `useAnnotationHighlighter.ts` CREATE handler: `mode==='comment'` → `setCommentPopover(...)`; toolbar only in the `else` branch |
| Restoration is safe to re-run | ✅ | `applyAnnotationsInternal` skips already-marked ids (`getDoms`/`[data-bind-id]`), then `fromStore` → `findTextInDOM` fallback |
| Click a highlight selects it | ✅ | `Highlighter.event.CLICK → onSelectAnnotation(id)` |
| Sidebar already carries a 2nd annotation type | ✅ | `ReviewSidebar` `editorAnnotations` → `EditorAnnotationCard`, own delete, `totalCount` sums both |
| App has the description body for export | ✅ | `App.tsx:302` `prContext`; `feedbackMarkdown` (`:1704`), `totalAnnotationCount` (`:1712`) |
| Ask AI on a file-less selection exists | ✅ | `AskAIParams.scope`; `buildDefaultPrompt` (`useAIChat.ts:78-82`) builds `Re: {label}` + `Selected text:` + prompt; used by `HtmlViewer` |
| Highlight CSS + `--focus-highlight` | ✅ | styles in `packages/editor/index.css:118-161`; `--focus-highlight` in the theme files the review editor loads (works in the plan editor) |

## The one real risk — and the mitigation

**web-highlighter injects `<mark>` into React-rendered DOM; a re-render of `RenderedMarkdown` can wipe them.** This is the only thing that needs care.

Mitigation (all known, low-novelty):
1. `React.memo` the `AnnotatableDescription`/`RenderedMarkdown` so it re-renders only when `markdown` or `descriptionAnnotations` change — avoids incidental reconciliation from parent re-renders.
2. Re-apply after renders: `useEffect(() => hook.applyAnnotations(descriptionAnnotations), [descriptionAnnotations, <markdown key>])`. Idempotent (verified), so liberal calls are safe.
3. Text-search fallback in `applyAnnotations` re-binds by `originalText` if `startMeta` doesn't resolve after a DOM change.

Residual: a live-context SSE update that *changes the description text* under an annotation may drop that annotation's anchor. Low frequency; accepted for v1.

## Confidence

**High.** No genuinely new subsystem — comment engine, comment box, Ask AI, sidebar, export, and count are all existing mechanisms wired to a new surface. The new code is small (wrapper + a store + context fields + a sidebar group + two export/count lines + moved CSS). The single real risk is a well-understood React-vs-DOM-injection issue with a standard mitigation the plan viewer already uses.

## Ready-to-build checklist (from the spec)

1. `AnnotatableDescription` wrapper (`React.memo`) — hook in `comment` mode, render only `CommentPopover`, re-apply effect.
2. `descriptionAnnotations` store + handlers in `App.tsx`; thread via `ReviewStateContext` (value **and** deps).
3. `ReviewSidebar`: "PR description" group mirroring `editorAnnotations`/`EditorAnnotationCard`.
4. `totalAnnotationCount` + `feedbackMarkdown` include prose (`exportAnnotations(parseMarkdownToBlocks(prContext.body), …, 'PR Description Feedback', 'PR description')`).
5. Ask AI: `onAskAI` → `askAI({ scope: { kind:'selection', label:'PR description', text } })` (as `HtmlViewer`).
6. Move `.annotation-highlight` styles into `packages/ui/theme.css`.

## References

- ADR: `adr/decisions/004-annotate-pr-description-and-comments-20260630-155000.md`
- Spec: `adr/specs/description-annotation-phase1-20260630-171500.md`
- Renderer spikes: `adr/research/SPIKE-renderer-migration-20260630-155500.md`, `adr/research/SPIKE-renderer-density-parameterization-20260630-160500.md`
