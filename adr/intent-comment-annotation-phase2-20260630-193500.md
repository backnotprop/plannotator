# Intent: annotate PR comments (Phase 2)

**Add** an "Annotate" action to every card in the PR comments timeline so a reviewer can attach a note to a comment, have it show in the Annotations sidebar, and ship it to the agent with the comment quoted — the same feedback lifecycle as a diff comment or a description note.

**Why.** The comments timeline is read-only. Reviewers want to respond to a specific comment — "this is the real concern," "disagree, here's why" — and fold that into the feedback they send the agent, without leaving the review. Unlike code (the agent can read the repo) a PR comment isn't visible to the agent, so the note has to carry the comment with it.

**How.** Put a single **"Annotate"** button in the shared hover action row (`PRCommentLinkActions`), which every card type already uses — so one change surfaces it on comments, reviews, and threads alike. Clicking it opens the existing shared `CommentPopover` (with Ask AI) anchored to the button; the note attaches to the whole comment (comment-only, no text-selection — comments are short, the trimmed renderer isn't annotation-ready, and selection would fight the card's click/collapse). Keep a simple new `CommentAnnotation` store (`{ id, commentId, commentAuthor, commentBody, text, createdAt }`) in `App.tsx`, threaded through `ReviewStateContext`; `PRCommentsTab` reads the handlers from `useReviewState()` and owns the popover state, threading an `onAnnotate` callback down to the inline cards and into `ThreadCard`. Surface the notes in the sidebar under a "PR comments" group (author + comment snippet + the note, select/delete) mirroring the description group, and fold them into `totalAnnotationCount` and the sidebar count. Wire Ask AI to the existing file-less scope-selection ask (`label: 'PR comment'`, `text: comment body`). Export via a **new dedicated formatter** `exportCommentAnnotations` — author + the full quoted comment body + the note — appended to `feedbackMarkdown`; deliberately **not** `exportMessageAnnotations`, which preflight showed is built for annotating assistant AI messages and would mislabel PR comments to the agent. No server, endpoint, or Pi-runtime changes; work is contained to `packages/review-editor` plus the shared `CommentAnnotation` type.

---

Decision trail:
- ADR: `adr/decisions/004-annotate-pr-description-and-comments-20260630-155000.md` (Decision 7's `exportMessageAnnotations`-for-comments is superseded — see spec)
- Spec (greenlit, with preflight findings): `adr/specs/comment-annotation-phase2-20260630-193000.md`
- Phase 1 (reference): `adr/specs/description-annotation-phase1-20260630-171500.md`, `adr/intent-description-annotation-phase1-20260630-180000.md`
