---
id: NIM-13
trackerStatus:
  type: task
title: TDD for S-1 remote-surface deletion and build invariants
status: needs-review
priority: high
owner: child-session:f6eebc74-f5d8-4ce9-a41c-c7cb628feb17 (gpt-5.4)
tags:
- plannotator
- daemon-refactor
- sprint
- tdd
- e2e
- validation
progress: 100
parents:
- [[PHASE-2]]
---

## Description

Parent phase: Phase 2 (Slice TDD + implementation). 
Write the proof cases for the remote-surface deletion task before implementation completion.

Requirements:
- No mocks or fake substitute data.
- Use real repo state, real build commands, and real user-visible affordances.
- Prove that share-related UI, sharing paths, and remote-only surfaces are actually gone.
- Prove that the trimmed tree still builds and the remaining local-only flows still work.

Process rule:
- This proof task must be authored separately from implementation, and [[NIM-2]] writers may not weaken or rewrite the tests after handoff.

## Comments

### Comment (2026-04-29T06:08:47.311Z)

Accepted delegated proof authoring output and integrated it into `main` as commit `f8820d2` (`test: add [[NIM-13]] remote surface proof`).

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
