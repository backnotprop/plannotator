# tooltip (hand-rolled wrapper)

2026-07-07, transformation engine. Verdict: migrated with ZERO call-site churn —
the wrapper's public prop names are kept and mapped internally (house seam
style for this published package).

## Changed

- `packages/ui/components/Tooltip.tsx` — `@radix-ui/react-tooltip` →
  `@base-ui/react/tooltip`.
  - `TooltipProvider` was a bare re-export of Radix Provider; it is now a thin
    wrapper KEEPING the Radix-era prop names: `delayDuration` → Base `delay`,
    `skipDelayDuration` → Base `timeout` (same skip-window semantics),
    `disableHoverableContent` → carried via context and applied per-root as
    `disableHoverablePopup` (Base UI dropped the provider-level knob). Both
    app call sites (`packages/editor/App.tsx:3808`,
    `packages/review-editor/App.tsx:2651`) compile and behave unchanged.
  - `Tooltip` keeps its API (`content`/`side`/`align`/`delayDuration`/
    `sideOffset`/`wide`); internally `Trigger asChild` → `render={children}`,
    per-tooltip `delayDuration` moves to Trigger `delay`, Content →
    `Portal > Positioner > Popup` with side/align/sideOffset forwarded to the
    Positioner (FORWARD rule).
  - Classes: `data-[state=closed/delayed-open/instant-open]` opacity/scale
    dance → `data-[starting-style]`/`data-[ending-style]` transitions;
    `--radix-tooltip-content-transform-origin` → `--transform-origin`.
  - `children` type narrowed `ReactNode` → `ReactElement` (render prop needs
    an element; Radix asChild silently required one anyway). All 5 call sites
    (editor ×3, review-editor ×2) already pass single elements — verified,
    review-editor is not covered by tsc.
  Leftover scan clean: `grep -n "radix-ui\|@radix-ui\|asChild"` — no matches.

## Left alone

- All Tooltip call sites — byte-identical (the point of keeping the API).

## Behavior changes

- Default open delay when neither Provider nor call site sets one: Radix 700ms
  → Base UI 600ms. Both apps set Provider delays (900 / 200), so only
  provider-less consumers of the published package see it. HANDOFF item.
- Skip-window default (`skipDelayDuration` unset): 300ms → 400ms. Same
  provider-set caveat.
- Tooltip content is hoverable by default in BOTH engines; the editor app's
  `disableHoverableContent` behavior is preserved via the context seam.

## Verify by hand

- Plan app toolbar (wide-mode buttons): tooltip appears after ~900ms, moving
  pointer between adjacent buttons opens the next tooltip near-instantly
  (skip window), tooltip does NOT stay open when the pointer moves onto it.
- Review app file row "Mark as viewed": tooltip below the icon after ~300ms.
- DiffTypePicker hint (wide): wraps at 260px, positioned right.
