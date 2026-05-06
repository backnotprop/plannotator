---
id: TASK-E12
trackerStatus:
  type: task
title: --json output mode (schema lock)
description: 'Programmatic consumers (OpenCode plugin, scripts) depend on the `--json`
  shape. Lock it down.  For each of `submit --json`, `review --json`, `annotate --json`,
  `wait --json`:  | # | Test | Pass condition | |---|------|----------------| | 12.x.1
  | Approve case | stdout is a single valid JSON object; schema includes at least
  `{ decision: "approved", feedback?: string, annotations?: array }` | | 12.x.2 |
  Deny case | `{ decision: "denied", feedback: string, annotations?: array }` | |
  12.x.3 | Cancel case | `{ decision: "cancelled" }` | | 12.x.4 | Timeout case | `{
  decision: "timeout" }` (or actual marker — codify) | | 12.x.5 | No extra log lines
  on stdout — daemon URL etc. must go to stderr when `--json` is in effect | stderr
  may have anything; stdout is exactly one JSON object + newline | | 12.x.6 | Schema
  stability | snapshot file `tests/e2e/__snapshots__/json-output.json` committed;
  test fails on diff |  The schema-snapshot test (12.x.6) is the most important —
  catches accidental output drift in future PRs.'
successCriteria:
- '`--json` coverage proves approve, deny, cancel, timeout, and related programmatic outcomes for submit, review, annotate, and wait.'
- Stdout contains exactly one JSON object plus newline in JSON mode, with non-protocol log output routed away from stdout.
- Schema snapshots catch output drift for programmatic consumers such as OpenCode tools and scripts.
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
- '[[TASK-S-8]]'
- '[[TASK-D1]]'
- '[[TASK-D2]]'
- '[[TASK-D6]]'
- '[[TASK-E00]]'
---


## Review Findings (2026-05-05)

**Kick back.** §12.x.4 contains decision language: "Timeout case | `{ decision: "timeout" }` (or actual marker — codify)".

[[TASK-D1]] settled the JSON timeout shape: `{ ok: false, error: { code: "timeout", ... } }` (CLI exit 124). Update §12.x.4 to assert the D1 shape, and align the assertion in §12.x.1–§12.x.3 with the D1 verdict envelope (`{ ok: true, result: { verdict: "approve|deny|cancel" } }`) rather than the legacy `{ decision: ... }` shape, or document that the wrapper layer translates D1 into a `{ decision: ... }` outer shape.

## Activity Log

- 2026-05-02T04:05:25.026Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
