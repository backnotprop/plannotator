# badge

2026-07-07, transformation engine (no golden pair — hand-vendored kit, no
components.json). Verdict: clean 1-file migration, API change `asChild` → `render`.

## Changed

- `packages/ui/components/ui/badge.tsx` — `@radix-ui/react-slot` Slot idiom
  (`const Comp = asChild ? Slot : "span"`) → `useRender` + `mergeProps` from
  `@base-ui/react/use-render` / `@base-ui/react/merge-props`, prop type
  `useRender.ComponentProps<"span">`. `data-slot` literal cast
  `as React.ComponentProps<"span">` per the mergeProps excess-property pitfall.
  Classes byte-identical. Doc comment updated (`asChild` → `render`).
  Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` — no matches.

## Left alone

- `badgeVariants` cva definition — untouched.
- No internal consumers exist (published export only); nothing to sweep.

## Behavior changes

- Public API: `asChild` prop removed; polymorphism is now
  `render={<a ... />}`. No in-repo call sites passed `asChild`. Consumer-visible
  → listed in HANDOFF 0.23.0 notes.

## Verify by hand

- Render a default and an `outline` badge: identical look to 0.22.0.
- `<Badge render={<a href="#" />}>link</Badge>` renders an `<a>` with badge
  classes and working hover (`[a&]:hover:*` variants).
