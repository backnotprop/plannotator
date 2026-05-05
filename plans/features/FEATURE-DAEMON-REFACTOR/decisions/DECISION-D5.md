---
id: DECISION-D5
trackerStatus:
  type: decision
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: Signal handling for clients and daemon
status: decided
chosen: Client SIGINT cancels only the client wait
options:
- name: Client SIGINT cancels only the client wait
  pros:
  - Keeps daemon alive and avoids implicit review cancellation.
  - Matches conventional terminal interruption behavior.
  cons:
  - Requires clear state rule for the still-active review.
- name: Client SIGINT cancels the active request
  pros:
  - User interruption has visible product effect.
  cons:
  - Risky for hook clients and multiple waiters unless ownership is explicit.
- name: Signals map to daemon shutdown semantics
  pros:
  - Simple operational model for process termination.
  cons:
  - Can conflate graceful shutdown, crash recovery, and user cancellation.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Decision Question

How do SIGINT, SIGTERM, broken stdin, and broken pipes affect waiting clients, active reviews, hook shims, and daemon lifecycle?

## Constraints

- Graceful shutdown and crash recovery must remain distinguishable.
- Hook shims must emit protocol-valid output or documented failure behavior.
- Waiting CLI interruption must have stable exit behavior.

## Decision Output Required

- Client SIGINT behavior and exit code.
- Daemon state after interrupted submitters or waiters.
- Hook stdin and broken-pipe behavior.
- Daemon SIGTERM behavior during active and verdict-ready states.

## Resolution

Choose client-signal interruption of the client wait only. Signals are lifecycle events, not product verdicts.

- Client interrupts must not implicitly cancel the active review.
- Daemon termination semantics follow the crash/restart model from [[DECISION-D3]].

## Contract

- A waiting CLI that receives SIGINT exits `130` and reports that the active review still exists.
- SIGINT before verdict consumption leaves daemon state unchanged.
- Client SIGTERM leaves daemon state unchanged; POSIX exit `143` is best effort when observable.
- Stdin breakage before submission acceptance creates no active request and returns malformed-input behavior.
- Broken stdout/stderr pipes do not implicitly cancel daemon state or convert into product verdicts.
- Daemon SIGTERM or SIGINT during `idle` restarts as `idle`.
- Daemon SIGTERM or SIGINT during `in_review(R)` restarts as `in_review(R)`.
- Daemon SIGTERM or SIGINT during `verdict_ready(R)` restarts as `verdict_ready(R)`, allowing exact-ID recovery.
- Hook stdin failures must emit protocol-valid block/error envelopes if stdout is still writable; malformed hook input must never default to approval.

## Verification Targets

- SIGINT to a blocking CLI leaves daemon state active.
- SIGTERM to daemon during active review restores the active request on restart.
- SIGTERM to daemon during `verdict_ready` preserves exact-ID recovery.
- Malformed hook stdin fails closed with valid envelope output when possible.
- Broken stdin before submit creates no active request.

## Revisit Trigger

Revisit only if real user workflow evidence shows that terminal interruption is consistently intended as review cancellation, in which case ownership semantics would need to be designed explicitly.
