---
id: DECISION-D2
trackerStatus:
  type: decision
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: Verdict delivery and wait-consumption semantics
status: decided
chosen: Broadcast to eligible waiters
options:
- name: FIFO consumption
  pros:
  - Simple single-consumer model.
  - Avoids repeated stale verdict delivery by construction.
  cons:
  - Original submitter plus explicit waiters can race or starve.
  - Weak fit for multiple clients waiting on the same active request.
- name: Broadcast to eligible waiters
  pros:
  - Original submitter and explicit waiters can all receive the same verdict.
  - Supports request-identity-based delivery without queueing.
  cons:
  - Requires explicit rules for late waiters and state cleanup after all eligible
    waiters resolve.
- name: Persistent until explicit clear
  pros:
  - Makes late recovery straightforward.
  - Avoids losing verdicts after daemon restart.
  cons:
  - High stale-verdict risk unless request identity and clear semantics are strict.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Decision Question

Are verdicts addressed to request IDs and broadcast to all eligible waiters, consumed by one waiter, or persisted until explicit clear?

## Constraints

- Later unrelated waits must never receive stale verdicts.
- Multiple eligible clients may wait on the same active request.
- State must return to idle under a deterministic rule after verdict delivery.

## Decision Output Required

- Eligibility rules for waiters.
- Late-waiter behavior after verdict resolution.
- State cleanup rule after eligible waiters receive the verdict.
- Stale-verdict isolation rule for later unrelated waits.

## Resolution

Choose request-ID-addressed broadcast to eligible waiters, with bounded exact-ID recovery while the daemon remains in `verdict_ready`.

- No FIFO single-consumer model.
- No replay-until-explicit-clear model.
- Every accepted request must have a durable `requestId`.

## Contract

- `idle -> in_review(R) -> verdict_ready(R) -> idle` is the authoritative state path.
- A waiter is eligible only if it binds to the active `requestId`.
- `GET /api/wait?requestId=R` waits during `in_review(R)`, returns the same verdict during `verdict_ready(R)`, returns `409 request_id_mismatch` for another active request, and returns `410 verdict_consumed_or_unknown` after cleanup.
- Wait without `requestId` is allowed only while state is `in_review`; it binds to the current request at call time.
- Wait without `requestId` in `verdict_ready` must fail, to avoid stale verdict delivery to unrelated later commands.
- All currently pending waiters for `R`, including the original submitter if still connected, receive the same verdict.
- Late waiters with exact `requestId=R` may recover only while the daemon is still `verdict_ready(R)`, including after crash recovery.
- Verdicts are persisted before any waiter receives success, and active state is cleared only after durable verdict persistence succeeds.

## Verification Targets

- Two waiters bound to the same `requestId` both receive the same verdict.
- A waiter for another `requestId` gets mismatch, never the active verdict.
- Wait without ID fails in `verdict_ready`.
- Crash after verdict persistence still allows exact-ID recovery.
- After cleanup, unrelated later waits do not receive stale verdicts.

## Revisit Trigger

Revisit only if repeated real workflows show that clients commonly die after verdict persistence but before observing the verdict, and history lookup is insufficient without durable replay or acknowledgement semantics.
