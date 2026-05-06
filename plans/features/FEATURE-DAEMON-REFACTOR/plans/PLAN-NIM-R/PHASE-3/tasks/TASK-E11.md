---
id: TASK-E11
trackerStatus:
  type: task
title: Cancel and Reset UI actions
description: 'Fork-specific changes explicitly called out in README.  | # | Test |
  Pass condition | |---|------|----------------| | 11.1 | Click Cancel in plan UI
  | submitter CLI exits with cancel code; daemon → `idle`; doc not saved as approved/denied
  | | 11.2 | Click Reset in plan UI with annotations in progress | annotations cleared
  from DOM; `GET /api/draft` returns empty; daemon stays `active`; CLI does not exit
  | | 11.3 | Cancel after Reset | still works (Reset doesn''t break Cancel) | | 11.4
  | Cancel via SIGINT to daemon | daemon stops cleanly; submitter CLI exits with cancel/cleared
  code; lockfile removed | | 11.5 | SIGTERM daemon during `verdict_ready` | verdict
  either flushed to wait clients or persisted to state file (codify); daemon stops
  cleanly |'
successCriteria:
- E2E coverage proves Cancel and Reset behavior in the plan UI, including draft clearing without terminating the active review during Reset.
- Cancellation after Reset still works and leaves daemon and CLI state consistent.
- Signal-driven daemon termination during active or verdict-ready states follows the accepted signal contract rather than silently losing outcome state.
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
- '[[TASK-D5]]'
- '[[TASK-E00]]'
---


## Review Findings (2026-05-05)

**Kick back.** §11.5 contains decision language: "verdict either flushed to wait clients or persisted to state file (codify); daemon stops cleanly".

[[TASK-D3]] settled this: a verdict after durable write restarts as `verdict_ready(R)`. [[TASK-D5]] settled SIGTERM during `verdict_ready(R)`: restarts as `verdict_ready(R)` and permits exact-ID recovery. Replace the "either/or" with the assertion implied by D3+D5.

## Activity Log

- 2026-05-02T04:05:16.598Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
