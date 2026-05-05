---
id: TASK-S-5
trackerStatus:
  type: task
title: S-5 Add submit, wait, state, and clear daemon endpoints
description: Implement the daemon-facing submission and blocking primitives.
successCriteria:
- The daemon exposes submit, wait, state, and clear endpoints that enforce singleton review state through the accepted contract.
- Verdict consumption and interrupted-delivery behavior follow one explicit rule rather than ad hoc event-bus behavior.
- CLI and wrapper callers can introspect daemon state and recover from clear or disconnect paths through the daemon endpoints.
- The targeted proof for [[TASK-TDD-S-5]] passes without weakening the accepted submit/wait/clear semantics.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2
status: needs-review
parents:
- '[[PHASE-2]]'
dependsOn:
- '[[TASK-S-3]]'
- '[[TASK-S-4]]'
- '[[TASK-TDD-S-5]]'
---

## Subtasks
- Add `POST /api/submit` with singleton-state enforcement, history persistence, and browser open behavior.
- Add `GET /api/wait` as the SSE-based blocking primitive for agents.
- Implement verdict consumption rules so successful delivery transitions `verdict_ready -> idle` while interrupted delivery preserves the verdict.
- Add `GET /api/state` for CLI introspection.
- Add `POST /api/clear` with explicit confirmation semantics.

Why it matters:
- This is the keystone agent flow. Once submit and wait are correct, the rest of the CLI and integration work is mostly plumbing.
## Comments

### Comment (2026-05-01T00:00:28.593Z)

Delegated [[TASK-S-5]] after accepting [[TASK-TDD-S-5]] proof commit `edd9ac3` and checkpointing `main` at `f0fad5b`. Verification target for this implementation is `bun test tests/nim-17.submit-wait-proof.test.ts`.

### Comment (2026-05-01T00:10:22.016Z)

Accepted child implementation commit `59dd78c` and integrated it into `main`. Verification in `main` is running against `bun test tests/nim-17.submit-wait-proof.test.ts`.

## Activity Log

- 2026-04-29T02:30:00.877Z: created
- 2026-04-29T03:11:51.201Z: updated (complexityScore) -> 94
- 2026-05-01T00:00:20.242Z: status_changed (status) -> in-progress
- 2026-05-01T00:00:20.242Z: updated (progress) -> 1
- 2026-05-01T00:00:28.309Z: status_changed (status) -> in-progress
- 2026-05-01T00:00:28.309Z: updated (owner) -> child-session:c4202a9a-4139-4547-a980-45b435e618d3 (gpt-5.4)
- 2026-05-01T00:00:28.309Z: updated (progress) -> 1
- 2026-05-01T00:00:28.593Z: commented
- 2026-05-01T00:10:21.870Z: status_changed (status) -> needs-review
- 2026-05-01T00:10:21.870Z: updated (progress) -> 100
- 2026-05-01T00:10:22.016Z: commented
