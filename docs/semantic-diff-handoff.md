# Semantic Diff Handoff

PR: https://github.com/backnotprop/plannotator/pull/871

Branch: `feat/sem-diff`

## What Was Built

This PR adds a semantic diff overview to the code review UI. Instead of starting reviewers in a raw file list, Plannotator can now show a compact entity-level overview like:

```txt
packages/ui/components/Settings.tsx
  added function isBuiltInFont
  modified function ReviewDisplayTab
```

The view is backed by the Ataraxy `sem` CLI. Plannotator sends the active review patch to `sem diff --patch --format json`, receives structured JSON, then renders grouped semantic rows in a Dockview panel.

The semantic diff panel is intended to be the default landing view when sem is available. The existing `All files` panel remains available directly underneath it in the file tree.

## Main User Flow

1. The review server creates or updates `currentPatch`.
2. The server chooses a semantic diff cwd:
   - workspace root for workspace reviews
   - PR worktree/local checkout if present
   - local Git/JJ repo cwd when available
   - neutral scratch directory for patch-only reviews
3. The server runs `sem diff --patch --format json` with `currentPatch` on stdin.
4. The server parses sem JSON into `SemanticDiffResponse`.
5. The UI fetches `/api/semantic-diff`.
6. The semantic panel renders file groups and entity rows.
7. Clicking a semantic row opens the existing diff file view and selects the relevant line range.

The important architectural rule is:

```txt
review mode -> currentPatch -> sem diff --patch -> semantic overview UI
```

Local code improves cwd/blob resolution, but patch-only mode still works from hunk content.

## How It Was Built

### Shared Sem Runner

Source:

- `packages/shared/semantic-diff.ts`
- `packages/shared/semantic-diff-types.ts`
- `packages/shared/semantic-diff.test.ts`

Responsibilities:

- Resolve the sem binary.
- Prefer `PLANNOTATOR_SEM_PATH` when explicitly configured.
- Prefer the managed Plannotator sidecar under the user data dir.
- Fall back to PATH only after managed sem.
- Avoid executing repo-local sem packages from reviewed code.
- On Windows, do not spawn bare `sem`; require an absolute resolved `sem.exe`, managed sem, or explicit env path.
- Run `sem diff --patch --format json`.
- Normalize optional `fileExt` and `fileExts` query filters.
- Parse sem JSON into stable Plannotator response types.
- Cache responses by patch, cwd, and file extension filter.

### Bun Review Server

Source:

- `packages/server/review.ts`
- `packages/server/review-workspace.test.ts`

Responsibilities:

- Advertise semantic diff availability in `/api/diff` and diff-switch responses.
- Serve parsed semantic diff from `GET /api/semantic-diff`.
- Track the active `currentPatch`.
- Resolve semantic cwd independently from agent cwd.
- Cache sem availability per cwd.
- Cache semantic diff results for the active patch.

### Pi/Node Review Server Mirror

Source:

- `apps/pi-extension/server/serverReview.ts`
- `apps/pi-extension/server.test.ts`
- `apps/pi-extension/vendor.sh`

Responsibilities:

- Mirror the Bun server semantic diff behavior.
- Vendor shared semantic diff modules into `apps/pi-extension/generated/`.
- Keep route parity for `/api/semantic-diff`.

### GitHub and GitLab PR Inputs

GitHub source:

- `packages/shared/pr-github.ts`

GitLab source:

- `packages/shared/pr-gitlab.ts`
- `packages/shared/pr-gitlab.test.ts`

Important GitLab note:

- GitLab now uses `raw_diffs`, not reconstructed JSON diffs.
- This preserves collapsed/generated file content and binary diff markers.
- Public GitLab fixture testing showed JSON reconstruction missed binary changes and could omit collapsed generated files.

## Frontend Asset Map

### Review App Entrypoints

- `apps/review/index.html`
- `apps/review/index.tsx`
- `apps/review/vite.config.ts`
- `apps/review/dist/index.html` after build

The review app imports the review editor package and builds a single-file review UI.

### Hook App Bundled Review HTML

- `apps/hook/index.html`
- `apps/hook/index.tsx`
- `apps/hook/vite.config.ts`
- `apps/hook/dist/review.html` after build

`apps/hook/dist/review.html` is the bundled review editor HTML copied from the review build during hook build.

### Main Review UI Wiring

- `packages/review-editor/App.tsx`

Key responsibilities:

- Tracks `semanticDiffAvailable`.
- Opens semantic diff as the initial default panel when advertised.
- Falls back to `All files` if initial semantic load errors.
- Applies semantic diff availability updates after diff switches and PR switches.
- Passes semantic diff state and handlers through `ReviewStateContext`.

### Semantic Diff Panel

- `packages/review-editor/dock/panels/ReviewSemanticDiffPanel.tsx`

Key responsibilities:

- Fetches `GET /api/semantic-diff`.
- Handles loading, empty, error, unavailable, and ready states.
- Groups semantic changes by file path.
- Renders the terminal-like semantic diff rows.
- Opens the existing diff file panel when a row is clicked.
- Converts semantic line metadata into Plannotator line selection.

### Dockview Registration

- `packages/review-editor/dock/reviewPanelTypes.ts`
- `packages/review-editor/dock/reviewPanelComponents.ts`
- `packages/review-editor/dock/ReviewStateContext.tsx`

Key responsibilities:

- Defines `REVIEW_PANEL_TYPES.SEMANTIC_DIFF`.
- Defines `REVIEW_SEMANTIC_DIFF_PANEL_ID`.
- Registers `ReviewSemanticDiffPanel` as a Dockview component.
- Exposes semantic diff state and callbacks to panel components.

### Left File Tree Entry

- `packages/review-editor/components/FileTree.tsx`

Key responsibilities:

- Shows the `Semantic diff` navigation entry above `All files`.
- Only shows it when `semanticDiffAvailable` is true.
- Keeps file selection inactive while semantic diff or all-files overview is active.

### PR Switch Hook Type Wiring

- `packages/review-editor/hooks/usePRStack.ts`

Key responsibilities:

- Carries semantic diff advert data through PR scope/switch responses.
- Uses shared `SemanticDiffAdvert` from `@plannotator/shared/semantic-diff-types`.

### Semantic Diff Styles

- `packages/review-editor/index.css`

Relevant CSS block:

- `.semantic-diff-panel`
- `.semantic-diff-terminal`
- `.semantic-diff-file`
- `.semantic-diff-row`
- `.semantic-diff-symbol-*`
- `.semantic-diff-summary`
- `.semantic-diff-retry`
- `.semantic-diff-loading`
- `.semantic-diff-error`
- `.semantic-diff-empty`

The styling intentionally mirrors sem's terminal output shape: file boxes, pipe glyphs, change symbols, entity type, entity name, and status label.

## API Surface

### `GET /api/diff`

Now includes:

```ts
semanticDiff?: {
  available: boolean;
  semVersion?: string;
  semSource?: string;
}
```

### `GET /api/semantic-diff`

Returns one of:

- `SemanticDiffOkResponse`
- `SemanticDiffUnavailableResponse`
- `SemanticDiffErrorResponse`

Optional query filters:

- `?fileExt=.ts`
- `?fileExts=.ts,.tsx`

### Diff Switch and PR Switch Responses

These responses also include the semantic diff advert when available:

- `/api/diff/switch`
- `/api/pr-diff-scope`
- `/api/pr-switch`

## Install And Binary Behavior

Installer changes install sem as an optional sidecar dependency. Semantic diff is non-fatal:

- If sem is available, the semantic diff UI can open.
- If sem is unavailable, Plannotator hides/falls back to the existing all-files diff path.
- If sem errors during initial auto-open, the UI falls back to `All files`.

Relevant installer files:

- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/install.cmd`

Managed sem path:

```txt
<plannotator data dir>/vendor/sem/<version>/sem
<plannotator data dir>/vendor/sem/<version>/sem.exe
```

## Review Modes Covered

### Local Git/JJ

Uses the local repo cwd and active VCS patch.

### Workspace / Multi-Repo

Aggregates child repo patches with workspace-prefixed paths, then runs sem from the workspace root. Sem can fall back to hunk content when child repo blob SHAs are not resolvable from the parent.

### GitHub PR

Uses `gh pr diff` patch text. If local checkout/worktree exists, semantic diff runs from that cwd. Otherwise it runs from scratch.

### GitLab MR

Uses GitLab `raw_diffs` via `glab api`, preserving raw unified patch text and binary markers.

### PR Full-Stack

Requires local checkout/worktree to create the full-stack patch. Once `currentPatch` exists, semantic diff uses the same pipeline.

### Raw / Shared / Patch-Only

Runs sem from a neutral scratch cwd with patch text on stdin.

## Verification Run

Latest local verification after the final hardening pass:

```sh
bun test
# 1357 pass, 0 fail

bunx tsc --noEmit -p packages/shared/tsconfig.json
bunx tsc --noEmit -p packages/server/tsconfig.json
bunx tsc --noEmit -p packages/ui/tsconfig.json
bunx tsc --noEmit -p apps/pi-extension/tsconfig.json

bun run build:pi

git diff --check
```

All passed.

## Useful Public GitLab Fixtures

These were used to validate GitLab patch behavior without running the full app:

- Normal TypeScript: `https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/merge_requests/3226`
- Renamed TypeScript: `https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/merge_requests/3220`
- Rename plus new TypeScript: `https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/merge_requests/3059`
- TS plus Vue: `https://gitlab.com/gitlab-org/gitlab-vscode-extension/-/merge_requests/3176`
- Binary marker: `https://gitlab.com/gitlab-org/gitlab-ui/-/merge_requests/4794`
- Binary add/delete: `https://gitlab.com/gitlab-org/gitlab-ui/-/merge_requests/4448`

## Current Known Tradeoffs

- Workspace semantic diff runs once against the aggregated workspace patch. This is simple and works for normal hunk-backed changes, but a future precision improvement could run sem per child repo and merge/prefix the semantic results.
- Checkout-less PR and raw-patch reviews rely on hunk content rather than local blob resolution. This is expected and still useful.
- Sem language coverage is controlled by sem itself. Unsupported file extensions can still fall back to chunk-style behavior inside sem.

## Final PR State At Handoff

PR:

```txt
https://github.com/backnotprop/plannotator/pull/871
```

Implementation head before this handoff doc was added:

```txt
13d44b02d6cf6c1fd050cbf552bd494f2a729e5a
```
