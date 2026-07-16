# Spec: Phase 2 — annotate PR comments

Date: 2026-06-30
Status: draft → preflight

Implements the comments slice of ADR 004. Design locked in discussion; this records it and the one correction preflight surfaced.

## The requirement (plain)

On every card in the PR comments timeline, an **"Annotate"** button in the existing hover action row (next to View on GitHub / Copy). Click it → the comment box opens → type a note (or Ask AI) → the note shows in the Annotations sidebar under "PR comments", counts toward the review, and ships to the agent with the full comment quoted.

Comment-only (a note on the whole comment). **Not** text-selection inside comments — that's deferred (comments are short, still on the trimmed renderer, and selection fights the card's click/collapse).

## Decisions (locked)

1. **Button, not selection.** One "Annotate" button per card. Comments are short → the whole comment is the unit; a button avoids the selection-vs-card-click conflict and needs no renderer migration.
2. **Every card, via the shared action row.** Add the button to `PRCommentLinkActions` (`PRCommentsTab.tsx:686`) — the hover row already used by comment/review cards (`:533`) and the thread card (`:679`). One change → shows on all card types. Threads annotate as a unit (the row sits on the thread's first comment).
3. **Label "Annotate"** (not "Comment"/"Reply") — this never posts to GitHub; it's agent feedback. "Comment" reads like a reply.
4. **Sidebar:** a "PR comments" group — author + a short comment snippet + your note (compact; you can see the full comment on screen).
5. **Agent export:** author + **full comment body** + your note. Unlike code (agent can read the repo), the agent can't see a PR comment, so it must be quoted inline.
6. **Ask AI:** reuse the file-less scope-selection ask with the comment body as `text` and label "PR comment" — same mechanism as the description.

## Preflight correction (verified against code)

**`exportMessageAnnotations` is the wrong export and will NOT be used.** Reading `parser.ts:755-812`: `MessageAnnotationEntry` and `exportMessageAnnotations` are built for annotating **assistant AI messages** — they expect text-anchored `annotations: Annotation[]` inside a message and hard-code "Message Feedback" / "assistant message" / "Message excerpt" wording. That misrepresents PR comments to the agent. ADR 004 assumed this fit; it doesn't.

Instead:
- **Store:** a simple new type `CommentAnnotation { id: string; commentId: string; commentAuthor: string; commentBody: string; text: string; createdAt: number }`. No text anchoring, no blocks.
- **Export:** a small dedicated formatter `exportCommentAnnotations(anns): string`:
  ```markdown
  # PR Comment Feedback

  ## Comment by @author
  > quoted comment body (fenced/quoted)

  your note
  ```

## The build

### 1. Store (App.tsx)
- `const [commentAnnotations, setCommentAnnotations] = useState<CommentAnnotation[]>([])`
- `const [selectedCommentAnnotationId, setSelectedCommentAnnotationId] = useState<string|null>(null)`
- Handlers: `onAddCommentAnnotation(commentId, author, body, note)` (build the record, append), `onSelectCommentAnnotation(id)`, `onDeleteCommentAnnotation(id)`.
- `handleAskAIForComment(question, context)` → `askAI({ prompt, scope: { kind:'selection', label:'PR comment', text: context.text } })` (mirrors `handleAskAIForDescription`).
- Thread through `ReviewStateContext` (interface + value + deps), like the description store.

### 2. The Annotate button + popover (PRCommentsTab)
- `PRCommentsTab` is props-based; it (or a small child) reads the add/ask handlers from `useReviewState()` — same move as `AnnotatableDescription`. Simplest: `PRCommentLinkActions` gains props `{ commentId, author, onAnnotate(el) }`; PRCommentsTab owns a small popover state `{ commentId, author, body, anchorEl } | null`.
- Add the "Annotate" button (left of View on GitHub) in `PRCommentLinkActions`; onClick sets the popover state with the button element as anchor.
- Render `CommentPopover` (one, at the tab root) when popover state is set: `anchorEl`, `contextText` = truncated comment, `isGlobal: false`, `onSubmit` = build the note → `onAddCommentAnnotation` → clear state, `onClose` = clear, `onAskAI` = `onAskAIForComment`, `askAIContext = { kind:'selection', label:'PR comment', text: body }`.

### 3. Sidebar "PR comments" group (ReviewSidebar)
- Props `commentAnnotations?`, `selectedCommentAnnotationId?`, `onSelectCommentAnnotation?`, `onDeleteCommentAnnotation?`.
- `renderCommentAnnotationCard` mirroring `renderDescriptionAnnotationCard`: "PR comment" label + `@author` + snippet of `commentBody` (line-clamp) + the note; select + delete.
- Group rendered after "PR description"; fold `commentAnnotations.length` into `totalCount`.
- Select → focuses/scrolls the target comment card **only while the PR Overview panel is open** (same cross-panel caveat as the description). v1 accepts.

### 4. Count + export (App.tsx)
- `totalAnnotationCount += commentAnnotations.length`.
- `feedbackMarkdown`: append `exportCommentAnnotations(commentAnnotations)` when non-empty (new formatter in `review-editor/utils/exportFeedback.ts` or `parser.ts`).

## Reuse map

| Need | Reuse |
|---|---|
| comment box + Ask AI | `CommentPopover` (`onAskAI`/`askAIContext`) |
| Ask AI on a selection | `askAI({ scope:{ kind:'selection', label, text } })` |
| sidebar group + card | mirror `renderDescriptionAnnotationCard` + the group block |
| context threading | mirror the description store fields |
| action row | `PRCommentLinkActions` (add one button) |

New: the `CommentAnnotation` type, `exportCommentAnnotations` formatter, and the per-tab popover state (no highlighter — it's button-driven, not selection-driven).

## Risks

1. **No mark-persistence risk** — button-driven, no web-highlighter marks in the comment DOM. Simpler than Phase 1 on this axis.
2. **Cross-panel focus** — selecting a sidebar card focuses the comment only while the Overview panel is open (same as description). Accepted for v1.
3. **Popover anchor stability** — the comment card can collapse/scroll while the popover is open; anchor to the button element and let `CommentPopover` reposition (it already re-reads on scroll).

## Verification

- Hover any card (comment / review / thread) → "Annotate" appears in the action row → click → comment box opens anchored to it.
- Submit → card appears in the sidebar under "PR comments" (author + snippet + note); count + "Send Feedback" reflect it.
- Delete from the sidebar removes it; Ask AI from the box answers in the AI tab.
- Sent feedback contains a "PR Comment Feedback" section with the **full quoted comment** + note.
- Non-PR reviews + the description flow unaffected.

## Preflight findings (verified against code, 2026-06-30)

All anchors confirmed. Specifics that shape the wiring:

1. **`PRCommentLinkActions` is used in two places** — inline comment/review cards (`:533`) and inside `ThreadCard` (`:679`). Both need the new props. For a thread, the annotated unit is the thread: pass `commentId = thread.id`, `author`/`body` from `thread.comments[0]`.
2. **`ThreadCard` is a module-level component** (`:553`), not inside the `PRCommentsTab` closure — so `onAnnotate` must be threaded to it as a prop, then down to its `PRCommentLinkActions`. (The inline cards at `:533` are in-closure and can call the setter directly.)
3. **Button styling** mirrors the View-on-GitHub link (`flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-muted/30`). The row is `justify-end`, so "left of the others" = first flex child.
4. **Handlers via context:** `PRCommentsTab` is props-based (`{ context, platformUser }`) but renders inside the provider, so it calls `useReviewState()` for `onAddCommentAnnotation` / `onAskAIForComment`, and owns a local `annotating` popover state, rendering one `CommentPopover` at the tab root. Same pattern as `AnnotatableDescription`.
5. **`commentId` = the entry id** (`data-comment-id` on the cards, `:490`/`:571`) — so a future sidebar-select can scroll to the card.

**Greenlit.**

## References

- ADR: `adr/decisions/004-annotate-pr-description-and-comments-20260630-155000.md` (Decision 7's `exportMessageAnnotations` for comments is superseded here)
- Phase 1 spec: `adr/specs/description-annotation-phase1-20260630-171500.md`
