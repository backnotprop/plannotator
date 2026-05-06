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
status: complete
parents:
- '[[PLAN-NIM-R]]'
dependsOn:
- '[[PHASE-2-TDD]]'
tasks:
- '[[TASK-S-1]]'
- '[[TASK-S-2]]'
- '[[TASK-S-3]]'
- '[[TASK-S-4]]'
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-S-7]]'
- '[[TASK-S-8]]'
- '[[TASK-S-9]]'
---


## Implementation Slices

Each slice owns one CLI/daemon surface. Cross-phase TDD pairings live in [[PHASE-2-TDD]].

| Task | Slice |
|------|-------|
| [[TASK-S-1]] | Delete remote surface |
| [[TASK-S-2]] | State machine |
| [[TASK-S-3]] | Multiplexed router |
| [[TASK-S-4]] | Daemon lifecycle |
| [[TASK-S-5]] | Submit/Wait/Clear endpoints |
| [[TASK-S-6]] | CLI surface |
| [[TASK-S-7]] | Notifications |
| [[TASK-S-8]] | Agent wrappers |
| [[TASK-S-9]] | Build and packaging |

## Activity Log

- 2026-05-04T08:00:03.000Z: created (unified phase for all 9 implementation slices)
- 2026-05-05T00:00:00.000Z: deduplicated TDD slice table (now lives only in PHASE-2-TDD); fixed parents wikilink; added explicit dependsOn PHASE-2-TDD per plan card sequencing rule
