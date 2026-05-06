---
id: PHASE-2-TDD
trackerStatus:
  type: phase
title: 'Phase 2-TDD: Per-slice proof tasks'
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
status: blocked
description: Centralize TDD proof tasks in a dedicated phase while keeping per-slice
  implementation slices in PHASE-2.
successCriteria:
- Each slice has a dedicated proof task that defines observable behavior before implementation acceptance.
- The shared TDD policy forbids mocks as terminal proof and requires real fixtures, commands, and daemon-facing behavior where applicable.
- Each proof task defines the missing-behavior signal it should expose before implementation or the acceptance surface it locks after implementation.
- Phase-local proof tasks can be reviewed independently from implementation tasks without inventing new feature intent.
parents:
- PLAN-NIM-R
dependsOn:
- PHASE-2
---

## Description

TDD proof tasks live here so they can be reviewed separately from implementation tasks while remaining tightly coupled to each slice.

## Slice tasks (TDD → implementation)

| TDD | Implementation | Slice |
|-----|----------------|-------|
| [[TASK-S-9.5]] | — | Shared TDD policy |
| [[TASK-TDD-S-1]] | [[TASK-S-1]] | S-1 |
| [[TASK-TDD-S-2]] | [[TASK-S-2]] | S-2 |
| [[TASK-TDD-S-3]] | [[TASK-S-3]] | S-3 |
| [[TASK-TDD-S-4]] | [[TASK-S-4]] | S-4 |
| [[TASK-TDD-S-5]] | [[TASK-S-5]] | S-5 |
| [[TASK-TDD-S-6]] | [[TASK-S-6]] | S-6 |
| [[TASK-TDD-S-7]] | [[TASK-S-7]] | S-7 |
| [[TASK-TDD-S-8]] | [[TASK-S-8]] | S-8 |
| [[TASK-TDD-S-9]] | [[TASK-S-9]] | S-9 |

## Review Findings (2026-05-05)

**Kick back.** Frontmatter has `dependsOn: PHASE-2`, but the parent plan ([[PLAN-NIM-R]]) explicitly states: "TDD blocks only its implementation slice" and lists PHASE-2-TDD as blocking PHASE-2. The dependency is reversed. Either:

- remove `dependsOn: PHASE-2` (this phase only depends on PHASE-0 and PHASE-1), and add `dependsOn: [[PHASE-2-TDD]]` to PHASE-2, or
- if the intent is actually PHASE-2 → PHASE-2-TDD ordering, update [[PLAN-NIM-R]] and the TDD-blocks-implementation rule accordingly.

Secondary issue: the slice table duplicates the table in [[PHASE-2]]; consolidate per "No Static Metadata Rollups".

## Activity Log

- 2026-05-05T00:00:00.000Z: created (move TDD tasks to dedicated phase)
