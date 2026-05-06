---
id: TASK-D2
trackerStatus:
  type: task
title: Verdict broadcast / wait-consumption semantics
description: Freeze the request-identity, waiter-eligibility, verdict-delivery,
  and cleanup contract for the daemon review state machine.
successCriteria:
- Contract states the chosen delivery model and request-identity rule
- Contract specifies eligible waiter, late waiter, cleanup, and stale-verdict behavior
- State transition from `idle` to `in_review` to `verdict_ready` to `idle` is explicit
- Wait-without-ID behavior is specified separately from exact-ID wait behavior
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-0
status: complete
parents:
- '[[PHASE-0]]'
dependsOn:
- '[[DECISION-D2]]'
---

## Resolution

Use request-ID-addressed broadcast to eligible waiters, with bounded exact-ID recovery while the daemon remains in `verdict_ready`.

## State Transition

```text
idle
  -- submit accepted, requestId = R -->
in_review(R)
  -- approve/deny/cancel durably recorded -->
verdict_ready(R)
  -- eligible waiters receive verdict / exact-ID recovery waiter consumes R -->
idle
```

## Waiter Eligibility Contract

- A waiter is eligible only if it binds to the active `requestId`.
- `GET /api/wait?requestId=R`:
  - waits during `in_review(R)`;
  - returns the same verdict during `verdict_ready(R)`;
  - returns `409 request_id_mismatch` if another request is active;
  - returns `410 verdict_consumed_or_unknown` after cleanup.
- Wait without `requestId` is allowed only while state is `in_review`; it binds to the current request at call time.
- Wait without `requestId` in `verdict_ready` must fail, because it would otherwise permit stale verdict delivery to later unrelated commands.

## Delivery Contract

- All currently pending waiters for `R`, including the original blocking submitter if still connected, receive the same verdict.
- No FIFO single-consumer semantics.
- No waiter receives a verdict for any request other than the one it bound to.
- A late waiter with exact `requestId=R` may recover only while the daemon is still `verdict_ready(R)`, including after crash recovery.
- Once the daemon has returned to `idle`, later waits for `R` receive `410 verdict_consumed_or_unknown`.
- Verdicts are persisted before any waiter receives success.
- Active state clears only after durable verdict persistence succeeds.

## Downstream Proof Areas

- [[TASK-E03]]
- [[TASK-E04]]
- [[TASK-E06]]
- [[TASK-E13]]
