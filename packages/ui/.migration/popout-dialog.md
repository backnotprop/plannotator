# popout-dialog (hand-rolled wrapper)

2026-07-07, transformation engine. Verdict: the behavior-heaviest wrapper —
non-modal dialog with a custom backdrop and annotation-UI dismissal guard —
ported with the same public API (`open`/`onClose`/`title`/`container`/
`className`/`dataAttributes` unchanged).

## Changed

- `packages/ui/components/PopoutDialog.tsx` — `@radix-ui/react-dialog` →
  `@base-ui/react/dialog`.
  - `Dialog.Content` → `Dialog.Popup` (centered modal box, no Positioner).
  - `onOpenAutoFocus={(e) => e.preventDefault()}` → `initialFocus={false}`
    (same intent: don't move focus into the popout on open — the annotation
    flow needs the selection/toolbar to keep focus).
  - `onInteractOutside` annotation-selector guard → Root `onOpenChange`
    handler: on `reason === 'outside-press' | 'focus-out'`, if the event
    target is inside `.annotation-toolbar` / `[data-comment-popover]` /
    `[data-floating-picker]`, `eventDetails.cancel()` (the Base UI equivalent
    of the Radix `event.preventDefault()`); otherwise `onClose()`.
  - Custom plain-div backdrop kept verbatim (comment updated: Base UI
    non-modal dialogs render no library backdrop — same reason the Radix
    version used a div, since Radix ignored Overlay when `modal={false}`).
    Its click handler stays as the second dismissal path with the same
    annotation-selector guard.
  - `Dialog.Close asChild><button>…svg…</button>` → `Close render={<button/>}`
    with the SVG hoisted to Close children.
  - `aria-describedby={undefined}` dropped: Base UI only wires describedby
    when a Description part exists.
  - Portal `container` prop: same name/semantics in Base UI.
  Leftover scan clean: `grep -n "radix-ui\|@radix-ui\|asChild"` — no matches.

## Left alone

- Consumers `TablePopout.tsx`, `CodeFilePopout.tsx` — the wrapper's props are
  unchanged; zero edits.

## Behavior changes

- Dismissal is now reason-driven: Radix fired `onInteractOutside` for pointer
  AND focus leaving; Base UI reports `outside-press` / `focus-out` separately
  — both are guarded identically, so observable behavior should match.
  Flagged for hand-verification (below) rather than assumed.
- Base UI Portal renders a wrapper `<div>` around the portal contents (Radix
  rendered none). The backdrop/popup are fixed-position, so layout is
  unaffected; noted for anyone styling via direct-child selectors.

## Verify by hand

- Open a table popout (plan with a wide table → popout icon):
  - Selecting text inside the popout and using the annotation toolbar does
    NOT close the popout (toolbar is portaled outside it).
  - Adding a comment via the comment popover keeps the popout open.
  - Clicking the dark backdrop closes it; Escape closes it; X closes it.
  - On open, focus does NOT jump into the popout (no scroll yank).
- Same pass for a code-file popout (code-file link in a plan).
