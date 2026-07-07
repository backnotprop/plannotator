# @plannotator/ui — Radix → Base UI migration (whole package)

2026-07-07. Strategy: transformation engine (no components.json — hand-vendored
kit + hand-rolled wrappers; no golden-pair CLI available). `@base-ui/react@1.6.0`
(released 2026-06-18, clears the repo's 7-day `minimumReleaseAge` install gate)
installed alongside Radix; Radix packages removed only after the last component.

Reports live in `packages/ui/.migration/` (not repo root): a sibling agent is
migrating `packages/review-editor` in parallel and repo-root reports would
collide.

## Baseline (before any edits, on main @ 070d9a5f + bun.lock fix)

- `bun run typecheck` (incl. `tsconfig.strict-consumer.json` gate): PASS
- `bun test packages/ui`: 338 pass / 43 skip / 0 fail
- `apps/review` vite build: PASS

## Inventory

Radix deps in `packages/ui/package.json` (6):
`@radix-ui/react-dialog`, `react-dropdown-menu`, `react-popover`,
`react-slot`, `react-tabs`, `react-tooltip`.

### (a) shadcn-vendored kit — `components/ui/`

| File | Radix usage | Internal consumers | asChild call sites |
|---|---|---|---|
| `ui/badge.tsx` | Slot | none (published export only) | none |
| `ui/button.tsx` | Slot + Slottable | AnnotationPanel, ToolbarButtons | none |
| `ui/tabs.tsx` | react-tabs | none (published export only) | none |
| `ui/dialog.tsx` | react-dialog | none (published export only) | none |
| `ui/dropdown-menu.tsx` | react-dropdown-menu | OpenInAppButton (ui), AnnotateAgentTerminalPanel (editor) | 1 (editor) |

### (b) hand-rolled wrappers importing Radix directly

| File | Radix usage | Consumers | Notes |
|---|---|---|---|
| `components/Popover.tsx` | react-popover | ui: Viewer, PlanCleanDiffView, CodeFilePopout, GoalSetupSurface, HtmlViewer, SearchableSelect; editor: AnnotateAgentTerminalPanel | exports `PopoverAnchor` (zero consumers; Base UI has no Anchor part) |
| `components/Tooltip.tsx` | react-tooltip | review-editor: App (Provider), FileRowBits, DiffTypePicker; editor: App (Provider) | custom API (`content`/`delayDuration`/`wide`); Provider re-exported raw |
| `components/PopoutDialog.tsx` | react-dialog | ui: TablePopout, CodeFilePopout | non-modal, custom backdrop, `onOpenAutoFocus` preventDefault, `onInteractOutside` annotation-selector guard |

### (c) asChild / Radix-prop touchpoints (consumer sweep surface)

Inside packages/ui:
- `SearchableSelect.tsx:92` — `onOpenAutoFocus` on PopoverContent → `initialFocus`
- `OpenInAppButton.tsx:238` — `onCloseAutoFocus` on DropdownMenuContent → Popup `finalFocus`; 1 `asChild`

Cross-package (all imports of @plannotator/ui wrappers — packages/review-editor's
own `@radix-ui/*` imports are the sibling agent's scope, NOT ours):
- `packages/editor/components/AnnotateAgentTerminalPanel.tsx:440,525` — `DropdownMenuTrigger asChild`, `PopoverTrigger asChild`
- `packages/editor/App.tsx:3808` — `<TooltipProvider delayDuration skipDelayDuration disableHoverableContent>`
- `packages/review-editor/App.tsx:2651` — `<TooltipProvider delayDuration skipDelayDuration>`
- `packages/review-editor/components/FileRowBits.tsx:21`, `DiffTypePicker.tsx:108` — `Tooltip delayDuration` (custom wrapper prop — API kept, no churn)

Strict-consumer gate note: `Viewer.tsx` (gate file) transitively pulls
`Popover.tsx`; the migrated wrappers are type-checked under full strict.

## Migration order (simplest first, one commit each)

1. badge (Slot → useRender + mergeProps)
2. button (Slot/Slottable → `@base-ui/react/button` primitive)
3. tabs (Trigger→Tab, Content→Panel, data-active)
4. dialog (Overlay→Backdrop, Content→Popup, starting/ending-style animations)
5. dropdown-menu → Menu (Portal>Positioner>Popup) + consumer sweep
6. Popover wrapper + consumer sweep (SearchableSelect, editor panel)
7. Tooltip wrapper + provider call-site sweep
8. PopoutDialog (behavior-heaviest: non-modal + outside-interaction guard)
9. OpenInAppButton sweep; remove Radix deps; full builds; HANDOFF/0.23.0

## Final state (after the last commit)

- Dependency swap complete: all 6 `@radix-ui/*` removed from
  `packages/ui/package.json`; `@base-ui/react@1.6.0` (exact pin) added.
  Peer dep `tailwindcss-animate` removed (zero plugin utilities remain in
  package sources; published styles.css rebuilt without it, 187.4 → 186.0 kB).
- App-code sweep: `SearchableSelect`, `OpenInAppButton` (ui) and
  `AnnotateAgentTerminalPanel`, both `App.tsx` TooltipProviders (editor /
  review-editor — providers unchanged by design, wrapper keeps prop names).
- Version bumped to `0.23.0`; publish stays owner-gated. HANDOFF.md gained
  the "UI engine: Base UI (0.23.0)" section (deps, 11 breaking/behavior
  items, what didn't change).
- Final builds vs baseline: monorepo typecheck (incl. strict-consumer gate)
  PASS; full test suite 1955 pass / 0 fail; apps/review + build:hook +
  build:opencode + build:css all PASS.
- Derived remaining-radix count for packages/ui: **0 wrappers remain on
  Radix** (`grep -rn "@radix-ui" packages/ui` → only historical mentions in
  .migration reports).
- Browser smoke (Playwright, real compiled binary from this branch): all 6
  scenarios PASS — plan render, annotate→approve (exercises selection
  toolbar + CommentPopover + Approve button), settings persistence, review
  draft-restore + Send Feedback, editor frontmatter, annotate version diff.
  (05 carries the suite's pre-existing selector-heuristic asterisk.)
  NOT covered by the suite and hand-verified by a human (2026-07-07, branch
  binary installed as `plannotator`): ✅ selection toolbar + comment popover
  in annotate; ✅ table popout — annotating INSIDE the popout keeps it open,
  Escape/backdrop close it; ✅ tooltips (delay, skip-window, non-sticky);
  ✅ OpenInAppButton menu in BOTH annotate (doc badges) and review (file
  header) — hover highlight, app launch, copy actions, clean close, no stray
  focus ring. Note: the "Options" header menu and Approve dropdown are
  hand-rolled (ActionMenu, no Radix/Base UI) and were never in migration
  scope; arrow-key navigation was never a feature there.

## Intentionally untouched

- No cmdk/vaul/sonner/input-otp/react-day-picker/recharts in this package.
- `components/ui/card.tsx`, `state-pill.tsx`, `textarea.tsx`, `core/*`: no Radix.
- `packages/review-editor`'s own Radix imports (checkbox, context-menu,
  popover×7, dropdown-menu): sibling agent's migration.
