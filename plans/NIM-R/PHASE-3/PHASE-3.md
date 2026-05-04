---
id: PHASE-3
trackerStatus:
  type: phase
title: 'Phase 3: Cross-slice E2E specs complete'
status: in-progress
priority: critical
tags:
- plannotator
- e2e
- integration
- phase
progress: 10
parents:
- NIM-R
---

## Description

Phase: each E2E spec declares its semantic-decision dependencies and implementation dependencies. Specs that cover multiple slices are integration specs, not assigned to one slice. Expected-failing specs are allowed only before implementation acceptance; they must become passing before Phase 3 closes.

## E2E spec tasks (with dependency annotations)

| Spec | Task | Semantic deps | Implementation deps | Infra deps | Status |
|------|------|---------------|---------------------|------------|--------|
| E01 | E01 | — | NIM-10 | NIM-23 | in-review, 100% |
| E02 | E02 | D3, D4, D5 | NIM-5, NIM-7 | NIM-23 | unstarted |
| E03 | E03 | D1, D2 | NIM-3, NIM-6, NIM-7 | NIM-23 | unstarted |
| E04 | E04 | D2 | NIM-3, NIM-4, NIM-6 | NIM-23 | unstarted |
| E05 | E05 | — | NIM-4, NIM-6 | NIM-23 | unstarted |
| E06 | E06 | D2 | NIM-6, NIM-7 | NIM-23 | unstarted |
| E07 | E08 | D1 | NIM-6, NIM-7 | NIM-23 | unstarted |
| E08 | E07 | D3, D4, D5 | NIM-3, NIM-5, NIM-6, NIM-7 | NIM-23 | unstarted |
| E09 | E09 | D4 | NIM-5, NIM-6 | NIM-23 | unstarted |
| E10 | E10 | — | NIM-4, NIM-6, NIM-8 | NIM-23 | unstarted |
| E11 | E11 | D5 | NIM-6, NIM-7 | NIM-23 | unstarted |
| E12 | E13 | D1 | NIM-6, NIM-7, NIM-23 | NIM-23 | unstarted |
| E13 | E12 | D2, D6 | NIM-3, NIM-5, NIM-6, NIM-9 | NIM-23 | unstarted |
| E14 | E14 | — | NIM-7, NIM-9 | NIM-23 | unstarted |
| E15 | E15 | — | NIM-2, NIM-10 | NIM-23 | unstarted |
| E99 | E15 | — | all E01-E15 | — | unstarted |

Note: E13 maps to 12-json-output, E14 to 13-claude-hook-shim, E15 to 14-opencode-shim. Re-labeling needed.

## Acceptance criteria

- Each spec declares its semantic-decision dependencies and implementation dependencies
- Expected-failing specs become passing after implementation acceptance
- Each spec run twice against fresh `PLANNOTATOR_HOME`
- Failure-path tests run before happy-path-only acceptance
- Serial execution when daemon state or fixed port is involved

## Phase check

- `bun test tests/e2e/<spec>.spec.ts` for each spec
- Full suite passes
- No daemon processes remain after suite

## Activity Log

- 2026-05-04T08:00:04.000Z: created (unified phase for all 16 E2E specs)
