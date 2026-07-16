# SPIKE: Migrating the PR description/comments renderer to the full block renderer

Date: 2026-06-30

## Question

Before we add annotation to the PR description/comments, we want the same complete markdown rendering the plan/annotate app uses. What exactly is the current renderer missing, what is the "full" renderer made of, how reusable is it, and what are the risks of switching?

## Current state: two renderers, one parser

Both renderers parse with the **same** custom engine — `parseMarkdownToBlocks` (`packages/ui/utils/parser.ts`). They differ only in what they do with the blocks.

- **Trimmed (`MarkdownBody`)** — `packages/review-editor/components/PRSummaryTab.tsx`. A local `switch (block.type)` that handles only **heading, code, list-item, blockquote, hr**, plus a default paragraph path. Inline content uses the review-editor's own `renderInlineMarkdown` (`utils/renderInlineMarkdown.tsx`); raw HTML is DOMPurify-sanitized inline (`SafeHtml`).
  - **Missing:** dedicated rendering for `table`, `html`, `directive`, and GitHub `alert` blocks. They all fall through to the paragraph path, so tables/callouts/HTML blocks render as plain or sanitized-inline text — not as tables/callouts.
  - **Used in two places:** the PR **description** (PRSummaryTab) and **every comment/review/thread/reply body** in `PRCommentsTab.tsx`. Both pass a `textClassName` (added recently) to control base text size.

- **Full (`BlockRenderer`)** — `packages/ui/components/BlockRenderer.tsx`. A `switch (block.type)` covering **heading, blockquote (+ alert), list-item, code, table, hr, html, directive, paragraph**. It delegates to the shared block components (`blocks/CodeBlock`, `TableBlock`, `HtmlBlock`, `Callout`, `AlertBlock`, plus `InlineMarkdown`, `ListItemBody`). Every block is rendered with `data-block-id`.

## What the "full renderer" actually is

There are two layers, and they are very different in weight:

1. **`BlockRenderer` — the clean, reusable core.** All its props are optional callbacks (`onOpenLinkedDoc`, `onOpenCodeFile`, `imageBaseDir`, `onImageClick`, `onToggleCheckbox`, `githubRepo`, `onNavigateAnchor`, `orderedIndex`). **No plan/session/store dependency.** It already dispatches `code → CodeBlock` and `table → TableBlock` itself, so on its own it renders every block type correctly. The block components it pulls in (`CodeBlock` = hljs, `HtmlBlock` = marked + DOMPurify, `TableBlock` = copy toolbar/popout, `Callout`/`AlertBlock` = `renderProseBody`) all live in `packages/ui` and take `block` + optional callbacks. Clean.

2. **The Viewer render loop — heavy, plan-specific.** `Viewer.tsx:641-720` wraps `BlockRenderer` with a pile of plan-only behaviour: `groupBlocks` (list grouping for ordered-list indices), `MermaidBlock`/`GraphvizBlock` (diagram rendering), code-block and table **hover toolbars** (used for code-block annotation in plan mode), a lightbox, frontmatter card, and the `pinpoint` input method. This loop is **not** something the PR panels want.

**Takeaway:** the genuinely reusable unit is `BlockRenderer` (+ the `blocks/` components), not Viewer's loop. ADR 004 said "extract the block-dispatch out of Viewer into a shared `RenderedMarkdown`." The accurate version is narrower: build a **lean** `RenderedMarkdown` on top of `BlockRenderer` (`groupBlocks` + map → `BlockRenderer`, with ordered-list indices, **without** the diagrams/toolbars/lightbox), and reuse it in the PR panels. We do **not** need to refactor Viewer's rich loop to share one renderer — that would drag all the plan concerns into the shared component and is the foot-gun to avoid. `BlockRenderer` is already the shared unit both paths rest on.

## The real risk: styling / density

`BlockRenderer`'s classes are hardcoded for a **full-page plan document**: `h1 = text-2xl mb-4 mt-6`, `h2 = text-xl mt-8`, paragraphs `text-[15px] mb-4`, `hr my-8`, etc. The PR Overview panels are **compact** (12–13px text, tight spacing), and the comments timeline is denser still. Dropping `BlockRenderer` in raw would make the description read like a full plan doc — oversized headings, heavy vertical rhythm — inside a small panel.

So the migration is not just "swap the component." It needs **size/density control**:

- The current `MarkdownBody` already exposes `textClassName` for exactly this reason. The replacement must preserve equivalent control.
- Options (to decide in the spec): parameterize `BlockRenderer`/`RenderedMarkdown` with a density/size variant; or wrap output in a prose-scope class that overrides the sizes; or pass a size token down. The block components' hardcoded classes (`text-[15px]` in `BlockRenderer` and `renderProseBody`) are the things that need to flex.

This styling reconciliation — for both the description **and** the comment bodies — is the bulk of the real work and the main thing that can go wrong.

## Secondary considerations

- **Diagrams.** PR descriptions can contain ` ```mermaid ` blocks. The lean renderer (without Viewer's Mermaid/Graphviz dispatch) renders them as a code block, not a diagram. Acceptable for v1; wiring `MermaidBlock`/`GraphvizBlock` in is an additive follow-up.
- **Inline renderer swap.** Moving to `BlockRenderer` swaps the review-editor's `renderInlineMarkdown` for the shared `InlineMarkdown` (which additionally handles images, linked-doc/code-file links, anchors). Likely an upgrade; needs a visual check that inline styling matches the compact panel.
- **Annotation payoff.** `BlockRenderer` emits `data-block-id` on every block — exactly the DOM the annotation hook wants. So the renderer migration is also what makes the prose annotatable; the two are coupled by design, which is why we do this first.
- **Shared-code blast radius.** Reusing `BlockRenderer` is low risk (it's already in production via the plan viewer). Building a new lean `RenderedMarkdown` is additive. We can avoid touching `Viewer` entirely in v1.

## Open questions for the spec

1. **Density mechanism:** parameterize `BlockRenderer`/`RenderedMarkdown` with a size variant, or wrap in an overriding prose-scope class? (Affects both description and comments.)
2. **One renderer or two consumers:** new lean `RenderedMarkdown` used by the PR panels only (Viewer untouched), or also refactor Viewer onto it later? Recommend: PR-panels-only for v1, leave Viewer alone.
3. **Comments:** migrate comment bodies to the full renderer too (consistency + better HTML/tables), or only the description in v1? The comment bodies are the denser surface, so they stress the density question most.
4. **Diagrams:** render mermaid/graphviz as code in v1 (simple) or wire the diagram blocks now?

## Files referenced

- `packages/review-editor/components/PRSummaryTab.tsx` (`MarkdownBody`, the trimmed renderer)
- `packages/review-editor/components/PRCommentsTab.tsx` (consumes `MarkdownBody` for all comment bodies)
- `packages/review-editor/utils/renderInlineMarkdown.tsx` (review-editor inline renderer)
- `packages/ui/components/BlockRenderer.tsx` (the full, reusable core)
- `packages/ui/components/Viewer.tsx:641-720` (the heavy plan render loop), `:953` (`groupBlocks`)
- `packages/ui/components/blocks/` (`CodeBlock`, `TableBlock`, `HtmlBlock`, `Callout`, `AlertBlock`, `proseBody`)
- `packages/ui/components/InlineMarkdown.tsx`, `ListItemBody.tsx`
- `packages/ui/utils/parser.ts` (`parseMarkdownToBlocks`, shared by both renderers)
