---
id: TASK-TDD-S-3
trackerStatus:
  type: task
title: TDD for S-3 multiplexed router behavior
description: Write the proof cases for the multiplexed daemon router before implementation
  completion.
successCriteria:
- Proof cases cover real server startup, HTTP routing, mode mismatch handling, and browser-facing bundle entry behavior.
- The proof locks down 409 behavior, mode-sensitive responses, and the removal of shutdown assumptions from the routed surface.
- The proof exposes the missing multiplexed router surface before [[TASK-S-3]] and remains the acceptance gate afterward.
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
- Use real server startup, real HTTP requests, real mode mismatches, and real bundled UI entry behavior.
- Prove endpoint routing, 409 behavior, mode-sensitive responses, and removal of shutdown assumptions.
- Validate real browser-facing paths, not just internal handler composition.

Process rule:
- This proof task must be authored separately from implementation, and [[TASK-S-3]] writers may not weaken or rewrite the tests after handoff.
## Comments

### Comment (2026-04-30T16:18:48.738Z)

Delegated [[TASK-TDD-S-3]] proof authoring to child session `f86c2767-9f6e-4100-9769-417960ff8426` (`gpt-5.4`) in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/wild-nebula`.

Handoff included:
- full [[TASK-TDD-S-3]] tracker specification
- [[TASK-S-9.5]] TDD constraints
- [[TASK-S-3]] target implementation context
- explicit instruction not to implement the router itself
- required verification via direct `bun test ...` on the new proof file

### Comment (2026-04-30T16:26:02.235Z)

Accepted delegated [[TASK-TDD-S-3]] proof authoring and integrated it into `main` as commit `39b000a` (`test: author [[TASK-TDD-S-3]] multiplexed router proof`).

Final acceptance phase:
- `bun test tests/nim-15.multiplexed-router-proof.test.ts`
- result: 1 intentional red failure
- failure is the expected missing implementation signal: `packages/server/daemon-router.ts` does not yet exist

Outcome:
- pre-[[TASK-S-3]] red state is now high-signal and controlled
- ready for implementation task [[TASK-S-3]]

## Activity Log

- 2026-04-29T04:14:39.054Z: created
- 2026-04-30T16:18:48.550Z: status_changed (status) -> in-progress
- 2026-04-30T16:18:48.550Z: updated (owner) -> child-session:f86c2767-9f6e-4100-9769-417960ff8426 (gpt-5.4)
- 2026-04-30T16:18:48.550Z: updated (progress) -> 1
- 2026-04-30T16:18:48.738Z: commented
- 2026-04-30T16:26:02.058Z: status_changed (status) -> needs-review
- 2026-04-30T16:26:02.058Z: updated (progress) -> 100
- 2026-04-30T16:26:02.235Z: commented
