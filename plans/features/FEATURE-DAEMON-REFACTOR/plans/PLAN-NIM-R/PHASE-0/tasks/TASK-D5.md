---
id: TASK-D5
trackerStatus:
  type: task
title: Signal-handling contract
description: Freeze the signal, interrupted-stdin, and broken-pipe contract for
  clients, hook shims, and daemon lifecycle.
successCriteria:
- Contract states client SIGINT, daemon SIGTERM or SIGINT, interrupted stdin, broken
  pipe, and active-request behavior
- Contract distinguishes client interruption from product cancellation
- Contract distinguishes daemon shutdown from normal verdict flow
- Hook malformed-stdin behavior is explicit
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-0
status: needs-review
parents:
- '[[PHASE-0]]'
dependsOn:
- '[[DECISION-D5]]'
---

## Resolution

Use client-signal interruption of the client wait only. Signals are lifecycle events, not product verdicts.

## Client Signal Contract

- A waiting CLI that receives SIGINT exits `130` and reports that the active review still exists.
- SIGINT before verdict consumption leaves daemon state unchanged.
- Client SIGTERM leaves daemon state unchanged; POSIX `143` is best effort when observable.
- Stdin breakage before submission acceptance creates no active request and returns malformed-input behavior.
- Broken stdout or stderr pipes do not implicitly cancel daemon state or convert into product verdicts.

## Daemon Signal Contract

- Daemon SIGTERM or SIGINT during `idle` restarts as `idle`.
- Daemon SIGTERM or SIGINT during `in_review(R)` restarts as `in_review(R)`.
- Daemon SIGTERM or SIGINT during `verdict_ready(R)` restarts as `verdict_ready(R)` and permits exact-ID recovery.
- SIGKILL or crash follows the crash model in [[TASK-D3]].

## Hook / Pipe Contract

- Malformed hook stdin emits a protocol-valid block or error envelope if stdout is still writable.
- Malformed hook input never defaults to approval.
- Broken pipe behavior is observable process interruption, not implicit review cancellation.

## Downstream Proof Areas

- [[TASK-E02]]
- [[TASK-E08]]
- [[TASK-E11]]
- [[TASK-E13]]
