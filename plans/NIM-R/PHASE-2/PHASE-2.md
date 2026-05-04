---
id: PHASE-2
trackerStatus:
  type: phase
title: "Phase 2: Slice TDD + implementation complete"
status: needs-review
priority: critical
tags:
  - plannotator
  - implementation
  - tdd
  - phase
progress: 50
parents:
  - NIM-R
---

## Description

Phase: for each slice, the corresponding TDD task exists before or alongside implementation, the slice tests fail on old behavior where applicable, pass on new behavior, and cover at least one negative path. Implementation tasks cannot be accepted only by manual inspection.

## Slice tasks (TDD → implementation, local blocking only)

| TDD | Implementation | Slice | Status |
|-----|----------------|-------|--------|
| [[S-9.5]] | — | Shared TDD policy | needs-review, 100% |
| [[NIM-13]] | [[S-1]] | S-1: Delete remote surface | needs-review, 100% |
| [[NIM-14]] | [[S-2]] | S-2: State machine | needs-review, 100% |
| [[NIM-15]] | [[S-3]] | S-3: Multiplexed router | needs-review, 100% |
| [[NIM-16]] | [[S-4]] | S-4: Daemon lifecycle | needs-review, 100% |
| [[NIM-17]] | [[S-5]] | S-5: Submit/Wait/Clear endpoints | needs-review, 100% |
| [[NIM-18]] | [[S-6]] | S-6: CLI surface | needs-review, 100% |
| [[NIM-19]] | [[S-7]] | S-7: Notifications | needs-review, 100% |
| [[NIM-20]] | [[S-8]] | S-8: Agent wrappers | needs-review, 100% |
| [[NIM-21]] | [[S-9]] | S-9: Build and packaging | needs-review, 100% |

## Acceptance criteria

For each slice:
- `bun test <slice unit tests>` passes
- `bun test <corresponding TDD task tests>` passes
- typecheck passes
- lint passes
- targeted regression for removed/changed command surface

## Activity Log

- 2026-05-04T08:00:03.000Z: created (unified phase for all 9 implementation slices)
