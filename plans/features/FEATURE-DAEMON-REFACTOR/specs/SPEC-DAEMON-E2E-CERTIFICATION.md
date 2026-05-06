---
id: SPEC-DAEMON-E2E-CERTIFICATION
trackerStatus:
  type: spec
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
dependsOn: []
title: Daemon refactor E2E certification spec
status: in-progress
priority: critical
requirement: The daemon refactor must be accepted only after a built Plannotator artifact
  satisfies the daemon lifecycle, singleton state, submit/wait/clear, crash recovery,
  CLI, hook, plugin, storage, UI, packaging, and deleted-surface contracts.
acceptanceCriteria:
- The E2E harness builds the binary, creates isolated state, starts and stops the
  daemon, submits real fixtures, drives the UI/API, and cleans up daemon processes.
- Verdict delivery, crash recovery, exit codes, state-directory routing, signal behavior,
  and concurrent submission behavior are specified before dependent E2E assertions
  are accepted.
- Cross-surface tests cover lifecycle, state machine, submit/wait/clear, review, annotate,
  storage, UI actions, JSON output, Claude hook behavior, OpenCode plugin behavior,
  packaging, deleted surfaces, and composed full-scenario behavior.
- Final verification runs from the built CLI/binary from empty state and leaves no daemon
  process or contaminated state behind.
tags:
- FEATURE-DAEMON-REFACTOR
---

## Requirement

The daemon refactor is a correctness-critical feature. Acceptance requires executable evidence that the local daemon model works end to end for shell users, Claude Code hooks, and OpenCode plugin calls.

The detailed test inventory lives in the phase and task cards under [[PLAN-NIM-R]]. This spec records the cross-cutting release contract that plan must satisfy.

## Contract Precedence

Use this precedence order when a test or implementation detail conflicts:

- [[FEATURE-DAEMON-REFACTOR]] defines the feature boundary and non-goals.
- This spec defines the release contract and proof obligations.
- Semantic decision cards define still-open behavior such as exit codes, verdict delivery, crash recovery, state directory routing, signal handling, and concurrent submissions.
- E2E task cards define the executable proof inventory.

## Required Behavior

- The daemon exposes one local singleton review slot and rejects concurrent submissions deterministically.
- The CLI exposes daemon lifecycle, submit, review, annotate, wait, clear, and open commands with stable human and JSON output.
- Browser actions transition daemon state through approve, deny, cancel, feedback, upload, and draft flows without per-invocation server shutdown.
- Waiting clients receive verdicts according to the accepted [[TASK-D2]] contract.
- Crashes, signals, stale lockfiles, port conflicts, and mismatched state directories follow the accepted [[TASK-D3]], [[TASK-D4]], and [[TASK-D5]] contracts.
- Claude Code and OpenCode wrappers call the CLI and preserve their protocol-specific envelopes.
- Removed remote/share surfaces stay absent from code, docs, package scripts, and UI.

## Required Semantic Contracts

The E2E suite must pin down these contracts before release:

- CLI exit codes and Claude hook JSON-envelope behavior for approve, deny, cancel, timeout, illegal state, daemon unavailable, daemon crash, malformed daemon response, port collision, schema mismatch, forced clear, storage failure, and malformed hook stdin.
- Verdict delivery by request identity: eligible waiters for the same request receive the same verdict, unrelated later waits do not receive stale verdicts, and verdicts are never lost, duplicated to unrelated commands, or delivered to the wrong waiter.
- Daemon crash behavior while submitters or waiters are blocked, after verdict persistence, before verdict persistence, and during reconnect or autostart.
- `PLANNOTATOR_HOME` routing when daemon and client invocations use different state directories.
- Public `--no-browser` behavior if the flag remains part of the CLI contract.
- Recovery command behavior: human stderr and JSON output include an executable recovery command, and running it actually restores the daemon to a usable state.
- Signal behavior for waiting CLIs, active submitters, hook stdin interruption, broken pipes, and daemon termination during active or verdict-ready states.
- Fixed-port ownership when a non-Plannotator process occupies the port, stale daemon metadata exists, a second daemon starts, or a client reaches a daemon from the wrong state directory.

## Proof Surface

The certification suite must use real artifacts and observable outcomes:

- Build the CLI/binary before daemon E2E tests.
- Spawn real daemon processes and assert their PID, port, lockfile, and cleanup behavior.
- Drive real HTTP endpoints on `localhost`.
- Use real markdown, plan, git, and browser fixtures.
- Assert stdout, stderr, exit codes, JSON shapes, state files, git history, draft files, DOM behavior, and process cleanup.
- Run daemon tests serially where fixed port or singleton state makes parallelism unsafe.

## Certification Groups

The executable certification inventory must cover:

- Binary surface and packaging gates.
- Daemon lifecycle, state machine, submit, wait, clear, crash recovery, and storage behavior.
- Review, annotate, UI actions, image upload, cancel, reset, and draft behavior.
- JSON output schema lock for programmatic consumers.
- Claude Code hook shim and OpenCode plugin contract behavior.
- Deleted-surface and documentation consistency checks.
- Full scenario coverage that composes the earlier specs.

## Verification Coverage

[[PLAN-NIM-R]] currently owns execution. [[PHASE-3]] and its `TASK-E*` children own the cross-surface E2E proof inventory. [[PHASE-4]] owns final built-artifact verification.

## Release Gate

The release gate is [[PHASE-4]]. It must run after the semantic, infrastructure, implementation, and E2E phases are accepted. Passing means the built artifact satisfies the daemon contract from empty state twice, without hidden mocks, stale daemon processes, or remote-surface regressions.

## Open Decision Dependencies

This spec remains `in-progress` while any Phase 0 semantic card is unresolved. E2E specs may be drafted before those decisions close, but they must reference the accepted decision cards before they can become release-blocking proof.
