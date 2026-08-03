# project — packages/review-editor Radix → Base UI

2026-07-07, whole-package migration (internal package, no npm consumers). Complete: zero `@radix-ui/*` deps or references remain.

## Dependency swap

- Added: `@base-ui/react ^1.6.0` (dependency), `@types/react` / `@types/react-dom` `^19.2.0` (devDependencies, new — see gates note).
- Removed (7): `@radix-ui/react-checkbox`, `-collapsible`, `-context-menu`, `-dialog`, `-dropdown-menu`, `-popover`, `-tooltip`.
  - **Never imported anywhere: `-collapsible`, `-dialog`, `-tooltip`** — dead dependencies removed without a code change. (The package's dialogs/tooltips come from `@plannotator/ui` or hand-rolled CSS, not from these deps.)
- `bun.lock` regenerated. Note: the committed lock was already stale vs several package.jsons at HEAD (any install rewrites it); the first migration commit absorbed that pre-existing drift.

## Components migrated

| Component | Files | Report |
|---|---|---|
| checkbox | tour/QAChecklist.tsx | checkbox.md |
| popover | SemanticFileBadge, EvoLogPicker, DiffOptionsPopover, WorktreePicker, StackedPRLabel, BaseBranchPicker, PRCommentsTab (+ index.css trigger selector) | popover.md |
| dropdown-menu → Menu | DiffTypePicker.tsx | dropdown-menu.md |
| context-menu | FileTreeNode.tsx | context-menu.md |

## App-code sweep (beyond imports)

- `FileTree.tsx` and `SectionsPanel.tsx`: keyboard-nav guards used `closest('[data-radix-popper-content-wrapper]')` — a Radix portal attribute Base UI never renders. Dead post-migration; removed. Role selectors (`[role="menu"], [role="dialog"], [role="listbox"]`) cover all Base UI popups (Menu.Popup role="menu" — verified; Popover.Popup role="dialog" — verified in PopoverPopup.js:102).
- `--radix-*` CSS vars: all rewritten (`--transform-origin`, `--anchor-width`).
- `data-[state=*]` classes: all rewritten to presence attributes (`data-checked:`, `data-popup-open:`); one plain-CSS selector updated (index.css `.semantic-file-badge[data-state="open"]` → `[data-popup-open]`).

## Gates (all green at final commit)

- Root `bun run typecheck` (includes packages/ui strict-consumer — untouched by this migration and still green).
- `bun test`: 1955 tests, 0 fail.
- `bun run build:review`: green.
- New package-local `tsc -p packages/review-editor/tsconfig.json` (gate added by this migration; the package previously had NO typecheck coverage — it's absent from the root chain and `tsc -p apps/review` is pre-broken for unrelated reasons). 53 pre-existing errors recorded (import.meta.env typing, response-type mismatches) — untouched; zero errors in every migrated file.

## Boundary

`packages/ui` is being migrated in parallel by another agent: not touched (verified via git status), and imports of `@plannotator/ui` from this package (Tooltip in DiffTypePicker, others in DiffOptionsPopover/StackedPRLabel/PRCommentsTab) were left exactly as-is — that seam is the other migration's contract.

**Coordination note for the ui migration**: three call sites here pass Radix-vocabulary props through @plannotator/ui's Tooltip wrapper API — `delayDuration` (FileRowBits.tsx:21, DiffTypePicker.tsx:106) and `delayDuration`/`skipDelayDuration` on TooltipProvider (App.tsx:2651). If the ui package's migration renames its wrapper props (Base UI uses `delay`), these call sites need a one-line consumer sweep; if the wrapper keeps its prop names and maps internally, nothing to do. Check against the ui package's 0.23.0 HANDOFF notes.

## Deliberately left for a human to eyeball

Everything compiles and tests pass, but the four hand-verify checklists (per-component reports) cover feel-level behavior no test asserts: hover-popover timing on the sem badge, focus landing in picker search inputs, file-tree right-click + j/k nav interplay, edge-of-viewport flip behavior under Base UI's different collision defaults, and the new ~150ms exit fades.

Derived status: 0 wrappers/files remain on Radix in packages/review-editor.
