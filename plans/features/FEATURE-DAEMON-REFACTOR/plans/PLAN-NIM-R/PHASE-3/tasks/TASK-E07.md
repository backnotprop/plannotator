---
id: TASK-E07
trackerStatus:
  type: task
title: wait + buffered verdict recovery
description: 'Prove the buffered-verdict-recovery contract per [[TASK-D2]] (eligible
  exact-ID waiter receives broadcast verdict) and [[TASK-D3]] (daemon crash preserves
  durable in_review and verdict_ready state).'
successCriteria:
- 'E2E coverage proves buffered-verdict recovery after submitter death, deny-with-feedback recovery, idle wait behavior, active wait blocking behavior, and `wait --json`.'
- Daemon crash and restart behavior during wait flows is codified so hangs or silent verdict loss are treated as P0 failures.
- Wait behavior matches the accepted crash, state-directory, signal, and verdict-delivery contracts.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: needs-review
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
## Test Matrix

| # | Test | Pass condition |
| --- | --- | --- |
| 7.1 | Submit with `requestId=R` → SIGKILL submitter CLI → UI still open → user approves → `plannotator wait --request-id R` from fresh terminal | wait exits 0 with verdict; state → `idle` per [[TASK-D2]] |
| 7.2 | Same as 7.1 but UI denies with feedback | wait exits with deny code per [[TASK-D1]]; feedback in output |
| 7.3 | `plannotator wait --request-id R` when daemon is `idle` and `R` is unknown | exits with `410 verdict_consumed_or_unknown` per [[TASK-D2]]; does NOT block |
| 7.4 | `plannotator wait` (no `--request-id`) when daemon is `idle` | exits with `410 verdict_consumed_or_unknown` per [[TASK-D2]] (wait without request-id in non-`in_review` state is illegal); does NOT block |
| 7.5 | `plannotator wait --request-id R` while daemon is `in_review(R)` | blocks until verdict; on UI approve, exits 0 with verdict; single-waiter model per [[TASK-D2]] and [[TASK-E03]] §3.3.4b |
| 7.6 | `plannotator wait --json --request-id R` | single JSON object on stdout conforming to [[TASK-D1]] verdict envelope; stderr may carry log lines |
| 7.7 | Daemon crash before durable verdict: spawn daemon → submit → `kill -9` daemon during `in_review(R)` → restart daemon | restart resumes as `in_review(R)` per [[TASK-D3]]; `plannotator wait --request-id R` from fresh terminal continues to block until UI verdict |
| 7.8 | Daemon crash after durable verdict: as 7.7 but `kill -9` during `verdict_ready(R)` after approve has been durably recorded → restart daemon | restart resumes as `verdict_ready(R)` per [[TASK-D3]]; `plannotator wait --request-id R` from fresh terminal exits 0 with the persisted verdict |
| 7.9 | Daemon-down at wait time: stop daemon, then `plannotator wait --request-id R` | exits with `daemon_unavailable` per [[TASK-D1]]; never hangs |

A wait that blocks forever in any of these scenarios is a P0 failure per the release
proof contract.

## Activity Log

- 2026-05-02T04:04:40.252Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: rewrote test matrix against decided D1/D2/D3 contracts;
  split crash recovery into pre-/post-durable cases per D3
