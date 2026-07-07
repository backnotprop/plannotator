# 006. Guided Review as a first-class code-review feature

Date: 2026-07-02

## Status

Accepted

## Context

Large changesets are hard to review file-by-file. Linear's Guides (beta) showed a better shape: an agent breaks the diff into chapters ordered the way the work was reasoned through — core implementation first, consequences next, glue code and low-signal changes separated out — with each chapter pairing a prose explanation of *why* the change exists alongside the relevant diffs.

Plannotator already has nearly all the infrastructure this needs: the agent-jobs engine (spawned CLI providers, SSE status/log streaming, structured-output parsing), the Code Tour provider as a precedent for schema-constrained narrative output, the shared agent-review prompt machine that describes any diff mode (PR or local), Pierre-based diff rendering (`FileDiff` / virtualized `CodeView`), and a single annotation system (`useAnnotationToolbar` → `CodeAnnotation` → `/api/feedback`) that already accepts annotations from multiple surfaces.

## Decision

Build **Guided Review** as a first-class feature of the Plannotator code-review app.

1. **Guide shape.** A guide is an ordered sequence of pages (sections). Each page has: a title, a position indicator ("01 / 04"), a **Reviewed** checkbox that collapses the page when checked, a prose overview (what the change is and why it exists), and one or more diff sections — real rendered slices of the same underlying review patch. A page may contain one diff or many.

2. **Works for any changeset.** Guides are generated for PRs and for local diffs alike (since-base, uncommitted, etc.). The guide title derives from the PR when one exists, otherwise from the changes themselves.

3. **Generation is an agent job.** The guide is produced by a spawned agent through the existing agent-jobs infrastructure — same launch path, same engine/model/effort settings (`useAgentSettings`), same SSE lifecycle. Structurally it follows the Code Tour provider: schema-constrained structured output built over the current diff context via the shared prompt machine (`agent-review-message.ts`).

4. **Presentation is a screen takeover, not a dialog or dock panel.** Entry point is a "Guide" badge in the top-left header, next to the file-tree toggle. Clicking it replaces the main workspace: file tree and center dock hidden; the right sidebar may remain. The screen is a clean, elegant, Notion-like page. With no guide yet, it shows the empty state — "Start a guided review?" — with launch controls and first-time model defaults (the same settings agent jobs use).

5. **Annotation parity is a hard constraint.** Diffs inside guide pages are annotated with the exact same components and state as the normal diff view — same toolbar/popover/suggestion machinery, same `CodeAnnotation` list in `App.tsx`, same feedback export. Reuse, not copies. An annotation made in a guide is indistinguishable from one made in the diff view and flows into the same Send Feedback payload.

6. **Scope calibration.** This is expected to be comparable in complexity to the agent-jobs section, not a new subsystem: a new job provider + output schema, a guide data model, a takeover screen, and composition of existing pieces.

Deliberately deferred (to be settled during spec/planning, not changing this decision): guide persistence beyond server memory (Tour is in-memory-only; guides may warrant durability), single-active-guide vs. multiple guides per session, and the anchoring granularity of guide diff slices back into the real patch (file-level vs. hunk-level).

## Consequences

- The review app gains a second primary reading mode: the existing file/diff workspace and the guide takeover screen, toggled from the header. Layout code must support hiding the file tree and center dock while keeping annotation and sidebar state live.
- A new agent-job provider (guide) joins `claude`/`codex`/`tour`/marker engines, with its own system prompt, output schema, parser, and result storage — following the Tour pattern (`packages/server/tour/`) rather than inventing a new lifecycle.
- The annotation system must be consumable from a second rendering surface without duplication; any coupling of `useAnnotationToolbar`/`DiffViewer` internals to the dock layout gets factored out rather than copied.
- Guide "Reviewed" checkbox state needs storage analogous to the Tour checklist (`PUT /api/tour/:jobId/checklist` precedent).
- Prompt and schema quality determine the feature's value: sectioning by semantic importance (core first, glue last) is the product, so the guide prompt gets the same level of care as `TOUR_REVIEW_PROMPT`.
