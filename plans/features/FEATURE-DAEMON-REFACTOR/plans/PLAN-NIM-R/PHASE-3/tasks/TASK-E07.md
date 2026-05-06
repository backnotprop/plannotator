---
id: TASK-E07
trackerStatus:
  type: task
title: wait + buffered verdict recovery
description: 'Verifies the buffered-verdict-recovery promise: "if the agent process
  dies mid-review, run `plannotator wait` from a fresh terminal to collect the verdict."  |
  # | Test | Pass condition | |---|------|----------------| | 7.1 | Submit → SIGKILL
  submitter CLI → UI still open → user approves → `plannotator wait` from fresh terminal
  | wait exits 0 with verdict; state → `idle` | | 7.2 | Same but UI denies with feedback
  | wait exits with deny code; feedback in output | | 7.3 | `plannotator wait` when
  state is `idle` | exits 0 OR documented "nothing to wait on" code; clear message;
  does NOT block forever | | 7.4 | `plannotator wait` when state is `active` | blocks
  until verdict; then behaves per §3.3.4 decision | | 7.5 | `plannotator wait --json`
  | single JSON object on stdout conforming to --json schema | | 7.6 | Daemon crash
  recovery: spawn daemon → submit → `kill -9` daemon → restart daemon | codify the
  behavior: (a) state recovered as `verdict_ready{cancelled}`, consumed by `plannotator
  wait`; (b) state lost, daemon comes up `idle`, original CLI produces useful error.
  Hanging forever is a P0 failure. |'
successCriteria:
- 'E2E coverage proves buffered-verdict recovery after submitter death, deny-with-feedback recovery, idle wait behavior, active wait blocking behavior, and `wait --json`.'
- Daemon crash and restart behavior during wait flows is codified so hangs or silent verdict loss are treated as P0 failures.
- Wait behavior matches the accepted crash, state-directory, signal, and verdict-delivery contracts.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: blocked
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-2]]'
- '[[TASK-S-4]]'
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-D3]]'
- '[[TASK-D4]]'
- '[[TASK-D5]]'
- '[[TASK-E00]]'
---


## Review Findings (2026-05-05)

**Kick back.** Unresolved decision language and a stale cross-reference:

- §7.4: "blocks until verdict; then behaves per §3.3.4 decision" — depends on a section that itself contains decision language ([[TASK-E03]] §3.3.4). After E03 is reauthored to cite [[TASK-D2]] directly, fix this reference.
- §7.6: "codify the behavior: (a) state recovered as `verdict_ready{cancelled}`...; (b) state lost, daemon comes up `idle`, original CLI produces useful error" — [[TASK-D3]] settled durability: accepted in_review and durable verdicts persist; restart preserves state. Replace the (a)/(b) options with the single behavior implied by D3 and assert it.

Per framework: tasks must not leave acceptance criteria for the implementation agent to invent.

## Activity Log

- 2026-05-02T04:04:40.252Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
