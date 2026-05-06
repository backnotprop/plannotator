---
id: PHASE-1
trackerStatus:
  type: phase
title: 'Phase 1: E2E infrastructure usable'
description: 'Phase: a test can build the binary, create an isolated home, start the
  daemon, wait until reachable, submit a fixture plan, terminate the daemon, and clean
  up — repeatedly without port/state contamination.'
successCriteria:
- bun test tests/e2e/helpers passes
- bun test tests/e2e/specs/01-binary.spec.ts passes
- Start/stop smoke test runs 10x in a loop without port/state contamination
- 'Post-run check: no plannotator daemon process remains'
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
status: complete
parents:
- PLAN-NIM-R
---


## Task

| Task | Description |
|------|-------------|
| [[TASK-E00]] | E2E test infrastructure: helpers, fixtures, playwright config |

## Activity Log

- 2026-05-04T08:00:02.000Z: created (unified phase, currently depends on [[TASK-E00]] which is needs-review at 100%)
