---
id: TASK-D4
trackerStatus:
  type: task
title: PLANNOTATOR_HOME / state-dir contract
description: Freeze the canonical-home, fixed-port, daemon-metadata, and cleanup-root
  contract for daemon state ownership.
successCriteria:
- Contract states the authoritative `PLANNOTATOR_HOME` ownership model
- Contract specifies mismatched-home, fixed-port, daemon-metadata, test-isolation,
  and cleanup behavior
- Canonical home identity and stale-metadata replacement rules are explicit
- Serial-test or test-only port-override implications are explicit
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-0
status: complete
parents:
- '[[PHASE-0]]'
dependsOn:
- '[[DECISION-D4]]'
---

## Resolution

Use daemon-start-time `PLANNOTATOR_HOME` as the authoritative state root for the daemon lifetime.

## Ownership Contract

- One daemon owns one canonical home.
- No per-request home routing.
- No single daemon multiplexing multiple homes.
- Daemon startup canonicalizes `PLANNOTATOR_HOME` and writes metadata including PID, port, canonical home, stable home identity, startup time, and version.
- Every client canonicalizes its own `PLANNOTATOR_HOME` and compares it against the daemon's home identity.
- A live daemon whose home does not match the client home rejects the command with `home_mismatch`.

## Fixed-Port / Metadata Contract

- If no daemon exists and the fixed port is free, start succeeds for the requested home.
- If a non-Plannotator process owns the fixed port, start and client commands fail with `port_occupied`.
- Stale daemon metadata may be replaced only when the recorded PID is dead and the port is actually free.
- All persistent files and cleanup checks are scoped to the selected canonical home.
- Fixed-port singleton E2E tests run serially unless a test-only port override exists.
- If a port override exists, final certification still runs against the default fixed-port contract.

## Port Override Row

- `PLANNOTATOR_PORT` is already a public environment surface in repo docs and code, not a hidden test-only knob.
- When `PLANNOTATOR_PORT` is set, the daemon and CLI use that fixed port instead of allocating or reusing a discovered random/default port.
- Invalid `PLANNOTATOR_PORT` values are daemon-failure input errors, not silent fallbacks.
- Even though `PLANNOTATOR_PORT` is public, final certification must still prove the default fixed-port or canonical-port behavior expected by the supported runtime mode.

## Downstream Proof Areas

- [[TASK-E02]]
- [[TASK-E08]]
- [[TASK-E09]]
- [[TASK-E15]]
