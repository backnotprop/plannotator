---
id: NIM-11
trackerStatus:
  type: task
title: S-10 Run manual and automated verification for the daemon model
status: in-review
priority: high
tags:
- plannotator
- daemon-refactor
- verification
progress: 100
parents:
- PHASE-4
dependsOn:
- NIM-9
- NIM-10
- NIM-13
- NIM-14
- NIM-15
- NIM-16
- NIM-17
- NIM-18
- NIM-19
- NIM-20
- NIM-21
- PHASE-2
---

## Description

Parent phase: Phase 4 (Final integration verification). 
Execute the manual and automated checks that prove the daemon model works end to end.

Verification rules:
- This task consumes the umbrella proof policy from NIM-12 and the paired proof tasks for each implementation slice rather than inventing late test coverage after implementation.
- No mocks, no faked data, no substitute backends, and no tests that only prove internal consistency.
- Validation must run real fixtures, real commands, real servers, and real user-visible workflows.
- Implementation writers do not modify the frozen proof suites after handoff; production code must be corrected until the proofs pass.

Manual smoke tests, in order:
1. `plannotator daemon status` returns `not running`.
2. `plannotator daemon start` prints port and URL.
3. `plannotator daemon status` returns `running, idle`.
4. `plannotator submit example-plan.md` from a second terminal fires a notification, opens the browser, blocks the CLI, and exits 0 after browser approval.
5. Repeat the submit flow but deny with feedback; CLI exits 1 and prints feedback.
6. Submit while a previous document is still in review; the second submit returns structured 409 current-doc info and exits 2.
7. Kill the agent CLI mid-review, approve in the browser, then run `plannotator wait` from a fresh terminal; it prints the buffered verdict, exits 0, and returns the daemon to idle.
8. Kill the daemon mid-review with `kill -9`, restart it with `plannotator daemon start`, verify recovery as `verdict_ready` with `cancelled`, then consume via `plannotator wait`.
9. Run `plannotator clear --force` from any non-idle state and verify it resets to idle.
10. Run the Claude Code end-to-end flow and confirm the hook shells out to the CLI and verdicts flow back correctly.
11. Run the OpenCode end-to-end flow and confirm `submit_plan` is serviced through the daemon model.

Automated verification:
- Run the real end-to-end proof harness from NIM-12.
- Run the paired TDD suites for NIM-2 through NIM-10.
- Run state-machine unit tests from the daemon state module.
- Run daemon-lifecycle integration coverage that spawns the daemon, exercises the endpoints, and verifies state transitions.

Pass criteria:
- Lifecycle, collision, buffering, recovery, GUI-visible behavior, and integration behavior all match the sprint plan.
- Regressions in daemon wait semantics or state transitions are caught by real proofs and integration checks rather than by users.

## Activity Log

- 2026-04-29T02:30:40.848Z: created
- 2026-04-29T02:34:17.868Z: updated (description) -> Parent plan: NIM-1

Execute the manual and automated checks that prove the daemon model works end to end.

Manual smoke tests, in order:
1. `plannotator daemon status` returns `not running`.
2. `plannotator daemon start` prints port and URL.
3. `plannotator daemon status` returns `running, idle`.
4. `plannotator submit example-plan.md` from a second terminal fires a notification, opens the browser, blocks the CLI, and exits 0 after browser approval.
5. Repeat the submit flow but deny with feedback; CLI exits 1 and prints feedback.
6. Submit while a previous document is still in review; the second submit returns structured 409 current-doc info and exits 2.
7. Kill the agent CLI mid-review, approve in the browser, then run `plannotator wait` from a fresh terminal; it prints the buffered verdict, exits 0, and returns the daemon to idle.
8. Kill the daemon mid-review with `kill -9`, restart it with `plannotator daemon start`, verify recovery as `verdict_ready` with `cancelled`, then consume via `plannotator wait`.
9. Run `plannotator clear --force` from any non-idle state and verify it resets to idle.
10. Run the Claude Code end-to-end flow and confirm the hook shells out to the CLI and verdicts flow back correctly.
11. Run the OpenCode end-to-end flow and confirm `submit_plan` is serviced through the daemon model.

Automated verification:
- State-machine unit tests from the daemon state module.
- Daemon-lifecycle integration coverage that spawns the daemon, exercises the endpoints, and verifies state transitions.

Pass criteria:
- Lifecycle, collision, buffering, recovery, and integration behavior all match the sprint plan.
- Regressions in daemon wait semantics or state transitions are caught by tests rather than by users.
- 2026-04-29T03:12:03.341Z: updated (complexityScore) -> 57
- 2026-04-29T04:13:38.267Z: updated (description) -> Parent plan: NIM-1

Execute the manual and automated checks that prove the daemon model works end to end.

Verification rules:
- This task consumes the proof harness defined in NIM-12 rather than inventing late test coverage after implementation.
- No mocks, no faked data, no substitute backends, and no tests that only prove internal consistency.
- Validation must run real fixtures, real commands, real servers, and real user-visible workflows.
- Implementation writers do not modify the frozen proof suite after handoff; production code must be corrected until the proofs pass.

Manual smoke tests, in order:
1. `plannotator daemon status` returns `not running`.
2. `plannotator daemon start` prints port and URL.
3. `plannotator daemon status` returns `running, idle`.
4. `plannotator submit example-plan.md` from a second terminal fires a notification, opens the browser, blocks the CLI, and exits 0 after browser approval.
5. Repeat the submit flow but deny with feedback; CLI exits 1 and prints feedback.
6. Submit while a previous document is still in review; the second submit returns structured 409 current-doc info and exits 2.
7. Kill the agent CLI mid-review, approve in the browser, then run `plannotator wait` from a fresh terminal; it prints the buffered verdict, exits 0, and returns the daemon to idle.
8. Kill the daemon mid-review with `kill -9`, restart it with `plannotator daemon start`, verify recovery as `verdict_ready` with `cancelled`, then consume via `plannotator wait`.
9. Run `plannotator clear --force` from any non-idle state and verify it resets to idle.
10. Run the Claude Code end-to-end flow and confirm the hook shells out to the CLI and verdicts flow back correctly.
11. Run the OpenCode end-to-end flow and confirm `submit_plan` is serviced through the daemon model.

Automated verification:
- Run the real end-to-end proof harness from NIM-12.
- Run state-machine unit tests from the daemon state module.
- Run daemon-lifecycle integration coverage that spawns the daemon, exercises the endpoints, and verifies state transitions.

Pass criteria:
- Lifecycle, collision, buffering, recovery, GUI-visible behavior, and integration behavior all match the sprint plan.
- Regressions in daemon wait semantics or state transitions are caught by real proofs and integration checks rather than by users.
- 2026-04-29T04:16:27.007Z: updated (description) -> Parent plan: NIM-1

Execute the manual and automated checks that prove the daemon model works end to end.

Verification rules:
- This task consumes the umbrella proof policy from NIM-12 and the paired proof tasks for each implementation slice rather than inventing late test coverage after implementation.
- No mocks, no faked data, no substitute backends, and no tests that only prove internal consistency.
- Validation must run real fixtures, real commands, real servers, and real user-visible workflows.
- Implementation writers do not modify the frozen proof suites after handoff; production code must be corrected until the proofs pass.

Manual smoke tests, in order:
1. `plannotator daemon status` returns `not running`.
2. `plannotator daemon start` prints port and URL.
3. `plannotator daemon status` returns `running, idle`.
4. `plannotator submit example-plan.md` from a second terminal fires a notification, opens the browser, blocks the CLI, and exits 0 after browser approval.
5. Repeat the submit flow but deny with feedback; CLI exits 1 and prints feedback.
6. Submit while a previous document is still in review; the second submit returns structured 409 current-doc info and exits 2.
7. Kill the agent CLI mid-review, approve in the browser, then run `plannotator wait` from a fresh terminal; it prints the buffered verdict, exits 0, and returns the daemon to idle.
8. Kill the daemon mid-review with `kill -9`, restart it with `plannotator daemon start`, verify recovery as `verdict_ready` with `cancelled`, then consume via `plannotator wait`.
9. Run `plannotator clear --force` from any non-idle state and verify it resets to idle.
10. Run the Claude Code end-to-end flow and confirm the hook shells out to the CLI and verdicts flow back correctly.
11. Run the OpenCode end-to-end flow and confirm `submit_plan` is serviced through the daemon model.

Automated verification:
- Run the real end-to-end proof harness from NIM-12.
- Run the paired TDD suites for NIM-2 through NIM-10.
- Run state-machine unit tests from the daemon state module.
- Run daemon-lifecycle integration coverage that spawns the daemon, exercises the endpoints, and verifies state transitions.

Pass criteria:
- Lifecycle, collision, buffering, recovery, GUI-visible behavior, and integration behavior all match the sprint plan.
- Regressions in daemon wait semantics or state transitions are caught by real proofs and integration checks rather than by users.
- 2026-05-02T03:37:01.926Z: status_changed (status) -> in-review
- 2026-05-02T03:37:01.926Z: updated (progress) -> 100
