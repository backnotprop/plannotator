# context-menu

2026-07-07, transformation engine. Core product interaction (file-tree right-click). Typecheck/tests/build green.

## Changed

- `components/FileTreeNode.tsx:2` — `import * as ContextMenu from '@radix-ui/react-context-menu'` → `import { ContextMenu } from '@base-ui/react/context-menu'` (part names verified against `context-menu/index.parts.d.ts`: Base UI re-exports Menu's Positioner/Popup/Item under ContextMenu).
- Trigger `asChild` → `render={<button …/>}`; the file-row button keeps its `onClick` (select file) / `onDoubleClick` handlers — left-click behavior unchanged, right-click opens the menu.
- `Content` → `Portal > Positioner > Popup` (`z-50` on Positioner; no side/align props existed — context menus position at the pointer in both engines); animation classes → `transition-opacity data-starting-style:opacity-0 data-ending-style:opacity-0`.
- Items ×3 (Copy path / Copy filename / Copy full path): `onSelect` → `onClick`; `data-[highlighted]` classes unchanged (same attribute in Base UI).
- Leftover scan: clean.

## Left alone

- `FileRowBits` imports (ViewedControl, StageControl, …) — plain components, no Radix.
- `.file-tree-item` CSS — class-based, element unchanged (still a `<button>` via render).

## Behavior changes

- None identified beyond the shared family notes (collision defaults; exit fade now animates). Items close on click in both engines.

## Verify by hand

1. Right-click a file row → menu opens at the pointer. ✓ (automated QA 2026-07-07: right-click opened `[role="menu"]`; trigger row carries `data-popup-open` while open.)
2. "Copy path" / "Copy filename" / (with a local repo) "Copy full path" put the right strings on the clipboard and close the menu. ✓ (automated QA 2026-07-07: "Copy path" → clipboard read back `src/components/Button.tsx`, menu closed; "Copy filename" → clipboard read back `Button.tsx`. "Copy full path" doesn't render in the demo session — no repoRoot without a local worktree — not exercised.) Re-checked against a real `bun apps/review/server/index.ts main` session in this worktree (2026-07-07): "Copy full path" still does NOT render — right-click menu items were exactly `["Copy path", "Copy filename"]`. Root cause is the same class of gap as dropdown-menu.md/popover.md's not-testable items: `App.tsx`'s `repoRoot` prop (~L3229: `activeWorktreePath ?? agentCwd ?? gitContext?.cwd ?? null`) resolves to `null` because `apps/review/server/index.ts` never passes `gitContext` or `agentCwd` into `startReviewServer` — this is true even in a real, non-demo repo with a real worktree on disk, so "with a local repo" isn't sufficient by itself; the entrypoint has to actually wire local access through. Not exercised (item doesn't exist in this session either).
3. Left-click still selects the file; double-click still opens it; right-click does NOT select the file. ✓ (automated QA 2026-07-07: left-click on a second row made it `.active` with no menu open; right-click left the previously-active file unchanged. Double-click not exercised by automation.)
4. Arrow keys navigate the menu; Enter activates; Escape closes and the file tree keeps keyboard focus. ✓ (automated QA 2026-07-07: Escape closed the menu — confirmed. Arrow-key navigation / Enter-to-activate inside this menu not exercised by automation.)
5. Right-click near the window bottom — menu flips above the pointer.
6. Open menu, left-click elsewhere — menu closes without selecting that row.
