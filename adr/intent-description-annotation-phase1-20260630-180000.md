# Intent: comment on the PR description (Phase 1)

**Add** the ability to select text in a PR description and leave a comment that behaves like any other review comment — it shows in the Annotations sidebar, counts toward the review, and ships to the agent on Send Feedback.

**Why.** The PR Overview panel renders the description read-only. Reviewers want to flag specific parts of it — "this claim is wrong," "clarify this" — and have that feedback reach the agent alongside their diff comments, without leaving the review or retyping context. Today there's no way to annotate prose in the code review.

**How.** Reuse the existing prose-annotation engine (`useAnnotationHighlighter` + `CommentPopover`) on the description, which already renders through the shared `RenderedMarkdown` (so its DOM carries `data-block-id` and is annotation-ready). Run it **comment-only** (`comment` mode → the comment box opens directly on selection; no toolbar, quick-labels, or redline), deliberately simpler than plan/annotate. Wrap the description in a memoized `AnnotatableDescription` that mounts the hook, renders only `CommentPopover`, and re-applies highlights on change (idempotent, so safe). Keep a new `descriptionAnnotations: Annotation[]` store in `review-editor/App.tsx`, threaded through `ReviewStateContext`, separate from the diff `CodeAnnotation[]`. Surface the comments in the existing Annotations sidebar under a "PR description" group via a small new `DescriptionAnnotationCard`, mirroring the established `editorAnnotations` render/delete pattern (so select and delete come from the sidebar — no affordance on the highlight). Wire the comment box's Ask AI to the existing file-less `scope`-selection ask (`askAI({ scope: { kind:'selection', label:'PR description', text } })`), exactly as the HTML viewer does. Include the prose count in both the app-level `totalAnnotationCount` and the sidebar's `totalCount`, and append the notes to `feedbackMarkdown` via `exportAnnotations(parseMarkdownToBlocks(prContext.body), …, 'PR Description Feedback', 'PR description')`. Move the `.annotation-highlight` styles into shared `packages/ui/theme.css`. No server, endpoint, or Pi-runtime changes; the work is contained to `packages/ui` (moved CSS) and `packages/review-editor` (wrapper, store, context, sidebar group, count/export lines).

---

Research & decision trail:
- ADR: `adr/decisions/004-annotate-pr-description-and-comments-20260630-155000.md`
- Spec (final, greenlit): `adr/specs/description-annotation-phase1-20260630-171500.md`
- Synthesis / confidence: `adr/research/synthesis-description-annotation-20260630-174500.md`
- Renderer research: `adr/research/SPIKE-renderer-migration-20260630-155500.md`, `adr/research/SPIKE-renderer-density-parameterization-20260630-160500.md`
