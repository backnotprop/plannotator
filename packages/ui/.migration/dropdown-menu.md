# dropdown-menu

2026-07-07, transformation engine. Verdict: DropdownMenu → Base UI Menu with the
canonical Portal>Positioner>Popup restructure; 2 consumers swept in the same
commit; several flagged deltas on the published surface.

## Changed

- `packages/ui/components/ui/dropdown-menu.tsx` — `@radix-ui/react-dropdown-menu`
  → `@base-ui/react/menu`. Every export name preserved.
  - `Content`/`SubContent` → `Portal > Positioner > Popup`; `side`/`sideOffset`/
    `align`/`alignOffset` declared→destructured→forwarded to Positioner (the
    FORWARD rule); Positioner `className="isolate z-50 outline-none"`.
  - `SubContent` gets the load-bearing submenu defaults `align="start"
    alignOffset={-3} side="right" sideOffset={0}` (Radix SubContent implied
    side + start-align).
  - Part renames: `Label` → `GroupLabel`, `ItemIndicator` →
    `CheckboxItemIndicator`/`RadioItemIndicator`, `Sub` → `SubmenuRoot`,
    `SubTrigger` → `SubmenuTrigger`.
  - Class rewrites: `data-[state=open]:animate-in …slide-in-from-*` keyframes →
    `origin-[var(--transform-origin)] transition-[opacity,scale] duration-150`
    + `data-[starting-style]`/`data-[ending-style]` opacity/scale;
    item `focus:bg-accent` → `data-[highlighted]:bg-accent` (Base UI highlight
    model), SubTrigger `data-[state=open]:*` → `data-[popup-open]:*`.
  - Root/Portal/Sub wrappers no longer stamp `data-slot` (Base UI roots render
    no element and reject unknown props).
- `packages/ui/components/OpenInAppButton.tsx` (consumer sweep) —
  `onCloseAutoFocus={e => e.preventDefault()}` → `finalFocus={false}` on
  Content (same intent: don't snap focus back to the trigger);
  `onSelect + preventDefault` → `closeOnClick={false} + onClick` (component
  already closes via its controlled `menuOpen` state);
  `Trigger asChild><button>` → `Trigger render={<button …/>}` with children
  hoisted onto the trigger.
- `packages/editor/components/AnnotateAgentTerminalPanel.tsx` (consumer sweep)
  — `Trigger asChild` → `render`; `onSelect` → `onClick` (default
  `closeOnClick` keeps Radix's close-on-select for plain items);
  `data-[state=open]:*` trigger classes → `data-[popup-open]:*`;
  `min-w-[var(--radix-dropdown-menu-trigger-width)]` →
  `min-w-[var(--anchor-width)]`.

Leftover scan clean on all three files: `grep -n "radix-ui\|@radix-ui"` — no matches.

## Left alone

- `DropdownMenuShortcut` — plain `<span>`, no primitive.
- `packages/review-editor`'s own `@radix-ui/react-dropdown-menu` import
  (DiffTypePicker) — sibling agent's scope.

## Behavior changes

- **Item selection API** (published surface): `onSelect(event)` no longer
  exists — Base UI uses `onClick` + `closeOnClick`. In-repo call sites swept;
  external consumers must rename. HANDOFF item.
- **CheckboxItem/RadioItem no longer close on click by default**
  (`closeOnClick` defaults `false` there, `true` on plain Item — Radix closed
  on select for all). No in-repo call sites use these items; flagged, not
  patched. HANDOFF item.
- **GroupLabel must sit inside a Group** (it wires `aria-labelledby`); Radix
  Label could float freely. No in-repo call sites; HANDOFF item.
- `checked="indeterminate"` no longer valid on CheckboxItem (boolean only).
- Root `loop` prop moved to `loopFocus` and the default flips to looping.
- Enter/exit animation now transition-based (opacity+scale from
  `--transform-origin`); the 2px `slide-in-from-*` nudge of the Radix keyframe
  set is gone — matches the shadcn base registry look.

## Verify by hand

- Plan app header menu + Approve dropdown: open on click, items highlight on
  hover AND arrow keys, Enter activates, Escape closes, focus returns to
  trigger.
- OpenInAppButton (review app file rows): pick an app → menu closes (via
  controlled state) and the app opens; Copy path works; closing the menu does
  NOT paint a focus ring on the chevron (finalFocus={false}).
- Agent terminal panel (annotate mode): agent select opens, popup is at least
  trigger-width, picking an agent closes the menu.
- Typeahead: type a menu item's first letters — highlight jumps.
