---
id: DECISION-D4
trackerStatus:
  type: decision
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: PLANNOTATOR_HOME and daemon state-directory routing
status: decided
chosen: Daemon-start-time home is authoritative
options:
- name: Daemon-start-time home is authoritative
  pros:
  - One daemon owns one state directory for its lifetime.
  - Easy to reject mismatched clients deterministically.
  cons:
  - Clients must surface clear errors when their environment points elsewhere.
- name: Per-invocation home routes to matching daemon
  pros:
  - Test isolation and multi-home workflows can be explicit.
  cons:
  - Requires port or registry logic for multiple homes.
- name: Global daemon with per-request state roots
  pros:
  - Avoids multiple daemon processes.
  cons:
  - Blurs isolation and makes cleanup/state contamination harder to prove.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Decision Question

Does `PLANNOTATOR_HOME` define daemon-start-time state, per-invocation routing, or another state ownership model?

## Constraints

- E2E tests need isolated and cleanup-verifiable state roots.
- Fixed-port behavior must be deterministic.
- Mismatched daemon/client state directories must not silently corrupt or cross-read state.

## Decision Output Required

- Cross-home client behavior.
- Fixed-port and daemon metadata behavior.
- Test serialization or port-override requirement.
- Cleanup paths that the harness must inspect.

## Resolution

Choose daemon-start-time `PLANNOTATOR_HOME` as the authoritative state root for the daemon lifetime.

- One daemon owns one canonical home.
- No per-request home routing.
- No single daemon multiplexing multiple homes.

## Contract

- Daemon startup canonicalizes `PLANNOTATOR_HOME` and writes daemon metadata including pid, port, canonical home, stable home identity, startup time, and version.
- Every client invocation canonicalizes its own `PLANNOTATOR_HOME` and compares it against the daemon's home identity.
- A live daemon whose canonical home does not match the client home rejects the command with `home_mismatch`.
- If no daemon exists and the fixed port is free, start succeeds for the requested home.
- If a non-Plannotator process owns the fixed port, start/client commands fail with `port_occupied`.
- Stale daemon metadata may be replaced only when the recorded PID is dead and the port is actually free.
- All persistent files and cleanup checks are scoped to the selected canonical home.
- Fixed-port singleton E2E tests must run serially unless a test-only port override exists; if a port override exists, final certification still runs against the default fixed-port contract.

## Verification Targets

- Daemon started with home A accepts clients from home A.
- Client from home B receives `home_mismatch`.
- Non-Plannotator port ownership produces `port_occupied`.
- Stale metadata is recoverable only when no live process owns the port.
- All persisted files live under the selected `PLANNOTATOR_HOME`.

## Revisit Trigger

Revisit only if the product later needs simultaneous independent review sessions across repositories or worktrees; that would require explicit multi-home routing and is outside the current singleton feature.
