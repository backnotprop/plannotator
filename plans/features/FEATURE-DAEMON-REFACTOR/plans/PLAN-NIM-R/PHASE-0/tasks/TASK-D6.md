---
id: TASK-D6
trackerStatus:
  type: task
title: Concurrent hook submission contract
description: Freeze the single-slot submission, collision, persistence, and recovery
  contract for concurrent hook and CLI callers.
successCriteria:
- Contract states the concurrency model for hooks and CLI clients
- Contract specifies collision output, persistence behavior, active-request preservation,
  and verdict routing
- Rejected-submission persistence and recovery behavior are explicit
- Contract distinguishes collision from user denial
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-0
status: needs-review
parents:
- '[[PHASE-0]]'
dependsOn:
- '[[DECISION-D6]]'
---

## Resolution

Use a single active review slot with deterministic collision rejection.

## Submission Contract

- `POST /api/submit` while `idle` returns success with a new durable `requestId` and enters `in_review`.
- `POST /api/submit` while `in_review(R)` or `verdict_ready(R)` returns `409 Conflict`.
- CLI collision behavior exits `2` and returns stable `active_request_collision` JSON in `--json`.
- Human stderr for collisions includes the active request ID and an executable recovery command.
- Hook collision behavior emits a protocol-valid block or error envelope, not a deny verdict and not an automatic clear.

## Persistence / Routing Contract

- Rejected submissions do not overwrite active state.
- Rejected submissions do not become wait-eligible.
- Rejected submissions do not receive the active request's verdict.
- Rejected document bodies are not persisted by default; at most collision metadata without body content may be kept.
- The first accepted request owns the only active `requestId`.
- Later callers may observe or recover only through explicit commands, not implicit attachment to the active request.

## Clear Interaction Row

- Collision recovery guidance may point callers at `plannotator wait`, `plannotator open`, or `plannotator clear --force`, but collision itself never triggers an automatic clear.
- Because the current public clear surface is bare `clear --force`, later callers must treat it as an operator-level recovery command rather than a request-scoped safe retry primitive.
- A future guarded `clear --force --request-id R` would materially strengthen the race story, but it is not part of the current repo contract and must not be assumed by downstream proof cards until separately introduced.

## Downstream Proof Areas

- [[TASK-E03]]
- [[TASK-E12]]
- [[TASK-E13]]
