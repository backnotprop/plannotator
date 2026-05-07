---
id: TASK-E11
trackerStatus:
  type: task
title: Cancel and Reset UI actions
description: 'Prove plan-UI Cancel and Reset semantics, plus daemon SIGINT/SIGTERM
  behavior during in_review and verdict_ready states per the [[TASK-D5]] signal
  contract and [[TASK-D3]] durability rules.'
successCriteria:
- E2E coverage proves Cancel and Reset behavior in the plan UI, including draft clearing without terminating the active review during Reset.
- Cancellation after Reset still works and leaves daemon and CLI state consistent.
- Signal-driven daemon termination during active or verdict-ready states follows the accepted signal contract rather than silently losing outcome state.
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
- '[[TASK-D5]]'
- '[[TASK-E00]]'
---


## Test Matrix

| # | Test | Pass condition |
|---|------|----------------|
| 11.1 | Click Cancel in plan UI | submitter CLI receives `cancel` verdict and exits 1 per [[TASK-D1]]; daemon → `idle`; no plan content commit on the cancelled submission |
| 11.2 | Click Reset in plan UI with annotations in progress | annotations cleared from DOM; `GET /api/draft` returns empty; daemon stays `in_review(R)`; submitter CLI does not exit |
| 11.3 | Cancel after Reset | Cancel still works (Reset does not break the verdict path); same outcome as 11.1 |
| 11.4 | SIGINT to a foreground daemon during `in_review(R)` | daemon shuts down; lockfile removed; on restart, daemon resumes as `in_review(R)` per [[TASK-D5]] and the submitter `wait --request-id R` continues to block until UI verdict |
| 11.5 | SIGTERM to daemon during `verdict_ready(R)` (durable verdict already persisted) | daemon shuts down; on restart, resumes as `verdict_ready(R)` per [[TASK-D5]] + [[TASK-D3]]; `plannotator wait --request-id R` from a fresh terminal exits 0 with the persisted verdict (no in-flight clients required to be connected) |
| 11.6 | Daemon SIGINT or SIGTERM during `idle` | daemon shuts down; restart resumes as `idle` per [[TASK-D5]] |

Client-side SIGINT (interrupting a waiting CLI) is covered by [[TASK-E07]] §7.x and [[TASK-D5]] client-signal contract; this task covers daemon-side signals only.

## Activity Log

- 2026-05-02T04:05:16.598Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: rewrote §11.5 against decided D3+D5 contract (verdict persisted, restart resumes verdict_ready); added §11.6 idle-signal case
