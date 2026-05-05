---
id: TASK-S-1
trackerStatus:
  type: task
title: S-1 Strip remote collaboration surface area
description: Remove the remote-collaboration surface area so the daemon refactor can
  target a smaller local-only tree.
successCriteria:
- Remote/share surface directories, utilities, and UI affordances targeted by this task are removed from the active repo tree.
- Build scripts, workspace entries, imports, and package references no longer depend on the removed remote/share paths.
- Documentation reflects the local-only tree and no longer describes deleted sharing flows.
- The targeted proof for [[TASK-TDD-S-1]] passes without weakening the accepted test surface.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2
status: needs-review
parents:
- '[[PHASE-2]]'
dependsOn:
- '[[TASK-TDD-S-1]]'
---

## Subtasks
- Delete the directories and files marked out-of-scope in the sprint plan, including marketing, paste-service, portal if present, share-url paths, sharing utilities/hooks, and Pi-extension if that deletion decision is taken in-sprint.
- Remove imports, build scripts, workspace entries, and package references tied to those deleted paths.
- Remove Share UI and share-related client state from the plan and review editors.
- Remove share-payload serialization and hash-load logic from `packages/ui/`.
- Update `README.md`, `CLAUDE.md`, and `AGENTS.md` to reflect the deletions.
- Run the build matrix as a checkpoint and do not proceed until the trimmed tree is clean.

Dependency notes:
- This should land before the rest of the refactor because it reduces the number of codepaths the daemon must preserve.
## Comments

### Comment (2026-04-29T08:21:44.280Z)

Delegated S-1 implementation to child session `887ddd9f-5710-4cbc-b25a-0651d07a13d2` (`gpt-5.4`) in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/mellow-comet`.

Handoff included:
- full [[TASK-S-1]] tracker specification
- [[TASK-S-9.5]] TDD constraints
- [[TASK-TDD-S-1]] proof context and commit `f8820d2`
- explicit instruction not to modify the accepted proof file
- required verification: `bun test tests/nim-13.remote-surface-proof.test.ts` and surviving local build path

### Comment (2026-04-29T09:05:43.407Z)

Accepted delegated S-1 implementation and integrated it into `main` as commit `cf1c790` (`refactor: remove remote collaboration surface`).

Final acceptance phase:
- `bun install`
- `bun test tests/nim-13.remote-surface-proof.test.ts`
- result: 4 pass, 0 fail

Outcome:
- remote/share surface removed from the repo tree
- top-level scripts and docs cleaned
- surviving local build path remains green
- built local UIs no longer ship the deleted sharing affordances

Task is ready for the next dependent proof task ([[TASK-TDD-S-2]]).

## Activity Log

- 2026-04-29T02:29:35.708Z: created
- 2026-04-29T03:11:38.984Z: updated (complexityScore) -> 58
- 2026-04-29T08:21:44.087Z: status_changed (status) -> in-progress
- 2026-04-29T08:21:44.087Z: updated (owner) -> child-session:887ddd9f-5710-4cbc-b25a-0651d07a13d2 (gpt-5.4)
- 2026-04-29T08:21:44.087Z: updated (progress) -> 1
- 2026-04-29T08:21:44.280Z: commented
- 2026-04-29T09:05:43.223Z: status_changed (status) -> needs-review
- 2026-04-29T09:05:43.223Z: updated (progress) -> 100
- 2026-04-29T09:05:43.408Z: commented
