---
id: TASK-E04
trackerStatus:
  type: task
title: submit plan (happy path, deny, annotation types, history)
description: Define submit-plan end-to-end behavior, including happy path, deny/feedback,
  annotations, history, and timeout semantics.
successCriteria:
- E2E coverage proves approve, deny with feedback, annotation export, history effects, and browser-driven submit-plan flow through the daemon.
- 'The suite covers no-heading slug behavior, identical resubmission handling, revision diff visibility, `--commit-message` propagation, timeout behavior, and `--no-browser`.'
- Submit-plan behavior matches the accepted verdict and history semantics without relying on inferred UI behavior.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: unstarted
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-2]]'
- '[[TASK-S-3]]'
- '[[TASK-S-5]]'
- '[[TASK-D2]]'
- '[[TASK-E00]]'
---

## Description

Parent phase: Phase 3 (Cross-slice E2E specs). Alias: [[TASK-E04]].

## 4.1 Happy path with Playwright
Start daemon → submit plan → Playwright connects → assert page content → Playwright clicks Approve → assert CLI exits 0 → assert state → `idle`

## 4.2 Deny with feedback
Drive UI to: select text → annotation toolbar → COMMENT "this is wrong" → global comment "needs more detail" → click Deny. Assert CLI exits non-zero; output contains both comments; state transitions correctly.

## 4.3 Annotation types coverage
Create one of each type and verify all five appear in exported feedback: DELETION, INSERTION, REPLACEMENT, COMMENT, GLOBAL_COMMENT.

## Additional tests
| # | Test |
|---|------|
| 4.4 | Plan with no heading → slug is `plan-YYYY-MM-DD` |
| 4.5 | Identical resubmission → no new content commit in git history |
| 4.6 | Revision diff view → `+N/-M` badge visible, diff modes togglable, Version Browser lists 2+ versions |
| 4.7 | `--commit-message` propagation → exact string appears in git log |
| 4.8 | Long timeout disabled (`PLANNOTATOR_PLAN_TIMEOUT_SECONDS=0`) → no timeout after 5s |
| 4.9 | Short timeout fires (`PLANNOTATOR_PLAN_TIMEOUT_SECONDS=2`) → CLI exits with timeout code after 4s |
| 4.10 | `--no-browser` flag → no browser process spawned; URL still printed |

## Activity Log

- 2026-05-02T04:04:10.796Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
