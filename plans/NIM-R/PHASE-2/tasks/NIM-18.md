---
id: NIM-18
trackerStatus:
  type: task
title: TDD for S-6 CLI contract and collision UX
status: needs-review
priority: high
owner: child-session:5aa00d19-2daf-498c-952f-46ef7c0f07e6 (gpt-5.4)
tags:
- plannotator
- daemon-refactor
- sprint
- tdd
- cli
- validation
progress: 100
parents:
- "[[PHASE-2]]"
---

## Description

Parent phase: Phase 2 (Slice TDD + implementation). 
Write the proof cases for the public CLI contract before implementation completion.

Requirements:
- Use real daemon commands, real stdout and stderr behavior, real exit codes, and real 409 collision output.
- Prove the command matrix, reconnect behavior, and recovery command guidance with actual command execution.
- Validate the human-facing contract, not just argument parsing.

Process rule:
- This proof task must be authored separately from implementation, and [[S-6]] writers may not weaken or rewrite the tests after handoff.

## Comments

### Comment (2026-05-01T00:10:47.939Z)

Delegating [[NIM-18]] proof authoring after accepting [[S-5]] commit `a85fa40` and checkpointing `main` at `7c8b877`. Verification target for the proof task is `bun test tests/nim-18.cli-contract-proof.test.ts`.

### Comment (2026-05-01T00:24:29.797Z)

Accepted child proof commit `1be9652` and integrated it into `main`. Verifying in `main` with `bun test tests/nim-18.cli-contract-proof.test.ts`; expected red phase is the missing public daemon CLI surface, currently falling back to hook-mode stdin parsing.

## Activity Log

- 2026-04-29T04:15:05.485Z: created
- 2026-05-01T00:10:47.723Z: status_changed (status) -> in-progress
- 2026-05-01T00:10:47.723Z: updated (progress) -> 1
- 2026-05-01T00:10:47.939Z: commented
- 2026-05-01T00:10:54.060Z: status_changed (status) -> in-progress
- 2026-05-01T00:10:54.060Z: updated (owner) -> child-session:5aa00d19-2daf-498c-952f-46ef7c0f07e6 (gpt-5.4)
- 2026-05-01T00:10:54.060Z: updated (progress) -> 1
- 2026-05-01T00:24:29.651Z: status_changed (status) -> needs-review
- 2026-05-01T00:24:29.651Z: updated (progress) -> 100
- 2026-05-01T00:24:29.798Z: commented
