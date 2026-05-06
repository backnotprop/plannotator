---
id: PHASE-2
trackerStatus:
  type: phase
title: 'Phase 2: Slice TDD + implementation complete'
description: 'Phase: for each slice, the corresponding TDD task exists before or alongside
  implementation, the slice tests fail on old behavior where applicable, pass on new
  behavior, and cover at least one negative path. Implementation tasks cannot be accepted
  only by manual inspection.'
successCriteria:
- 'For each slice:'
- bun test <slice unit tests> passes
- bun test <corresponding TDD task tests> passes
- typecheck passes
- lint passes
- targeted regression for removed/changed command surface
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
status: blocked
parents:
- PLAN-NIM-R
---


## Slice tasks (TDD → implementation, local blocking only)

| TDD | Implementation | Slice |
|-----|----------------|-------|
| [[TASK-S-9.5]] | — | Shared TDD policy |
| [[TASK-TDD-S-1]] | [[TASK-S-1]] | S-1: Delete remote surface |
| [[TASK-TDD-S-2]] | [[TASK-S-2]] | S-2: State machine |
| [[TASK-TDD-S-3]] | [[TASK-S-3]] | S-3: Multiplexed router |
| [[TASK-TDD-S-4]] | [[TASK-S-4]] | S-4: Daemon lifecycle |
| [[TASK-TDD-S-5]] | [[TASK-S-5]] | S-5: Submit/Wait/Clear endpoints |
| [[TASK-TDD-S-6]] | [[TASK-S-6]] | S-6: CLI surface |
| [[TASK-TDD-S-7]] | [[TASK-S-7]] | S-7: Notifications |
| [[TASK-TDD-S-8]] | [[TASK-S-8]] | S-8: Agent wrappers |
| [[TASK-TDD-S-9]] | [[TASK-S-9]] | S-9: Build and packaging |

## Review Findings (2026-05-05)

**Kick back.** Per framework rule "Do not approve a phase if any child task still requires operational decisions": child task [[TASK-S-8]] still contains decision language ("Decide the fate of `apps/pi-extension/`..."). Approve PHASE-2 only after [[TASK-S-8]] is reauthored to encode the chosen contract.

Secondary issue: the slice table mirrors the table in [[PHASE-2-TDD]], duplicating cross-phase task references. Once both phases are reauthored, keep TDD task references in PHASE-2-TDD only and reference implementation tasks in PHASE-2 only — see framework "No Static Metadata Rollups".

## Activity Log

- 2026-05-04T08:00:03.000Z: created (unified phase for all 9 implementation slices)
