---
id: DECISION-D1
trackerStatus:
  type: decision
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: Exit-code and hook-envelope contract
status: decided
chosen: Conventional CLI codes with protocol-specific hook envelopes
options:
- name: Conventional CLI codes with protocol-specific hook envelopes
  pros:
  - Preserves shell semantics while keeping Claude hook output protocol-valid.
  - Matches the existing draft direction for approve, deny, cancel, illegal state,
    and daemon-down cases.
  cons:
  - Requires a complete row-by-row table for daemon failures, malformed responses,
    storage failures, clear behavior, and signals.
- name: Uniform nonzero CLI failures with hook-level translation
  pros:
  - Keeps CLI behavior simple and conventional for shell users.
  - Isolates Claude hook quirks in the shim layer.
  cons:
  - Requires careful proof that hook shims never leak CLI exit semantics into protocol
    envelopes.
- name: Fully protocol-neutral exit model
  pros:
  - Gives every caller the same numeric code model.
  cons:
  - Risks violating hook expectations where JSON envelopes, not process exit codes,
    carry decisions.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Decision Question

What exact exit-code and JSON-envelope contract must the CLI and agent shims expose for approve, deny, cancel, timeout, illegal state, daemon unavailable, daemon crash while waiting, malformed daemon response, occupied port, schema mismatch, forced clear, storage failure, malformed hook stdin, and interrupted waits?

## Constraints

- Hook shims must remain protocol-valid even when the daemon reports errors.
- Shell users need stable nonzero behavior for operational failures.
- E2E tests must be able to assert both process exit status and output shape.

## Decision Output Required

- A complete table for CLI exit codes.
- A complete table for Claude hook JSON-envelope behavior.
- Any OpenCode-specific translation rules.
- Recovery-command output requirements for actionable failures.

## Resolution

Choose conventional CLI exit classes with protocol-specific hook envelopes.

- Numeric exits are coarse classes; JSON `error.code` and verdict payloads are the precise contract.
- User decisions and operational failures must not collapse into one code path.
- Hook shims must fail closed and emit protocol-valid block/error envelopes whenever stdout is writable.

## Contract

- CLI success/approve exits `0`.
- User `deny` and `cancel` exit `1`, but still return structured successful verdict payloads in `--json`.
- Illegal state, malformed input, and active-request collision exit `2`.
- Daemon unavailable, daemon crash while waiting, port occupied, and home mismatch exit `3`.
- Malformed daemon response, schema mismatch, and storage failure exit `4`.
- Wait timeout exits `124`.
- Client SIGINT while waiting exits `130`; SIGTERM is best-effort `143` on POSIX when observable.
- Successful forced clear exits `0` and returns structured cleared-state output.
- Hook collision/error paths are block/error envelopes, never approval, and hooks must not auto-clear.
- Human stderr for actionable failures must include an executable recovery command, typically `plannotator clear --force --request-id REQ-...`, `plannotator wait --request-id REQ-...`, or `plannotator start`.

## Verification Targets

- Table-driven CLI assertions for every listed outcome: exit code, stdout/stderr shape, and `--json` payload.
- Hook assertions that deny, cancel, collision, daemon-down, and malformed-hook-input paths emit protocol-valid JSON on stdout when possible.
- Proof that stderr never contaminates JSON stdout.

## Revisit Trigger

Revisit only if a real Claude/OpenCode protocol surface requires nonzero process exits for user decisions, or if a real consumer cannot distinguish outcomes except by numeric exit code.
