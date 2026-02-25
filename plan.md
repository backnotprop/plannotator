# Feature: "Open in VS Code Diff" Button

## Overview

Add a button to the PlanDiffViewer toolbar that opens the current plan diff in VS Code's native side-by-side diff viewer. When clicked, the server writes both versions (base and current) to temp files and invokes `code --diff <old> <new>`.

## Context

The PlanDiffViewer already shows diffs in two modes (rendered + raw). Adding a VS Code diff option gives power users access to VS Code's mature diff features: inline editing, word-level highlighting, minimap, search, etc.

## Changes

### 1. New server endpoint: `POST /api/plan/vscode-diff`

**File:** `packages/server/index.ts`

Add a new endpoint that:
- Accepts `{ basePlan: string, currentPlan: string, baseVersion: number }` in the request body
- Writes both plans to temp files in `/tmp/plannotator/`:
  - `/tmp/plannotator/plan-v{N}.md` (base version)
  - `/tmp/plannotator/plan-current.md` (current version)
- Spawns `code --diff <old-path> <new-path>` via `Bun.spawn()`
- Returns `{ ok: true }` on success, or `{ error: string }` on failure
- If `code` CLI isn't found, returns a 400 with a helpful error message suggesting `Shell Command: Install 'code' command in PATH`

The endpoint reuses the existing `UPLOAD_DIR` (`/tmp/plannotator/`) directory pattern already used for image uploads.

### 2. UI button in PlanDiffViewer toolbar

**File:** `packages/ui/components/plan-diff/PlanDiffViewer.tsx`

Add a "VS Code" button in the diff mode switcher row (next to `PlanDiffModeSwitcher` and the version label). The button:
- Has the VS Code icon (simple inline SVG) and text "VS Code" (hidden on mobile, icon-only)
- Calls `POST /api/plan/vscode-diff` with the base plan + current plan
- Shows a brief loading state while the request is in flight
- On error, displays a toast/inline message

**File:** `packages/ui/components/plan-diff/PlanDiffViewer.tsx` (props update)

New props needed:
- `currentPlan: string` — the current plan markdown
- `basePlan: string` — the base version markdown
- `baseVersion: number` — the base version number (for temp file naming)

These are already available in the parent (`App.tsx`) via the `usePlanDiff` hook (`planDiff.diffBasePlan`, `markdown`, `planDiff.diffBaseVersion`).

### 3. Wire up in App.tsx

**File:** `packages/editor/App.tsx`

Pass the three new props to `PlanDiffViewer`:
```tsx
<PlanDiffViewer
  // ...existing props
  currentPlan={markdown}
  basePlan={planDiff.diffBasePlan!}
  baseVersion={planDiff.diffBaseVersion!}
/>
```

### 4. Build and verify

Run `bun run build:hook` to bundle the updated UI into the single-file HTML served by the hook server.

## Design Decisions

1. **Server-side `code --diff` invocation:** The UI runs in a browser but needs to execute a shell command. The Bun server already has full system access (it opens the browser, reads files, etc.), so adding a shell spawn is consistent with the architecture.

2. **Temp files instead of piping:** VS Code `--diff` requires two file paths. Temp files in `/tmp/plannotator/` are the simplest approach and align with the existing image upload pattern. Files are overwritten on each click (no accumulation).

3. **No new dependencies:** Uses `Bun.spawn()` for process execution and existing temp directory patterns. No new npm packages needed.

4. **Graceful degradation:** If VS Code CLI isn't available, the error message tells the user how to install it. The button is always visible (not feature-detected) since the server environment may differ from what the browser can detect.

## Files Modified

| File | Change |
|------|--------|
| `packages/server/index.ts` | Add `POST /api/plan/vscode-diff` endpoint |
| `packages/ui/components/plan-diff/PlanDiffViewer.tsx` | Add VS Code button, new props |
| `packages/editor/App.tsx` | Pass new props to PlanDiffViewer |

## Out of Scope

- Opening in other editors (Cursor, Zed, etc.) — could be a follow-up with `PLANNOTATOR_EDITOR` env var
- Detecting whether VS Code is installed before showing the button
- Adding this to the code review diff viewer (`review-editor`) — separate feature
