---
id: TASK-TDD-S-5
trackerStatus:
  type: task
title: TDD for S-5 submit/wait/verdict semantics
description: Write the proof cases for submit, wait, buffered verdicts, and clear
  semantics before implementation completion.
successCriteria:
- Proof cases cover real submit, wait, buffered verdict, disconnect, and clear behavior through the daemon-facing surface.
- Singleton rejection, verdict delivery, disconnect handling, and force-clear behavior are asserted as user-visible semantics.
- The proof exposes the missing daemon-owned submit/wait/clear surface before [[TASK-S-5]] and remains the acceptance gate afterward.
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
- Use real daemon HTTP endpoints, real SSE clients, real disconnects, and real buffered recovery flows.
- Prove singleton submission rejection, verdict delivery, disconnect handling, and force-clear behavior with real commands.
- Focus on externally visible semantics, not just internal event-bus consistency.

Process rule:
- This proof task must be authored separately from implementation, and [[TASK-S-5]] writers may not weaken or rewrite the tests after handoff.
## Comments

### Comment (2026-04-30T23:50:34.187Z)

Delegating [[TASK-TDD-S-5]] proof authoring after accepting [[TASK-S-4]] commit `7abdda4` and checkpointing `main` at `989843a`. Verification target for the proof task is `bun test tests/nim-17.submit-wait-proof.test.ts`.

### Comment (2026-05-01T00:00:01.974Z)

Accepted child proof commit `48ec43a` and integrated it into `main`. Verifying in `main` with `bun test tests/nim-17.submit-wait-proof.test.ts`; expected red phase is the missing daemon-owned `/api/submit`/`/api/wait`/`/api/clear` surface for [[TASK-S-5]].

## Activity Log

- 2026-04-29T04:14:51.167Z: created
- 2026-04-30T23:50:33.967Z: status_changed (status) -> in-progress
- 2026-04-30T23:50:33.967Z: updated (progress) -> 1
- 2026-04-30T23:50:34.187Z: commented
- 2026-04-30T23:50:40.274Z: status_changed (status) -> in-progress
- 2026-04-30T23:50:40.274Z: updated (owner) -> child-session:4c609eeb-a84a-47c9-b27b-3b57f7d81cf2 (gpt-5.4)
- 2026-04-30T23:50:40.274Z: updated (progress) -> 1
- 2026-05-01T00:00:01.756Z: status_changed (status) -> needs-review
- 2026-05-01T00:00:01.756Z: updated (progress) -> 100
- 2026-05-01T00:00:01.974Z: commented
