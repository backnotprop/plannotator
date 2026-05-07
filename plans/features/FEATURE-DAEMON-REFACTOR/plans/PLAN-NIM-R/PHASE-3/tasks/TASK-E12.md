---
id: TASK-E12
trackerStatus:
  type: task
title: --json output mode (schema lock)
description: Lock the `--json` stdout schemas for `submit`, `review`, `annotate`,
  `wait`, `clear`, and error paths to the [[TASK-D1]] CLI verdict-and-error envelope
  so programmatic consumers (OpenCode plugin, scripts) cannot silently drift.
successCriteria:
- '`--json` coverage proves approve, deny, cancel, timeout, and related programmatic outcomes for submit, review, annotate, and wait.'
- Stdout contains exactly one JSON object plus newline in JSON mode, with non-protocol log output routed away from stdout.
- Schema snapshots catch output drift for programmatic consumers such as OpenCode tools and scripts.
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
- '[[TASK-S-8]]'
- '[[TASK-D1]]'
- '[[TASK-D2]]'
- '[[TASK-D6]]'
- '[[TASK-E00]]'
---


## Test Matrix

For each of `plannotator submit --json`, `plannotator review --json`, `plannotator annotate --json`, `plannotator wait --json`, `plannotator clear --force --json`:

| # | Test | Pass condition (per [[TASK-D1]]) |
|---|------|----------------------------------|
| 12.x.1 | Approve case | stdout is exactly one JSON object + newline; matches `{ ok: true, result: { verdict: "approve", ... } }`; CLI exits 0 |
| 12.x.2 | Deny case | `{ ok: true, result: { verdict: "deny", feedback: string, annotations?: array } }`; CLI exits 1 |
| 12.x.3 | Cancel case | `{ ok: true, result: { verdict: "cancel" } }`; CLI exits 1 |
| 12.x.4 | Timeout case (wrapper-level only — CLI submit/wait have no internal timeout per [[TASK-D1]]) | for OpenCode `submit_plan` short-timeout test: stdout includes `{ ok: false, error: { code: "timeout", ... } }`; CLI exits 124 |
| 12.x.5 | Illegal-state collision | `{ ok: false, error: { code: "active_request_collision", activeRequestId, recovery } }`; CLI exits 2 |
| 12.x.6 | Daemon unavailable | `{ ok: false, error: { code: "daemon_unavailable", recovery } }`; CLI exits 3 |
| 12.x.7 | Stdout/stderr separation under `--json` | stdout is exactly one JSON object + newline; daemon URL, log lines, and progress output go to stderr |
| 12.x.8 | Schema stability | snapshot file `tests/e2e/__snapshots__/json-output.json` committed and asserted per case; test fails on diff |

The schema-snapshot test (12.x.8) is the most important — it catches accidental output drift in future PRs.

## Activity Log

- 2026-05-02T04:05:25.026Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: rewrote schema assertions against [[TASK-D1]] envelope (`{ ok, result|error }`); removed the legacy `{ decision }` shape; added illegal-state and daemon-unavailable cases per D1
