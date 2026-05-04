---
id: NIM-15
trackerStatus:
  type: task
title: TDD for S-3 multiplexed router behavior
status: needs-review
priority: high
owner: child-session:f86c2767-9f6e-4100-9769-417960ff8426 (gpt-5.4)
tags:
- plannotator
- daemon-refactor
- sprint
- tdd
- router
- validation
progress: 100
parents:
- "[[PHASE-2]]"
---

## Description

Parent phase: Phase 2 (Slice TDD + implementation). 
Write the proof cases for the multiplexed daemon router before implementation completion.

Requirements:
- Use real server startup, real HTTP requests, real mode mismatches, and real bundled UI entry behavior.
- Prove endpoint routing, 409 behavior, mode-sensitive responses, and removal of shutdown assumptions.
- Validate real browser-facing paths, not just internal handler composition.

Process rule:
- This proof task must be authored separately from implementation, and [[NIM-4]] writers may not weaken or rewrite the tests after handoff.

## Comments

### Comment (2026-04-30T16:18:48.738Z)

Delegated [[NIM-15]] proof authoring to child session `f86c2767-9f6e-4100-9769-417960ff8426` (`gpt-5.4`) in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/wild-nebula`.

Handoff included:
- full [[NIM-15]] tracker specification
- [[NIM-12]] TDD constraints
- [[NIM-4]] target implementation context
- explicit instruction not to implement the router itself
- required verification via direct `bun test ...` on the new proof file

### Comment (2026-04-30T16:26:02.235Z)

Accepted delegated [[NIM-15]] proof authoring and integrated it into `main` as commit `39b000a` (`test: author [[NIM-15]] multiplexed router proof`).

Final acceptance phase:
- `bun test tests/nim-15.multiplexed-router-proof.test.ts`
- result: 1 intentional red failure
- failure is the expected missing implementation signal: `packages/server/daemon-router.ts` does not yet exist

Outcome:
- pre-[[NIM-4]] red state is now high-signal and controlled
- ready for implementation task [[NIM-4]]

## Activity Log

- 2026-04-29T04:14:39.054Z: created
- 2026-04-30T16:18:48.550Z: status_changed (status) -> in-progress
- 2026-04-30T16:18:48.550Z: updated (owner) -> child-session:f86c2767-9f6e-4100-9769-417960ff8426 (gpt-5.4)
- 2026-04-30T16:18:48.550Z: updated (progress) -> 1
- 2026-04-30T16:18:48.738Z: commented
- 2026-04-30T16:26:02.058Z: status_changed (status) -> needs-review
- 2026-04-30T16:26:02.058Z: updated (progress) -> 100
- 2026-04-30T16:26:02.235Z: commented
