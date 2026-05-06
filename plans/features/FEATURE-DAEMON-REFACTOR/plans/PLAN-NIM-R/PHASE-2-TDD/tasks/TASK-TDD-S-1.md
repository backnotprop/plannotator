---
id: TASK-TDD-S-1
trackerStatus:
  type: task
title: TDD for S-1 remote-surface deletion and build invariants
description: Write the proof cases for the remote-surface deletion task before implementation
  completion.
successCriteria:
- Proof cases demonstrate that remote/share UI, paths, and repo surfaces targeted by [[TASK-S-1]] are actually absent.
- Proof cases use real repo state and real build behavior rather than mock-only deletion checks.
- The proof fails for the intended pre-deletion violations and stays authoritative for later implementation acceptance.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2-TDD
status: complete
parents:
- '[[PHASE-2-TDD]]'
---

## Description
Requirements:
- No mocks or fake substitute data.
- Use real repo state, real build commands, and real user-visible affordances.
- Prove that share-related UI, sharing paths, and remote-only surfaces are actually gone.
- Prove that the trimmed tree still builds and the remaining local-only flows still work.

Process rule:
- This proof task must be authored separately from implementation, and [[TASK-S-1]] writers may not weaken or rewrite the tests after handoff.
## Comments

### Comment (2026-04-29T06:08:47.311Z)

Accepted delegated proof authoring output and integrated it into `main` as commit `f8820d2` (`test: add [[TASK-TDD-S-1]] remote surface proof`).

Review result:
- proof now fails fast for the intended S-1 repo-state violations
- build-backed checks no longer stall; they defer until the deletion phases are clean
- no generated build artifacts were accepted as part of the deliverable

This task is now ready for S-1 implementation to drive the proof green.

## Activity Log

- 2026-04-29T04:14:25.663Z: created
- 2026-04-29T04:24:52.365Z: status_changed (status) -> in-progress
- 2026-04-29T04:24:52.365Z: updated (owner) -> Beauvoir (gpt-5.4/high)
- 2026-04-29T04:30:04.905Z: status_changed (status) -> in-progress
- 2026-04-29T04:30:04.905Z: updated (owner) -> Maxwell (gpt-5.4/high)
- 2026-04-29T05:02:43.530Z: status_changed (status) -> in-progress
- 2026-04-29T05:02:43.530Z: updated (owner) -> Aristotle (gpt-5.4/high)
- 2026-04-29T05:27:12.444Z: status_changed (status) -> in-progress
- 2026-04-29T05:27:12.444Z: updated (owner) -> child-session:f6eebc74-f5d8-4ce9-a41c-c7cb628feb17 (gpt-5.4)
- 2026-04-29T06:08:47.145Z: status_changed (status) -> needs-review
- 2026-04-29T06:08:47.145Z: updated (progress) -> 100
- 2026-04-29T06:08:47.311Z: commented
