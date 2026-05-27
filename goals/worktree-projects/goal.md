# Worktree-Aware Project Hierarchy

Make the project list understand git worktree relationships. Directories that are worktrees auto-detect their parent repo and nest underneath it. Projects with worktrees show them as expandable branches. Users can launch sessions scoped to any worktree.

## Shared Understanding

See `facts.md` for the approved fact sheet.

## Execution Plan

See `plan.md`.

## Done Condition

- Adding a worktree directory auto-detects parent and creates hierarchy
- Expanding a project shows its worktrees with branch names
- Sessions can be launched from any worktree entry
- Session sidebar labels include branch name for worktree sessions
- Typecheck and tests pass
