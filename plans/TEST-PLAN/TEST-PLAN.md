---
id: TEST-PLAN
trackerStatus:
  type: plan
title: "Plannotator Daemon \u2014 E2E Test Plan"
status: unstarted
priority: high
tags:
- plannotator
- e2e
- testing
- playwright
- daemon
---

## Description

Companion to the shipped code on `main`. Audience: coding agents with Playwright access, executing tests inside a real shell that can spawn the `plannotator` binary, exercise the daemon via HTTP, and drive the browser UI.

**Spec source of truth (in order):**
1. The compiled binary's `--help` output
2. `README.md` on `main` (user-facing contract)
3. The HTTP API table in the README
4. "Fork-specific changes" section of the README

**`AGENTS.md` is stale** — still describes the pre-refactor per-invocation server architecture. Do not use it as a spec. Filing a doc fix is a follow-up task.

## Structure

16 spec files under `tests/e2e/specs/` plus shared helpers and fixtures:

- `01-binary.spec.ts` — binary surface (fast phase), help/version, aliases, deleted flags absence
- `02-daemon-lifecycle.spec.ts` — start/stop/status/aliases, singleton behavior, stale PID, port occupied, restart
- `03-state-machine.spec.ts` — legal/illegal transitions, wait-on-idle, illegal-state recovery command (API state transitions only, multi-waiter/broadcast moved out)
- `04-submit-plan.spec.ts` — approve/deny/cancel happy paths, annotation payloads, history, --commit-message, --no-browser
- `05-review-mode.spec.ts` — diff types, async feedback, git-add
- `06-annotate-mode.spec.ts` — annotate mode coverage
- `07-wait-broadcast.spec.ts` — wait idle/active/resolved, multi-waiter broadcast, stale verdict rules, --json output
- `08-crash-recovery.spec.ts` — submitter killed, waiter killed, **daemon killed**, restart behavior, CLI reconnect vs daemon-down
- `09-history-storage.spec.ts` — disk side-effects, git history, drafts, atomic writes, corruption recovery
- `10-ui-actions.spec.ts` — full Playwright UI coverage, browser UI actions, refresh, multiple pending items, stale UI
- `11-cancel-and-reset.spec.ts` — Cancel/Reset fork-specific behaviors, all destructive state mutations
- `12-json-output.spec.ts` — --json schema, snapshot lock, recovery command in JSON
- `13-claude-hook-shim.spec.ts` — PermissionRequest stdin flow, exit codes, retries, daemon-down, malformed stdin (protocol-specific only)
- `14-opencode-shim.spec.ts` — OpenCode plugin contract tests
- `15-concurrency.spec.ts` — concurrent CLI submit, concurrent Claude hooks, hook + CLI simultaneous submit, two waiters + one submitter, collision does not overwrite active request
- `99-deletions-and-doc.spec.ts` — deleted surfaces, AGENTS.md staleness (mark as known failing/docs phase), stale scripts

## P0 findings (stop immediately)

- Illegal-state error message (3.2.4) doesn't tell users how to recover — **must execute recovery command**, not just assert string presence
- Daemon crash leaves CLI hung with no way to exit (7.6) — **tests only cover submitter-client crash, NOT daemon crash**
- Concurrent hook invocations (13.5) lose data or hang — current contract is "single active request; later hooks get protocol-level deny with exit 0" — must prove non-overwrite and no stale active state
- Any test in spec 01 fails
- **NEW (from ChatGPT feedback)**: Verdict delivery contract violation — any case where approve/deny/cancel is lost, delivered to wrong waiter, delivered twice to unrelated commands, or blocks a waiter indefinitely

## Open questions to settle during the test pass

### Exit codes (split CLI contract from hook contract explicitly):

| Surface | Approve | Deny | Cancel | Timeout | Illegal-State | Daemon-Down |
|---------|---------|------|--------|--------|--------------|-------------|
| Normal CLI wait/submit | 0 | 1 | 1 | nonzero (defined) | 2 | nonzero |
| Claude hook shim | 0 (JSON `decision.behavior="allow"`) | 0 (JSON `decision.behavior="deny"`) | 0 (JSON) | 0 (JSON) | 0 (JSON) | 0 (JSON error) |

**Add missing exit-code rows**: daemon unavailable, daemon crashed while waiting, malformed daemon response, port occupied by non-daemon, protocol/schema mismatch, `clear --force` while active/idle, storage failure, invalid/malformed stdin for hook shim.

### Verdict consumption semantics

**Replace "state broadcast vs FIFO" with**:
> "Are verdicts addressed to a request ID and broadcast to all waiters subscribed to that request, or are they global daemon state?"

ADR: Verdict broadcast — both original submitter AND any `plannotator wait` callers receive verdict. Tests must pin down:
- Two waiters blocked before approval: both receive same verdict
- Original submitter plus one explicit waiter both receive same verdict  
- Waiter started after verdict resolution either receives buffered verdict OR exits idle (contract must specify which)
- After all eligible waiters receive verdict, state becomes idle
- Later unrelated wait does NOT receive stale verdict

### Daemon crash recovery semantics

**Separate client death from daemon death**. Current `SIGKILL submitter CLI` tests answer client-death recovery, NOT daemon-death recovery.

Add daemon-kill cases:
- Active submitter waiting, daemon receives `SIGKILL`
- Separate `plannotator wait` waiting, daemon receives `SIGKILL`
- Daemon killed after verdict is written but before waiters receive it
- Daemon killed before verdict persistence
- CLI behavior when reconnect/autostart happens vs when it exits with daemon-down

### `PLANNOTATOR_HOME` honored or not

Define whether it is daemon-start-time configuration or per-invocation configuration. Critical test: 
- Daemon started with `PLANNOTATOR_HOME=A`
- CLI invoked with `PLANNOTATOR_HOME=B`
- Expected behavior: reject, connect only if same home, or route by home

### `--no-browser` flag existence

Decide whether it is public CLI contract. If yes, test: help text mentions it, no browser launched, output includes URL, works in headless/CI. If no, add to deletion/staleness checks.

### Recovery command string for §3.2.4

Require both human and JSON forms:
- Human stderr includes `plannotator clear --force`
- `--json` includes `"recoveryCommand": "plannotator clear --force"`
- **Command must be executable and must recover the daemon**: exits successfully, daemon state becomes idle, subsequent submit succeeds, pending waiters receive deterministic cancelled/cleared result

### `apps/pi-extension/` final fate

Deletion test already decides its fate: it must not exist. Remove from open questions.

### Signal behavior (§7.6, §3.2)

Add signal handling tests:
- CLI waiting receives `SIGINT` → exit 130
- Daemon state after submitter `SIGINT`
- Hook shim receives interrupted stdin / broken pipe
- Daemon receives `SIGTERM` during active request

### Fixed-port ownership tests

Add if not elsewhere: port `19432` occupied by non-Plannotator process; stale daemon metadata; second daemon start; CLI connecting to daemon started from different sandbox/home.

## ChatGPT Review Summary (2026-05-04)

Key feedback incorporated above:
1. **Daemon crash NOT tested** — `07-wait-recovery.spec.ts` kills submitter CLI, not daemon. Need explicit daemon-kill cases.
2. **Verdict broadcast semantics unclear** — must pin down exact multi-waiter behavior.
3. **Request identity under concurrency** — `13-claude-hook-shim.spec.ts` needs assertions: first hook not overwritten, first hook still receives verdict, second hook's plan not persisted as active.
4. **Recovery command must be EXECUTED** — not just assert string appears.
5. **Split exit codes** — CLI vs hook contract are different (CLI exits 1 on deny, hook exits 0 with JSON envelope).
6. **Split `07-wait-recovery.spec.ts`** into `07-wait-broadcast.spec.ts` and `08-crash-recovery.spec.ts`.
7. **Add `15-concurrency.spec.ts`** for cross-surface concurrency tests.
8. **Highest-impact additions**: daemon-kill tests, executable recovery command tests, multi-waiter broadcast tests, request identity/non-overwrite tests, fixed-port/wrong-daemon tests.

## Activity Log

- 2026-05-02T04:03:09.139Z: created
- 2026-05-04T06:30:00.000Z: updated with ChatGPT feedback — added daemon crash tests, clarified verdict broadcast semantics, split exit code tables, added concurrency spec, added P0 for verdict delivery contract violation
