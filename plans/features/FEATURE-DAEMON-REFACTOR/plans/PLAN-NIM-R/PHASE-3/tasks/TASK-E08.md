---
id: TASK-E08
trackerStatus:
  type: task
title: clear contingency (all states)
description: 'Prove `plannotator clear` and `POST /api/clear` behavior from idle,
  in_review, and verdict_ready states per the [[TASK-D1]] exit-code contract and the
  [[TASK-D3]] "buffered verdict replay only while verdict_ready" rule.'
successCriteria:
- E2E coverage proves preview and forced clear behavior from idle, active, and verdict-ready states through both CLI and raw API paths.
- Forced clear behavior for active and buffered-verdict states is explicit and leaves the daemon in a deterministic idle state.
- Clear semantics match the accepted exit-code and recovery contracts rather than ad hoc state mutation behavior.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: needs-review
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-D1]]'
- '[[TASK-E00]]'
---


## Test Matrix

| # | Test | Pass condition |
|---|------|----------------|
| 8.1 | `plannotator clear` (no `--force`) when `idle` | exits 0; stdout says "nothing to clear" |
| 8.2 | `plannotator clear` (no `--force`) when `in_review(R)` | exits 2 per [[TASK-D1]] illegal-state class; stderr describes what would be cleared and includes recovery command `plannotator clear --force`; does NOT mutate state |
| 8.3 | `plannotator clear --force` from `in_review(R)` | exits 0; state → `idle`; previously-submitting CLI receives cancel verdict per [[TASK-D3]] recovery rule and exits 1 (cancel) per [[TASK-D1]] |
| 8.4 | `plannotator clear --force` from `verdict_ready(R)` | exits 0; state → `idle`; buffered verdict discarded; subsequent `wait --request-id R` exits with `410 verdict_consumed_or_unknown` per [[TASK-D2]] |
| 8.5 | `plannotator clear --force` from `idle` | exits 0; no-op |
| 8.6 | `POST /api/clear` with `{ confirm: true }` | matches CLI `--force` behavior |
| 8.7 | `POST /api/clear` without `confirm: true` | rejected with HTTP 4xx and `error.code = "malformed_input"` per [[TASK-D1]]; state unchanged. (No silent unconditional clear: bare `POST /api/clear` is the API mirror of CLI `clear` without `--force`, which per 8.2 must not mutate state.) |

## Activity Log

- 2026-05-02T04:04:46.475Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: rewrote §8.7 against decided D1 contract (no silent clear); pinned exit codes and JSON shapes to D1/D2/D3
