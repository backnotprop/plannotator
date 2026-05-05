---
id: DECISION-D6
trackerStatus:
  type: decision
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: Concurrent submission behavior
status: decided
chosen: Single active review with deterministic collision rejection
options:
- name: Single active review with deterministic collision rejection
  pros:
  - Matches the feature's singleton review-slot direction.
  - Keeps verdict routing and active state simple.
  cons:
  - Concurrent callers need actionable recovery guidance.
- name: Queue submissions
  pros:
  - Allows multiple callers to submit without immediate rejection.
  cons:
  - Expands feature scope into ordering, persistence, cancellation, and multi-verdict
    routing.
- name: Replace active request
  pros:
  - Keeps only one active slot while accepting later submissions.
  cons:
  - High risk of data loss and misdelivered verdicts.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Decision Question

What happens when multiple hooks or CLI clients attempt concurrent submissions while a review is already active?

## Constraints

- The feature target is a single active review slot.
- The first active request must not be overwritten accidentally.
- The caller rejected by collision behavior needs protocol-valid output and an executable recovery path.

## Decision Output Required

- Collision status code and CLI/hook output behavior.
- Persistence rule for rejected submissions.
- Verdict routing rule for the first active request.
- Required recovery guidance for later callers.

## Resolution

Choose a single active review slot with deterministic collision rejection.

- No queueing.
- No replacement of the active request.
- Later callers do not implicitly join the active request as waiters.

## Contract

- `POST /api/submit` while `idle` returns success with a new durable `requestId` and enters `in_review`.
- `POST /api/submit` while `in_review(R)` or `verdict_ready(R)` returns `409 Conflict`.
- CLI collision behavior exits `2` and returns stable `active_request_collision` JSON in `--json`.
- Human stderr for collisions includes the active request ID and an executable recovery command.
- Hook collision behavior emits a protocol-valid block/error envelope, not a deny verdict and not an automatic clear.
- Rejected submissions must not overwrite active state, become wait-eligible, or receive the active request's verdict.
- Rejected document bodies are not persisted by default; at most collision metadata without body content may be kept.
- The first accepted request owns the only active `requestId`; later callers may observe or recover only through explicit commands, not implicit attachment.

## Verification Targets

- Two simultaneous submissions produce exactly one accepted request and deterministic rejection for the rest.
- Active state contains only the first payload.
- Rejected payload is never served in the UI and never receives the first request's verdict.
- Rejected hooks emit protocol-valid block/error envelopes with recovery guidance.

## Revisit Trigger

Revisit only if real agent workflows show that legitimate concurrent submissions are common enough that deterministic rejection causes unacceptable lost work; that would justify an explicit queue feature rather than silent replacement.
