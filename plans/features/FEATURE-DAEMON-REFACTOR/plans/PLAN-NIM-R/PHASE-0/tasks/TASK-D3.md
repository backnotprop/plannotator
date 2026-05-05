---
id: TASK-D3
trackerStatus:
  type: task
title: Daemon crash/recovery contract
description: Freeze the durability, reconnect, restart, and recovery-command contract
  for daemon crashes and restarts.
successCriteria:
- Contract states the chosen durability model for active and verdict-ready daemon state
- Contract specifies restart, reconnect, autostart, daemon-down, and persisted-verdict
  behavior
- Acceptance and verdict persistence points are explicit
- Recovery commands are concrete and executable
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-0
status: needs-review
parents:
- '[[PHASE-0]]'
dependsOn:
- '[[DECISION-D3]]'
---

## Resolution

Use partial durability by state: accepted active requests and durably accepted verdicts persist; browser-local UI process state does not.

## Durability Contract

- `idle` persists and restarts as `idle`.
- Accepted `in_review(R)` persists and restarts as `in_review(R)` with the submitted document still recoverable.
- Browser tab state, scroll position, and other UI-local state are not durable.
- A verdict before durable write is not accepted; restart remains `in_review(R)`.
- A verdict after durable write restarts as `verdict_ready(R)` until exact-ID wait consumes it or explicit clear resets it.
- Corrupt persisted state is not silently ignored; the daemon must refuse normal operation or emit a recovery error such as `schema_mismatch` or `storage_failure`.

## Acceptance / Reconnect Contract

- `/api/submit` must not return accepted until active request state is durable.
- `/api/approve`, `/api/deny`, and `/api/cancel` must not return success until the verdict is durable.
- A waiting client that loses the daemon connection may attempt one same-home reconnect using the same `requestId`.
- If the request still exists as `in_review(R)` or `verdict_ready(R)`, the wait resumes or recovers.
- If the request no longer exists, the client exits with daemon-crash guidance rather than pretending success.
- `submit`, `open`, and `state` may autostart only for the same canonical home and only when no live mismatched daemon owns the fixed port.
- `wait --request-id R` may reconnect or autostart only if same-home persisted state for `R` exists.
- `wait` without `requestId` must not autostart into an empty daemon and imply recovery for an unknown request.

## Required Recovery Commands

- `plannotator start`
- `plannotator open --request-id REQ-...`
- `plannotator wait --request-id REQ-...`
- `plannotator clear --force`

## Current Public Recovery Surface

- The current repo's implemented and documented public clear surface is bare `plannotator clear --force`.
- Current E2E proof expectations for bare `clear --force` are:
  - from active review: exit `0`, cancel the in-flight submitter, reopen the singleton slot
  - from `verdict_ready`: exit `0`, return daemon state to idle, discard the buffered verdict
  - from idle: exit `0` as a no-op
- Guarded `clear --force --request-id R` is not yet a documented or implemented public surface in this repo. Treat it as a desired hardening direction, not current contract.

## History / Replay Row

- Buffered verdict replay belongs only to the live daemon state machine while the daemon still holds the request in `verdict_ready`.
- Once the daemon has returned to `idle`, `wait` is not a replay API for consumed or cleared verdicts.
- Durable plan history remains separately available through git-backed plan storage under `~/.plannotator/plans/{project}/{slug}.md`; that history is about submitted plan revisions and approve/deny commits, not a general-purpose verdict replay channel.

## Downstream Proof Areas

- [[TASK-E02]]
- [[TASK-E08]]
- [[TASK-E09]]
