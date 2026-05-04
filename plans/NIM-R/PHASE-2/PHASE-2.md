---
id: PHASE-2
trackerStatus:
  type: phase
title: 'Phase 2: Slice TDD + implementation complete'
status: in-progress
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
| NIM-12 | — | Shared TDD policy | in-review, 100% |
| NIM-13 | NIM-2 | S-1: Delete remote surface | in-review, 100% |
| NIM-14 | NIM-3 | S-2: State machine | in-review, 100% |
| NIM-15 | NIM-4 | S-3: Multiplexed router | in-review, 100% |
| NIM-16 | NIM-5 | S-4: Daemon lifecycle | in-review, 100% |
| NIM-17 | NIM-6 | S-5: Submit/Wait/Clear endpoints | in-review, 100% |
| NIM-18 | NIM-7 | S-6: CLI surface | in-review, 100% |
| NIM-19 | NIM-8 | S-7: Notifications | in-review, 100% |
| NIM-20 | NIM-9 | S-8: Agent wrappers | in-review, 100% |
| NIM-21 | NIM-10 | S-9: Build and packaging | in-review, 100% |

## Acceptance criteria

For each slice:
- `bun test <slice unit tests>` passes
- `bun test <corresponding TDD task tests>` passes
- typecheck passes
- lint passes
- targeted regression for removed/changed command surface

## Activity Log

- 2026-05-04T08:00:03.000Z: created (unified phase for all 9 implementation slices)
