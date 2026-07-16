# popover (hand-rolled wrapper)

2026-07-07, transformation engine. Verdict: Positioner model adopted;
`PopoverAnchor` export dropped (zero consumers, no Base UI part); 2 consumers
swept in the same commit.

## Changed

- `packages/ui/components/Popover.tsx` — `@radix-ui/react-popover` →
  `@base-ui/react/popover`. `PopoverContent` now renders
  `Portal > Positioner > Popup`; `side`/`align`/`sideOffset`/`alignOffset`
  declared→destructured→forwarded to Positioner (FORWARD rule); wrapper
  defaults preserved (`align='center'`, `sideOffset=6`). Positioner gets
  `isolate z-[100]`; Popup keeps the original class string byte-for-byte
  (including the `.popover-enter` mount-animation hook, which is
  engine-agnostic — a keyframe on mount, defined in review-editor/index.css).
  `PopoverAnchor` export removed: Base UI has no Anchor part (Positioner
  accepts an `anchor` prop instead); repo-wide grep found zero consumers.
- `packages/ui/components/SearchableSelect.tsx` (consumer sweep) —
  `Trigger asChild>{renderTrigger(...)}` → `Trigger render={renderTrigger(...)}`;
  `renderTrigger` return type narrowed `ReactNode` → `ReactElement` (render
  prop requires an element; the only consumer, review-editor PRSelector,
  already returns a `<button>`);
  `onOpenAutoFocus={preventDefault + focus input}` → `initialFocus={inputRef}`
  (identical intent, declarative).
- `packages/editor/components/AnnotateAgentTerminalPanel.tsx` (consumer sweep)
  — `PopoverTrigger asChild` → `render` with icon child hoisted;
  `data-[state=open]:*` trigger classes → `data-[popup-open]:*`.

Leftover scan clean on all three files (`radix-ui|@radix-ui|asChild`): no matches.

## Left alone

- `CommentPopover.tsx` — despite the name, positions itself against an
  `anchorEl` with plain DOM math; no Radix. Untouched.
- `review-editor`'s 7 direct `@radix-ui/react-popover` imports — sibling
  agent's scope.

## Behavior changes

- Published API: `PopoverAnchor` export removed; `onOpenAutoFocus`/
  `onCloseAutoFocus`/`onInteractOutside`-style Content callbacks are gone
  (Base UI: `initialFocus`/`finalFocus` on the popup, dismissal reasons via
  Root `onOpenChange` eventDetails). `asChild` → `render` on the trigger.
  HANDOFF items.
- Base UI Popover Root `onOpenChange` passes eventDetails as 2nd arg —
  existing single-arg handlers (SearchableSelect) unaffected.
- Collision defaults differ slightly (collisionPadding 0 → 5); visually
  benign, popovers hug viewport edges 5px sooner.

## Verify by hand

- PR selector (review app header): click → popover opens with search input
  FOCUSED, typing filters, ArrowUp/Down + Enter select, Escape closes and
  returns focus to trigger.
- Terminal display settings (annotate agent terminal): gear opens the panel,
  gear gets the active tint while open, click-outside closes.

## Post-QA polish (2026-07-07, second pass)

- Exit + enter now transition-based: the `.popover-enter` mount keyframe (which
  was only defined in review-editor's CSS — plan-app popovers had NO enter
  animation) is replaced by `data-[starting-style]`/`data-[ending-style]`
  opacity/scale at 150ms ease-out, matching the review-editor migration and the
  shadcn base registry. Popovers now animate identically in both apps.
- `prefers-reduced-motion: reduce` support added in `theme.css` for ALL Base UI
  popups (dialog/menu/popover/tooltip, both apps): transitions zeroed during the
  starting/ending phases → instant open/close; Base UI unmounts immediately when
  no transition runs. Also covers the review-editor `.popover-enter` keyframe.
