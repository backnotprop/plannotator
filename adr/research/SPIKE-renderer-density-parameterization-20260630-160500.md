# SPIKE: Making the markdown renderer's size/spacing parameterized

Date: 2026-06-30

## Question

The block renderer's text sizes and spacing are baked in for a full-page plan (h1 24px, body 15px, big margins). The PR panel needs them smaller/tighter. What's the cleanest way to make the renderer's density a knob, ideally reusing patterns the codebase already has?

## Finding: the sizes are scattered, with no single knob

The hardcoded sizes/spacing live as **inline Tailwind utilities across ~9 components**, not in one place:

- `BlockRenderer.tsx` — `text-2xl/xl/base/[15px]/sm`, `mb-4 mt-6 my-4 mb-2`, `my-8` (hr).
- `blocks/CodeBlock` (`text-[13px]`, `my-5`), `blocks/TableBlock` (`text-sm`, `my-4`, `py-2 px-3`), `blocks/HtmlBlock` (`text-[15px]`, `my-4`), `blocks/Callout` + `blocks/AlertBlock` + `blocks/proseBody` (`text-[15px]`, `my-4`, `mt-2`), `InlineMarkdown` (`text-sm`, inline-code sizes), `ListItemBody` (`text-sm`).

So today there is **no** way to scale the renderer — every size is a literal utility on an element. Any parameterization has to either (a) replace those literals with something configurable, or (b) override them from a wrapping scope.

## The codebase already has the patterns we'd reuse

1. **A CSS-variable type scale** — `theme.css:107-110`: `--text-sm: 0.875rem; --text-sm--line-height: 1.45;` … through `--text-xl`. Tailwind v4 reads these. The renderer ignores it in places (uses arbitrary `text-[15px]`, fixed `text-2xl`), but the scale exists.
2. **A var-driven font-size override, already used for exactly this** — `--diff-font-override` / `--diff-font-size-override` (`review-editor/index.css:282, 1275+`). Setting the var on `:root` cascades into the diff/comment markdown via a scoped selector, overriding the inline sizes. This is a working precedent for "drive sizing from a CSS variable + scope."
3. **A `.compact` modifier precedent** — `.suggestion-block.compact` (`index.css:869`).
4. **`configStore` / `useConfigValue`** already carries user font settings (it's what feeds the diff override).

## Options (with tradeoffs)

**A. CSS-variable size/rhythm layer (recommended).**
Introduce a small set of `--md-*` variables for the type scale + block rhythm (e.g. `--md-h1`, `--md-h2`, `--md-body`, `--md-block-gap`, `--md-code`), have the renderer's elements read them, default them to today's plan values (so the plan viewer is visually unchanged), and add a `.md-compact` scope that sets smaller values for the PR panels.
- *Dynamic:* density becomes a real knob — compact/default now, and trivially user-tunable later (it can hang off `configStore`, like the diff font size already does).
- *Cost:* the ~9 components must read the vars instead of literal utilities (replace `text-2xl` → a var-backed class/`style`, `mb-4` → `var(--md-block-gap)`). One-time edit, but it touches shared components used by the plan viewer — needs defaults pinned to current values so the plan is pixel-identical.
- *Matches precedent:* same shape as `--diff-font-size-override` and the `--text-*` scale.

**A-lite. Pure CSS override scope (least churn).**
Leave the components alone; add a `.md-compact` scope in CSS with element selectors (`.md-compact h1 { font-size:…; margin:… }`) that beat the inline utilities by specificity (element+class > class), exactly how `--diff-font-size-override`'s scoped selector overrides today.
- *Pro:* zero component changes; isolated to one CSS block; can't regress the plan viewer.
- *Con:* brittle — it has to mirror every size/margin the components set, and silently drifts if a component's class changes. A "shadow stylesheet."

**B. `density`/`size` prop drilled through BlockRenderer + every block component.**
- *Pro:* explicit, type-safe.
- *Con:* most invasive — every component grows a prop and a density→class map. Verbose, and the prop has to be threaded through `groupBlocks`/Viewer too. Least elegant.

**C. Tailwind `prose` + `prose-sm`.**
- Would mean rewriting the renderer onto the typography plugin (dropping the per-element utilities). Big rewrite, not how anything here renders. Rejected.

## Recommendation (for the spec)

Go with **A — the `--md-*` CSS-variable layer**, defaulted to the current plan values and overridden by a `.md-compact` scope on the PR panels. It's the only option that's both *clean* (one source of truth for the type scale + rhythm) and *dynamic* (compact today, user-tunable later via `configStore`, just like the diff font size). It directly reuses two existing patterns (`--text-*` scale, `--diff-font-size-override`).

Use **A-lite** only if we want to ship the PR-panel fix with zero risk to the plan viewer first, and migrate to A later — but A-lite's shadow stylesheet is debt, so prefer A unless we're time-boxed.

Avoid B (prop-drilling churn) and C (rewrite).

## Open questions for the spec

1. **Scope of the var conversion:** full `--md-*` layer across all ~9 components (clean), or start with the loud offenders (headings + block gaps + body) and leave code/table/inline as-is?
2. **Variant delivery:** a `.md-compact` class on the PR container, or a prop on the new `RenderedMarkdown` that toggles the class? (Class is simpler; prop is more discoverable.)
3. **Two variants or N:** just `default` (plan) + `compact` (PR), or make it a continuous scale tied to `configStore` from day one (probably overkill for v1)?
4. **Pin defaults:** confirm the plan viewer must stay pixel-identical (defaults = today's literals), so this can't be a "while we're here, retune the plan" change.

## Files referenced

- `packages/ui/components/BlockRenderer.tsx`, `InlineMarkdown.tsx`, `ListItemBody.tsx`
- `packages/ui/components/blocks/{CodeBlock,TableBlock,HtmlBlock,Callout,AlertBlock,proseBody}.tsx`
- `packages/ui/theme.css:107-110` (`--text-*` scale)
- `packages/review-editor/index.css:282, 1275+` (`--diff-font-override` / `--diff-font-size-override` precedent), `:869` (`.compact` precedent)
- `packages/ui/config` (`configStore` / `useConfigValue`)
