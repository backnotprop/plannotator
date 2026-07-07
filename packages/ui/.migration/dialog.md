# dialog

2026-07-07, transformation engine. Verdict: restructured Overlay→Backdrop,
Content→Popup; keyframe animations → transition-based starting/ending styles.

## Changed

- `packages/ui/components/ui/dialog.tsx` — `@radix-ui/react-dialog` →
  `@base-ui/react/dialog`.
  - `DialogOverlay` now wraps `DialogPrimitive.Backdrop` (export name kept).
  - `DialogContent` now wraps `DialogPrimitive.Popup` inside
    `Portal > Backdrop > Popup` (centered modal — no Positioner, per the
    overlays reference). `hideClose` custom prop preserved.
  - Animations: `data-[state=open]:animate-in fade-in-0 zoom-in-95` /
    `animate-out fade-out-0 zoom-out-95` (keyframes) →
    `transition-[opacity,scale] duration-200` +
    `data-starting-style:opacity-0/scale-95` + `data-ending-style:*`
    (Base UI holds the popup mounted through the exit transition natively).
  - Structural/visual classes (centering translate, rounded-2xl, shadow,
    z-[110]) byte-identical.
  Leftover scan clean: `grep -n "radix-ui\|@radix-ui"` — no matches.

## Left alone

- `DialogHeader` — plain div, no primitive; untouched.
- Zero consumers of this kit dialog in the repo (`review-editor/TourDialog`
  hand-rolls its own dialog markup and does not import this file).

## Behavior changes

- `onOpenChange` gains a second `eventDetails` arg (single-arg handlers stay
  type-safe). Per-interaction dismiss callbacks (`onEscapeKeyDown`,
  `onPointerDownOutside`, `onInteractOutside`) no longer exist as Content
  props — consumers use Root `onOpenChange` `eventDetails.reason` + `cancel()`.
  HANDOFF item (no in-repo call sites).
- Enter/exit animation is now transition-based; visual feel equivalent
  (200ms fade+scale) but implemented via `[data-starting-style]` /
  `[data-ending-style]` instead of tw-animate keyframes.

## Verify by hand

- Open/close a dialog: fade+scale in and out, dark blurred backdrop.
- Escape closes; click outside closes; X button closes; focus returns to the
  trigger on close.
- `hideClose` renders no X button.
