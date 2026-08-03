# popover

2026-07-07, transformation engine (7 hand-rolled Radix popover files, no shadcn wrappers). All migrated; typecheck/tests/build green.

## Changed

All files: `import * as Popover from '@radix-ui/react-popover'` → `import { Popover } from '@base-ui/react/popover'`; `Trigger asChild` → `Trigger render={<button …/>}` (trigger children stay as Trigger children); `Portal > Content` → `Portal > Positioner > Popup` with positioning props (`side`, `align`, `sideOffset`) and `z-50`/`z-[100]` moved to Positioner; class rewrites `origin-[var(--radix-popover-content-transform-origin)]` → `origin-[var(--transform-origin)]` and `data-[state=open]:animate-in …` → `transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0`.

- `components/SemanticFileBadge.tsx` — also: `onOpenAutoFocus={(e) => e.preventDefault()}` → `initialFocus={false}` on Popup; hover open/close timers unchanged (kept manual timers rather than Base UI's `openOnHover` to preserve exact behavior); `index.css:480` trigger selector `.semantic-file-badge[data-state="open"]` → `[data-popup-open]`.
- `components/EvoLogPicker.tsx` — plain transform, no focus handling.
- `components/DiffOptionsPopover.tsx` — trigger classes `data-[state=open]:*` → `data-popup-open:*` (Base UI trigger presence attribute).
- `components/WorktreePicker.tsx` — conditional `onOpenAutoFocus` (focus search input only when rendered) → `initialFocus={() => searchRef.current}` (function form: returning an element focuses it; returning null falls back to Base UI's default focus. NOT `?? undefined` — undefined means "do nothing", which would strand focus on the trigger for short lists. Semantics per PopoverPopup.d.ts:44-47 JSDoc, caught in self-review).
- `components/StackedPRLabel.tsx` — plain transform; trigger chevron rotation driven by controlled `open` state, untouched.
- `components/BaseBranchPicker.tsx` — unconditional `onOpenAutoFocus` + manual focus → `initialFocus={() => searchRef.current}` (same null-fallback semantics as WorktreePicker).
- `components/PRCommentsTab.tsx` — trigger `data-[state=open]:*` → `data-popup-open:*`; popup transform as above.

Leftover scan: `grep -rn "radix-ui|@radix-ui" <all 7 files>` → clean. `--radix-*` CSS vars: none remain in these files.

## Left alone

- `.popover-enter` CSS keyframe class (index.css) — mount animation, plays on mount for Base UI popups the same way; kept where used (SemanticFileBadge).
- `@radix-ui/react-popover` stays in package.json until final cleanup.
- Imports from `@plannotator/ui` in DiffTypePicker/DiffOptionsPopover/StackedPRLabel/PRCommentsTab — that package is being migrated in parallel by another agent; its seam is untouched.

## Behavior changes

- **Collision defaults differ**: Base UI `collisionPadding` defaults to 5 (Radix 0/10 depending on prop) and `collisionBoundary` defaults to clipping ancestors (Radix: viewport). Near viewport/scroll-container edges, popovers may flip/shift at slightly different thresholds. Not patched — idiomatic Base UI target.
- **Enter/exit animation idiom changed**: fade now runs via CSS transitions (`data-starting-style`/`data-ending-style`) instead of tw-animate keyframes. Exit fade now actually animates (Radix version unmounted immediately unless forceMount was used); visual difference is a subtle ~150ms fade-out where there was none.
- **`onOpenChange` extra args**: Base UI passes `(open, eventDetails)`; all call sites here pass state setters or `(v) => …` lambdas, which ignore the extra argument. No functional change.

## Verify by hand

1. File header "sem · N" badge: hover opens the semantic popover, moving into the popover keeps it open, leaving both closes after ~140ms; clicking a row navigates and closes; badge highlights while open. ✓ (automated QA vs real session 2026-07-07: hovered `.semantic-file-badge` → `[role="dialog"]` opened and trigger gained `data-popup-open`; moving the pointer into the open dialog kept it visible; moving out closed it in ~157ms and `data-popup-open` was removed from the trigger. Clicking a row to navigate not exercised.)
2. Worktree picker (review header): open with >3 worktrees → search input is focused; with ≤3 → first row focused; arrow keys don't leak to the file tree; Escape closes and returns focus to the trigger. Not testable via automated QA in either the demo (2026-07-07) or a real `bun apps/review/server/index.ts main` session (2026-07-07) — despite this worktree (`feat-review-editor-base-ui`) sitting in a repo with 88 real git worktrees on disk, the trigger never mounts: `apps/review/server/index.ts` never passes `gitContext` to `startReviewServer` (packages/server/review.ts:211), so `App.tsx` never receives `worktrees`/`availableBranches` and `FileTree.tsx:409-410`'s render guard is false. The `>3` vs `≤3` split from the prior QA pass was never reached; the actual blocker is upstream of that split (this entrypoint never sets gitContext at all, not a matter of worktree count). Confirmed empirically: no title-matching trigger in the real session's DOM.
3. Base branch picker: open → search focused immediately; type a SHA → Enter selects; Escape closes. Not testable, same root cause as #2 (`availableBranches` also comes from the unset `gitContext`) — confirmed empirically, no matching trigger in the real session's DOM.
4. Diff options gear: opens aligned right, no layout jump; trigger stays highlighted while open. ✓ (automated QA 2026-07-07: click opens `[role="dialog"]`; trigger carries `data-popup-open` while open; clicking outside closes it. "no layout jump" not measured — feel-level.)
5. Stacked-PR label: popover opens under the label; chevron rotates; switching scope closes it.
6. PR comments Filters button: opens; toggling switches doesn't close the popover; button shows active state while open.
7. All of the above near the bottom/right edge of the window — verify flip/shift feels right (collision defaults changed).
