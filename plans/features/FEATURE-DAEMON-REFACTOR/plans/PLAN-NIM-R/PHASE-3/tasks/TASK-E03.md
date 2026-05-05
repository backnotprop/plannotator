---
id: TASK-E03
trackerStatus:
  type: task
title: state machine (legal/illegal transitions, verdict consumption)
description: Define state-machine legality and verdict-consumption behavior in E2E
  coverage for transitions and edge cases.
successCriteria:
- E2E coverage proves the legal transition set from idle through active, verdict-ready, wait consumption, and clear.
- Illegal-state paths return the documented user-visible blocking or 409 behavior with actionable recovery guidance.
- Verdict consumption, multi-waiter behavior, and stale-verdict isolation match the accepted state and wait contracts.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: needs-review
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-2]]'
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-D1]]'
- '[[TASK-D2]]'
- '[[TASK-E00]]'
---

## Description

Parent phase: Phase 3 (Cross-slice E2E specs). Alias: [[TASK-E03]].

## 3.1 Legal transitions
- `idle` → `POST /api/submit` → `active`
- `active` → `POST /api/approve` → `verdict_ready` (or `idle` — verify which)
- `active` → `POST /api/deny` → `verdict_ready`
- `active` → UI Cancel → `idle`
- `verdict_ready` → `GET /api/wait` consumes verdict → `idle`
- any → `POST /api/clear` → `idle`

## 3.2 Illegal transitions (P0 if not implemented)

| # | Test | Pass condition |
|---|------|----------------|
| 3.2.1 | Submit while `active`; second submit from different terminal | returns non-success; exit non-zero; error names in-flight doc, states daemon URL, explains recovery |
| 3.2.2 | Submit while `verdict_ready` | same blocking behavior; references unfetched verdict |
| 3.2.3 | Raw `POST /api/submit` while active | HTTP 409; JSON body with current state, mode, doc title, hint string |
| 3.2.4 | Error string is actionable | must literally contain `plannotator clear --force` (or whatever the implementation chose); string-match assertion |

## 3.3 Verdict-consumption semantics

| # | Test | Pass condition |
|---|------|----------------|
| 3.3.1 | Submit + approve (UI), then `plannotator wait` | wait exits 0; stdout contains verdict; state → `idle` |
| 3.3.2 | Submit + deny with feedback, then `plannotator wait` | wait exits with deny code; feedback in output; state → `idle` |
| 3.3.3 | Submit + UI Cancel, then `plannotator wait` | wait exits with cancel code; state → `idle` |
| 3.3.4 | Submit; while `active`, run `plannotator wait` from different CLI | blocks; on UI approve, document broadcast vs. FIFO behavior — pick one and codify |

## Activity Log

- 2026-05-02T04:03:57.645Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
