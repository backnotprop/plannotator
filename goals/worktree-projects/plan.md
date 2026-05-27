# Worktree-Aware Project Hierarchy — Plan

## Approach

Extend the project registry data model with `parentCwd` and `branch` fields. When a directory is added, detect if it's a worktree and auto-discover the parent repo. Add a daemon endpoint to list worktrees for a project. Update the landing page to render projects as collapsible tree nodes with worktrees nested underneath. Add branch names to session labels for worktree-scoped sessions.

## Steps

1. Extend `DaemonProjectEntry` type with optional `parentCwd` and `branch`
2. Add worktree detection to `registerProject` / `addProject`
3. Add `GET /daemon/projects/worktrees?cwd=` endpoint
4. Add `listWorktrees` to frontend API client
5. Refactor `ProjectTable` to collapsible tree with worktree children
6. Add branch name to session labels for worktree cwds

## Verification

- Add a worktree directory → parent auto-detected, nests correctly
- Expand project → worktrees listed with branch names
- Select worktree → launch code review scoped to that path
- Session label shows branch name
- Typecheck + tests pass
