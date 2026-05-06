---
id: TASK-E13
trackerStatus:
  type: task
title: Claude Code hook shim (PermissionRequest stdin flow)
description: '| # | Test | Pass condition | |---|------|----------------| | 13.1 |
  Pipe real `PermissionRequest` JSON event into stdin of binary (no subcommand) |
  binary forwards plan to daemon; UI shows plan; on approve, stdout emits exact `hookSpecificOutput.decision.behavior=allow`
  JSON envelope | | 13.2 | Same but UI denies | stdout emits `behavior=deny` with
  `message` containing feedback and documented prefix `"YOUR PLAN WAS NOT APPROVED.
  ..."` | | 13.3 | Daemon not running when hook fires | binary either auto-starts
  daemon (preferred) or fails with clear stderr message — codify which | | 13.4 |
  Malformed stdin JSON | exits non-zero with clear stderr error; does not corrupt
  daemon state | | 13.5 | Concurrent hook invocations (two Claude sessions submit
  at once) | second one hits §3.2 illegal-state path; error reaches Claude via deny
  envelope''s `message` so Claude can act on it — does not hang or lose data |'
successCriteria:
- Hook-mode E2E coverage proves real PermissionRequest stdin handling, approve and deny envelopes, daemon-unavailable behavior, malformed-stdin behavior, and concurrent hook collisions.
- Hook-envelope output remains protocol-valid while still surfacing actionable collision or failure information back to Claude Code.
- The worst-case concurrent-hook path is covered as a P0 surface because hangs or lost data are unacceptable.
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

## Description
13.5 is the worst-case real-world scenario (user has Claude open in two tabs). P0 if it hangs or loses data.
## Review Findings (2026-05-05)

**Kick back.** §13.3 contains decision language: "binary either auto-starts daemon (preferred) or fails with clear stderr message — codify which".

[[TASK-D3]] settled autostart eligibility: "`submit`, `open`, and `state` may autostart only for the same canonical home and only when no live mismatched daemon owns the fixed port." The Claude hook shim's `submit` invocation falls under that rule. Update §13.3 to assert autostart-on-eligible-state and `daemon_unavailable` failure (per [[TASK-D1]]) on ineligible state. Drop the alternative.

## Activity Log

- 2026-05-02T04:05:38.712Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
