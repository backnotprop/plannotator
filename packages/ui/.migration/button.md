# button

2026-07-07, transformation engine. Verdict: migrated to the REAL
`@base-ui/react/button` primitive (per skill rule — not a useRender wrapper);
API change `asChild` → `render`.

## Changed

- `packages/ui/components/ui/button.tsx` — `Slot`/`Slottable` from
  `@radix-ui/react-slot` → `<ButtonPrimitive>` from `@base-ui/react/button`.
  `Slottable` wrapper around `children` dropped: Base UI `render` composes
  children inside the rendered element natively, so `iconLeft`/`iconRight`
  siblings need no slot machinery. Props type:
  `ButtonPrimitive.Props & VariantProps<typeof buttonVariants> & { iconLeft?; iconRight? }`.
  cva classes byte-identical.
  Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` — no matches.

## Left alone

- Consumers `AnnotationPanel.tsx`, `ToolbarButtons.tsx` — pass only
  variant/size/onClick/className; no `asChild` call sites anywhere in the repo;
  compile unchanged.

## Behavior changes

- Public API: `asChild` removed → `render`. No in-repo call sites. HANDOFF item.
- Base UI Button forwards its ref as `HTMLElement` (Radix path was
  `HTMLButtonElement`). No in-repo refs typed against it; strict gate green.
- Disabled buttons: Base UI additionally manages `aria-disabled`/focus
  semantics (`focusableWhenDisabled` default `false` = native-like). Visual
  `disabled:*` classes unchanged.
- Default `type` is now `"button"` (Base UI sets it; a plain `<button>` was
  implicitly `type="submit"`). Explicit `type="submit"` still overrides. No
  `<form>` exists in packages/ui or packages/editor — consumer-only delta,
  listed in HANDOFF item 12.

## Verify by hand

- Click Approve (success variant) and Feedback (outline) in the plan app —
  styles and click behavior identical.
- Disabled state: opacity-50 + no pointer events.
- Keyboard: Tab focuses, Enter/Space activates; focus ring visible.
