---
id: PHASE-2-TDD
trackerStatus:
  type: phase
title: 'Phase 2-TDD: Per-slice proof tasks'
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
status: complete
description: Centralize TDD proof tasks in a dedicated phase while keeping per-slice
  implementation slices in PHASE-2.
successCriteria:
- Each slice has a dedicated proof task that defines observable behavior before implementation acceptance.
- The shared TDD policy forbids mocks as terminal proof and requires real fixtures, commands, and daemon-facing behavior where applicable.
- Each proof task defines the missing-behavior signal it should expose before implementation or the acceptance surface it locks after implementation.
- Phase-local proof tasks can be reviewed independently from implementation tasks without inventing new feature intent.
parents:
- '[[PLAN-NIM-R]]'
dependsOn:
- '[[PHASE-0]]'
- '[[PHASE-1]]'
tasks:
- '[[TASK-S-9.5]]'
- '[[TASK-TDD-S-1]]'
- '[[TASK-TDD-S-2]]'
- '[[TASK-TDD-S-3]]'
- '[[TASK-TDD-S-4]]'
- '[[TASK-TDD-S-5]]'
- '[[TASK-TDD-S-6]]'
- '[[TASK-TDD-S-7]]'
- '[[TASK-TDD-S-8]]'
- '[[TASK-TDD-S-9]]'
---

## Description

TDD proof tasks live here so they can be reviewed separately from implementation tasks while remaining tightly coupled to each slice. Per [[PLAN-NIM-R]] sequencing rule "TDD blocks only its implementation slice", each TDD-S-N task blocks acceptance of the matching TASK-S-N in [[PHASE-2]]; this phase as a whole therefore blocks PHASE-2 acceptance.

## Slice Pairings

Slice-local TDD-to-implementation pairing. Implementation tasks live in [[PHASE-2]].

| TDD task | Paired implementation slice |
|----------|-----------------------------|
| [[TASK-S-9.5]] | (none — shared TDD policy for the phase) |
| [[TASK-TDD-S-1]] | [[TASK-S-1]] (Delete remote surface) |
| [[TASK-TDD-S-2]] | [[TASK-S-2]] (State machine) |
| [[TASK-TDD-S-3]] | [[TASK-S-3]] (Multiplexed router) |
| [[TASK-TDD-S-4]] | [[TASK-S-4]] (Daemon lifecycle) |
| [[TASK-TDD-S-5]] | [[TASK-S-5]] (Submit/Wait/Clear) |
| [[TASK-TDD-S-6]] | [[TASK-S-6]] (CLI surface) |
| [[TASK-TDD-S-7]] | [[TASK-S-7]] (Notifications) |
| [[TASK-TDD-S-8]] | [[TASK-S-8]] (Agent wrappers) |
| [[TASK-TDD-S-9]] | [[TASK-S-9]] (Build/packaging) |

## Activity Log

- 2026-05-05T00:00:00.000Z: created (move TDD tasks to dedicated phase)
- 2026-05-05T01:00:00.000Z: fixed reversed dependsOn (now lists PHASE-0 and PHASE-1, the actual upstream phases); removed redundant implementation-task column (now lives only in PHASE-2)
