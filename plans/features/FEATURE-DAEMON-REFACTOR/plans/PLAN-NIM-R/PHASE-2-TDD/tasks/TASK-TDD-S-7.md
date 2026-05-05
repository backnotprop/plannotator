---
id: TASK-TDD-S-7
trackerStatus:
  type: task
title: TDD for S-7 notification behavior
description: Write the proof cases for notification behavior before implementation
  completion.
successCriteria:
- 'Proof cases cover notification firing on `idle -> in_review`, non-firing on verdict transitions, and accepted suppression behavior.'
- The proof uses the closest non-mocked execution path available for notification dispatch in the environment.
- The proof exposes the missing notification surface before [[TASK-S-7]] and remains the acceptance gate afterward.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2-TDD
status: needs-review
parents:
- '[[PHASE-2-TDD]]'
---

## Description
Requirements:
- Use real notification invocation paths on supported platforms or the closest non-mocked execution path available in the environment.
- Prove notification firing on `idle -> in_review`, suppression behavior, and non-firing on verdict transitions.
- Avoid replacing the behavior with fake notification adapters as the primary proof surface.

Process rule:
- This proof task must be authored separately from implementation, and [[TASK-S-7]] writers may not weaken or rewrite the tests after handoff.
## Comments

### Comment (2026-05-01T04:54:50.072Z)

Delegating [[TASK-TDD-S-7]] proof authoring after accepting [[TASK-S-6]] commit `5b18e10` and checkpointing `main` at `5e2ed5d`. Verification target for the proof task is `bun test tests/nim-19.notification-proof.test.ts`.

### Comment (2026-05-01T05:03:54.204Z)

Accepted in `main` as `f41cc95` `test: add [[TASK-TDD-S-7]] notification proof`.

Verification in `main`:
- `bun test tests/nim-19.notification-proof.test.ts`
- result: intentional red phase
- failure: `packages/server/notify.ts` does not exist

This is the expected missing implementation surface for [[TASK-S-7]].

## Activity Log

- 2026-04-29T04:15:12.437Z: created
- 2026-05-01T04:54:49.839Z: status_changed (status) -> in-progress
- 2026-05-01T04:54:49.839Z: updated (progress) -> 1
- 2026-05-01T04:54:50.072Z: commented
- 2026-05-01T04:54:56.579Z: status_changed (status) -> in-progress
- 2026-05-01T04:54:56.579Z: updated (owner) -> child-session:b59b10aa-0635-41d2-aea1-90e95830ca68 (gpt-5.4)
- 2026-05-01T04:54:56.579Z: updated (progress) -> 1
- 2026-05-01T05:03:53.966Z: status_changed (status) -> needs-review
- 2026-05-01T05:03:53.966Z: updated (progress) -> 100
- 2026-05-01T05:03:54.204Z: commented
