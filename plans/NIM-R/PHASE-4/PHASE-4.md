---
id: PHASE-4
trackerStatus:
  type: phase
title: 'Phase 4: Final integration verification'
status: unstarted
priority: critical
tags:
- plannotator
- verification
- phase
- integration
progress: 0
parents:
- NIM-R
dependsOn:
- PHASE-0
- PHASE-1
- PHASE-2
- PHASE-3
---

## Description

Phase: run from a built package/binary, not merely TypeScript source. Full E2E certification from empty state.

## Acceptance criteria

- `bun test` (unit + slice tests)
- `bun run typecheck`
- `bun run lint`
- `bun run build`
- Tests against built CLI/binary (not source)
- Full E2E suite from empty `PLANNOTATOR_HOME`
- Full E2E suite repeated once (second run passes identically)
- Post-run process/state cleanup assertion
- No remote-surface command remains available

## Activity Log

- 2026-05-04T08:00:05.000Z: created
