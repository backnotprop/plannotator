---
id: TASK-E13
trackerStatus:
  type: task
title: Claude Code hook shim (PermissionRequest stdin flow)
description: Prove the Claude Code hook shim stdin parsing, daemon-shellout
  behavior, hook envelopes, and collision handling per the [[TASK-D1]] hook-envelope
  contract, [[TASK-D3]] autostart rule, and [[TASK-D6]] collision contract.
successCriteria:
- Hook-mode E2E coverage proves real PermissionRequest stdin handling, approve and deny envelopes, daemon-unavailable behavior, malformed-stdin behavior, and concurrent hook collisions.
- Hook-envelope output remains protocol-valid while still surfacing actionable collision or failure information back to Claude Code.
- The worst-case concurrent-hook path is covered as a P0 surface because hangs or lost data are unacceptable.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: unstarted
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

| # | Test | Pass condition |
|---|------|----------------|
| 13.1 | Pipe real `PermissionRequest` JSON event into stdin of the binary (no subcommand) | binary forwards plan to daemon; UI shows plan; on approve, stdout emits the exact `hookSpecificOutput.decision.behavior = "allow"` JSON envelope per [[TASK-D1]] hook-envelope contract; CLI exits 0 |
| 13.2 | Same but UI denies | stdout emits `hookSpecificOutput.decision.behavior = "deny"` with `message` containing the user feedback and the documented `"YOUR PLAN WAS NOT APPROVED. ..."` prefix per [[TASK-D1]]; CLI exits 0 (deny semantics carried in JSON, not exit code, per Claude hook contract) |
| 13.3a | Daemon not running, fixed port free, same canonical home | binary autostarts daemon per [[TASK-D3]] autostart rule for `submit`; flow proceeds as in 13.1 |
| 13.3b | Daemon not running, fixed port owned by a non-Plannotator process | hook emits a protocol-valid block envelope whose `message` carries the `port_occupied` recovery guidance from [[TASK-D1]]; never approves implicitly |
| 13.3c | Daemon not running, stale daemon metadata for a different canonical home | hook emits a protocol-valid block envelope carrying `home_mismatch` recovery guidance from [[TASK-D1]]; never autostarts into the wrong home |
| 13.4 | Malformed stdin JSON | hook emits a protocol-valid block envelope (per [[TASK-D1]] "fail closed: malformed hook input emits a valid block or error envelope instead of approval"); never approves; daemon state unchanged |
| 13.5 | Concurrent hook invocations (two Claude sessions submit at once — the worst-case real-world scenario, P0 if it hangs or loses data) | the first submission is accepted; the second hits the [[TASK-D6]] collision path and emits a protocol-valid block envelope whose `message` carries the `active_request_collision` recovery guidance per [[TASK-D1]]; second hook never receives the first request's verdict; neither hook hangs |

## Activity Log

- 2026-05-02T04:05:38.712Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: split §13.3 into 13.3a/b/c against [[TASK-D3]] autostart eligibility rule; pinned malformed-input and collision behavior to D1+D6 fail-closed envelopes
