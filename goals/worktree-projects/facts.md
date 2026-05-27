# Worktree-Aware Project Hierarchy — Facts

## Auto-Detection

- When a user adds a directory that is a git worktree, the daemon auto-detects the parent repo using `git rev-parse --git-common-dir`.
- The parent repo becomes a top-level project entry if it doesn't already exist.
- The added worktree directory nests under the parent project automatically.
- Adding a regular repo (not a worktree) works the same as today — it becomes a top-level project.

## Data Model

- `DaemonProjectEntry` gains an optional `parentCwd` field. Worktree entries have `parentCwd` set to the parent repo's cwd. Regular projects leave it unset.
- The on-disk format (`~/.plannotator/projects.json`) stays a flat array. The tree structure is resolved at query time, not stored.
- A new optional `branch` field on `DaemonProjectEntry` stores the worktree's checked-out branch name for display.

## Worktree Listing

- Expanding a project node in the UI triggers a `git worktree list` call via a daemon API endpoint.
- Worktree data is fetched on demand, not cached or polled. Each expand gets fresh data.
- The daemon returns worktrees as an array of `{ path, branch, head }` using the existing `WorktreeInfo` type from `packages/shared/review-core.ts`.

## Landing Page UI

- The project table on the landing page shows projects as collapsible tree nodes.
- Projects with worktrees display a chevron/expand control.
- Clicking the chevron expands the node and shows worktrees indented underneath, each with its branch name and path.
- Both parent projects and worktree entries are selectable for launching sessions (Code Review, Browse Archive).
- Selecting a worktree entry passes its `cwd` (the worktree path) to the session creation API.
- Projects without worktrees display the same as today — a flat row with no expand control.
- Collapsed by default.

## Sidebar

- The sidebar continues to show only sessions, not projects. No change to sidebar project display.
- Sessions created from a worktree cwd show the branch name in their sidebar label for context.

## Actions

- All session actions (Code Review, Browse Archive, Plan, Annotate) work identically on both parent projects and worktree entries.
- The only difference is the `cwd` passed to the daemon — the parent repo path or the worktree path.

## Out of Scope

- Worktree creation or deletion from the UI. Users manage worktrees via git CLI.
- Sidebar project hierarchy. Projects stay landing-page-only.
- Automatic worktree scanning in the background or on a timer.
- Worktree-specific session grouping in the sidebar (sessions group by mode, not by worktree).
