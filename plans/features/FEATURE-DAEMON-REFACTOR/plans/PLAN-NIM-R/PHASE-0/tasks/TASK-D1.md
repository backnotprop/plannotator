---
id: TASK-D1
trackerStatus:
  type: task
title: Exit-code contract (CLI vs hook shim)
description: Freeze the CLI exit-class table, JSON error/verdict shapes, and hook-envelope
  behavior so downstream E2E and implementation work can target one contract.
successCriteria:
- Complete exit-code table covering daemon, CLI, hook, storage, clear, malformed-input,
  timeout, and signal cases
- Claude hook and OpenCode wrapper behavior distinguished from normal CLI process
  semantics
- Contract names the stable JSON error or verdict shape for each outcome family
- Recovery-command requirements stated for all actionable failures
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-0
status: needs-review
parents:
- '[[PHASE-0]]'
dependsOn:
- '[[DECISION-D1]]'
---

## Resolution

Use conventional CLI exit classes with protocol-specific hook envelopes. Numeric exit codes classify the outcome family; JSON verdict or `error.code` is the durable machine contract.

## CLI Contract

| Outcome | CLI exit | Human output | `--json` stdout |
|------|--------|--------------|-----------------|
| approve / normal success | `0` | stdout verdict or success summary | `{ ok: true, ... }` |
| deny | `1` | verdict summary | `{ ok: true, result: { verdict: "deny" } }` |
| cancel | `1` | cancel summary | `{ ok: true, result: { verdict: "cancel" } }` |
| wait timeout | `124` | timeout plus recovery guidance | `{ ok: false, error: { code: "timeout", ... } }` |
| illegal state | `2` | error plus recovery guidance | `{ ok: false, error: { code: "illegal_state", ... } }` |
| active request collision | `2` | collision plus active request ID and recovery | `{ ok: false, error: { code: "active_request_collision", activeRequestId, recovery } }` |
| malformed CLI input | `2` | parse or validation error | `{ ok: false, error: { code: "malformed_input", ... } }` where possible |
| daemon unavailable | `3` | daemon-down plus recovery guidance | `{ ok: false, error: { code: "daemon_unavailable", recovery } }` |
| daemon crash while waiting | `3` | crash or reconnect guidance | `{ ok: false, error: { code: "daemon_crashed", requestId, recovery } }` |
| occupied port | `3` | port conflict plus recovery | `{ ok: false, error: { code: "port_occupied", port, recovery } }` |
| wrong home / daemon-home mismatch | `3` | mismatch plus expected and actual home | `{ ok: false, error: { code: "home_mismatch", ... } }` |
| malformed daemon response | `4` | protocol failure | `{ ok: false, error: { code: "malformed_daemon_response", ... } }` |
| daemon or client schema mismatch | `4` | schema or version failure | `{ ok: false, error: { code: "schema_mismatch", ... } }` |
| storage failure | `4` | storage failure plus recovery | `{ ok: false, error: { code: "storage_failure", ... } }` |
| successful forced clear | `0` | cleared summary | `{ ok: true, action: "cleared", previousState, previousRequestId }` |
| client SIGINT while waiting | `130` | interrupted plus active review still exists | `{ ok: false, error: { code: "interrupted", requestId } }` where possible |
| client SIGTERM | `143` on POSIX when observable | no stable human contract beyond interruption | best-effort JSON only if handler runs |

## Hook / Wrapper Contract

- Hook shims emit protocol-valid allow or continue envelopes for success or approve outcomes.
- Hook shims emit protocol-valid block or error envelopes for deny, cancel, collision, daemon-down, timeout, malformed-hook-input, and other non-success outcomes.
- Collision is never translated into user denial.
- Hooks must fail closed: if stdout is writable, malformed hook input emits a valid block or error envelope instead of approval.
- OpenCode wrappers preserve the same semantic distinction between user verdicts and operational failures even if their envelope field names differ.

## Exact Wrapper Rows

- Claude hook output is the exact JSON shape already documented and tested:
  - `hookSpecificOutput.hookEventName = "PermissionRequest"`
  - approval uses `hookSpecificOutput.decision.behavior = "allow"`
  - denial uses `hookSpecificOutput.decision.behavior = "deny"`
  - approval may include `hookSpecificOutput.decision.updatedPermissions = [{ type: "setMode", mode, destination: "session" }]`
  - denial carries user-visible feedback in `hookSpecificOutput.decision.message`
- Claude hook deny paths exit `0`; the decision JSON itself carries the deny/error semantics.
- OpenCode `submit_plan` is not a hook envelope surface. Its contract is tool-return text plus side effects:
  - approve returns `"Plan approved!"` or `"Plan approved with notes!"`
  - deny returns `"Plan needs revision."` plus embedded user feedback
  - cancel returns `"Plan review cancelled by user."`
  - timeout returns `"[Plannotator] No response within <seconds> seconds. Please call submit_plan again."`
  - approve with agent switch may enqueue `session.prompt(... "Proceed with implementation")` and cycle the TUI agent view
- OpenCode review and annotate flows are async prompt-forwarding tools, not verdict-envelope tools.

## Timeout Policy Rows

- Raw CLI `submit` and `wait` do not define an internal default review timeout in the public daemon contract; absent an external wrapper policy, they wait until verdict, cancellation, connection failure, or explicit clear.
- Claude Code hook timeout is presently an external hook-runner policy set in `~/.claude/settings.json`, with the documented install example using `345600` seconds.
- OpenCode `submit_plan` timeout is a public wrapper policy surface:
  - `PLANNOTATOR_PLAN_TIMEOUT_SECONDS` unset => default `345600` seconds
  - `PLANNOTATOR_PLAN_TIMEOUT_SECONDS=0` => timeout disabled
  - invalid or negative values fall back to `345600`
- Timeout expiry is a wrapper-level non-approval outcome and must never be translated into user approval or denial.

## JSON Error Requirements

- Every non-success machine path uses a stable `error.code`.
- Actionable failures include an executable recovery command, for example `plannotator clear --force`, `plannotator wait --request-id REQ-...`, `plannotator open --request-id REQ-...`, or `plannotator start`.
- Stderr never contaminates `--json` stdout.

## Downstream Proof Areas

- [[TASK-E03]]
- [[TASK-E07]]
- [[TASK-E12]]
- [[TASK-E13]]
- [[TASK-E14]]
