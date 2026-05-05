---
id: DECISION-D3
trackerStatus:
  type: decision
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: Daemon crash and recovery durability model
status: decided
chosen: Partial durability by state
options:
- name: Durable active and verdict state
  pros:
  - Restart can recover active reviews and resolved verdicts.
  - Strongest recovery story for interrupted clients.
  cons:
  - Requires strict persisted-state schema and corruption behavior.
- name: Ephemeral active state with explicit client failure
  pros:
  - Simpler daemon restart behavior.
  - Avoids reconstructing partially active browser/client state.
  cons:
  - Clients must receive clear failure and recovery guidance after daemon death.
- name: Partial durability by state
  pros:
  - Can persist submitted plans, history, and verdicts without overpromising all active
    browser state.
  cons:
  - Requires exact per-state persistence rules and more nuanced E2E coverage.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Decision Question

Which daemon states survive daemon death, and what must blocked submitters or waiters do after reconnect, autostart, or daemon-down failure?

## Constraints

- Crash recovery must distinguish daemon death from client death.
- Verdicts must not be lost after they are durably accepted.
- E2E tests must cover crash before and after verdict persistence.

## Decision Output Required

- Durability rule for idle, active review, and verdict-ready states.
- CLI behavior for reconnect, autostart, and daemon-down cases.
- Recovery guidance for stale clients and persisted state.

## Resolution

Choose partial durability by state.

- Accepted active requests are durable.
- Durably accepted verdicts are durable.
- Browser/UI process-local state is not part of the persistence contract.

## Contract

- `idle` persists and restarts as `idle`.
- Accepted `in_review(R)` persists and restarts as `in_review(R)` with the submitted document still recoverable.
- Browser tab state, scroll position, and similar UI-local state are explicitly non-durable.
- A verdict before durable write is not accepted; on restart the daemon remains `in_review(R)`.
- A verdict after durable write restarts as `verdict_ready(R)` until exact-ID wait consumes it or an explicit clear resets it.
- Corrupt persisted state is not silently ignored; the daemon must refuse normal operation or surface a recovery error such as `schema_mismatch` or `storage_failure`.
- `/api/submit` must not return accepted until active request state is durable.
- `/api/approve`, `/api/deny`, and `/api/cancel` must not return success until the verdict is durable.
- A waiting client that loses the daemon connection may attempt one same-home reconnect using the same `requestId`; if the request no longer exists it exits with daemon-crash recovery guidance.
- `submit`, `open`, and `state` may autostart only for the same canonical home and only when no live mismatched daemon owns the fixed port.
- `wait --request-id R` may reconnect/autostart only if persisted same-home state for `R` exists.
- `wait` without `requestId` must not autostart into an empty daemon and imply recovery for an unknown request.
- Recovery guidance must use executable commands, such as `plannotator start`, `plannotator open --request-id REQ-...`, `plannotator wait --request-id REQ-...`, and `plannotator clear --force --request-id REQ-...`.

## Verification Targets

- Kill daemon after accepted submit and before verdict; restart recovers the active request.
- Kill daemon after verdict persistence and before waiter delivery; restart serves the exact verdict for the exact `requestId`.
- Corrupt `state.json`; daemon refuses silent reset and emits recovery guidance.
- Kill daemon during wait; CLI either reconnects once or exits with daemon-crash guidance.

## Revisit Trigger

Revisit only if accepted requests later prove impossible to durably reconstruct, for example because required state is large or fundamentally process-local.
