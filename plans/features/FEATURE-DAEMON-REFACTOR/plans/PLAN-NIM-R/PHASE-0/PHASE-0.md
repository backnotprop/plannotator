---
id: PHASE-0
trackerStatus:
  type: phase
title: 'Phase 0: Semantics frozen — decision dependencies converted to explicit contracts'
description: 'Phase: no E2E spec may rely on unstated behavior. Blocking choices
  live in feature-level decision cards; once decided, each contract task records
  observable behavior: command, state before, state after, stdout/stderr shape,
  exit code, persistence effect, and recovery behavior.'
successCriteria:
- Each [[TASK-D1]]-[[TASK-D6]] has a written contract in its task file
- All six contracts reviewed and accepted
- Every E2E spec references only named contracts for behaviors it tests
- Exit-code table reviewed and matches actual implementation
- Daemon state transition table reviewed
- Crash/recovery table reviewed
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
status: complete
parents:
- PLAN-NIM-R
dependsOn:
- '[[TASK-D1]]'
- '[[TASK-D2]]'
- '[[TASK-D3]]'
- '[[TASK-D4]]'
- '[[TASK-D5]]'
- '[[TASK-D6]]'
---


## Contract Tasks

| Task | Contract output | Blocking decision |
|------|-----------------|-------------------|
| [[TASK-D1]] | Exit-code table and hook-envelope behavior | [[DECISION-D1]] |
| [[TASK-D2]] | Verdict delivery and wait-consumption semantics | [[DECISION-D2]] |
| [[TASK-D3]] | Daemon crash and recovery durability model | [[DECISION-D3]] |
| [[TASK-D4]] | `PLANNOTATOR_HOME` and state-directory routing | [[DECISION-D4]] |
| [[TASK-D5]] | Signal handling for clients and daemon | [[DECISION-D5]] |
| [[TASK-D6]] | Concurrent submission behavior | [[DECISION-D6]] |

## Phase check

- Manual review of exit-code table
- Manual review of daemon state transition table
- Manual review of crash/recovery table
- Grep or scripted check that every E2E spec references only named contracts

## Current Review Frontier

- [[TASK-D1]] freezes the exit-class, JSON-shape, and hook-envelope contract.
- [[TASK-D2]] freezes request identity, waiter eligibility, verdict broadcast, and cleanup semantics.
- [[TASK-D3]] freezes durability, reconnect, autostart, and crash-recovery behavior.
- [[TASK-D4]] freezes canonical-home ownership, fixed-port behavior, and state-root isolation.
- [[TASK-D5]] freezes signal, interrupted-stdin, and broken-pipe behavior.
- [[TASK-D6]] freezes single-slot submission and collision semantics.
