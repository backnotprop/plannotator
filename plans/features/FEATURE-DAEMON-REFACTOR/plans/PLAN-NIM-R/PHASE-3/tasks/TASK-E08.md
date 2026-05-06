---
id: TASK-E08
trackerStatus:
  type: task
title: clear contingency (all states)
description: '| # | Test | Pass condition | |---|------|----------------| | 8.1 |
  `plannotator clear` (no `--force`) when `idle` | exits 0; says "nothing to clear"
  | | 8.2 | `plannotator clear` (no `--force`) when `active` | exits non-zero; describes
  what would be cleared; does NOT clear | | 8.3 | `plannotator clear --force` from
  `active` | exits 0; state → `idle`; previously-submitting CLI exits with cancel/cleared
  code | | 8.4 | `plannotator clear --force` from `verdict_ready` | exits 0; state
  → `idle`; buffered verdict discarded (subsequent `wait` returns "nothing to wait
  on") | | 8.5 | `plannotator clear --force` from `idle` | exits 0; no-op | | 8.6
  | Raw `POST /api/clear` with `{ confirm: true }` | matches `--force` behavior |
  | 8.7 | Raw `POST /api/clear` without confirmation | rejected with descriptive error
  (or accepted unconditionally — codify) |'
successCriteria:
- E2E coverage proves preview and forced clear behavior from idle, active, and verdict-ready states through both CLI and raw API paths.
- Forced clear behavior for active and buffered-verdict states is explicit and leaves the daemon in a deterministic idle state.
- Clear semantics match the accepted exit-code and recovery contracts rather than ad hoc state mutation behavior.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: blocked
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-D1]]'
- '[[TASK-E00]]'
---


## Review Findings (2026-05-05)

**Kick back.** §8.7 (in the description body) contains decision language: "rejected with descriptive error (or accepted unconditionally — codify)".

[[TASK-D1]] / [[TASK-D6]] settled the clear contract; encode the chosen behavior (rejected without confirmation, with the documented error code), and drop the alternative.

Per framework: tasks must not leave acceptance criteria for the implementation agent to invent.

## Activity Log

- 2026-05-02T04:04:46.475Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
