---
id: PLAN-NIM-R
trackerStatus:
  type: plan
parents:
- '[[FEATURE-DAEMON-REFACTOR]]'
title: Daemon implementation and verification plan
description: Implementation plan for [[FEATURE-DAEMON-REFACTOR]]. This plan sequences
  semantic decisions, E2E infrastructure, implementation slices, cross-slice E2E specs,
  and final built-artifact verification.
successCriteria:
- Semantic contracts are approved before implementation or E2E assertions depend on them.
- E2E infrastructure can certify built artifacts with isolated daemon state.
- Implementation slices satisfy their proof obligations without inventing behavior outside the feature/spec contract.
- Cross-slice E2E certification proves the daemon workflow from real binaries, real processes, and real browser/API surfaces.
- Final verification passes twice from empty state and leaves no daemon process or contaminated state.
tags:
- FEATURE-DAEMON-REFACTOR
status: complete
dependsOn: []
phases:
- '[[PHASE-0]]'
- '[[PHASE-1]]'
- '[[PHASE-2]]'
- '[[PHASE-2-TDD]]'
- '[[PHASE-3]]'
- '[[PHASE-4]]'
---

# Feature Plan: Daemon Refactor

## Goal

The daemon refactor is releasable when Plannotator has one stable local daemon workflow, a CLI and wrapper surface that route through that daemon, deterministic recovery behavior, removed remote-sharing surfaces, and built-artifact E2E evidence that the system works from clean state.

## Non-Goals

- Redefining the feature boundary, public daemon contract, or release proof contract owned by the feature and spec cards.
- Reintroducing remote collaboration, share links, paste services, public portals, or multi-user review state.
- Treating mocks, package-level smoke tests, or source-only tests as terminal release certification.
- Authoring atomic task cards inside this plan; phase cards own task expansion.

## Planning Assumptions

- The accepted architecture is a local, single-user daemon with one active review slot.
- Public behavior must be settled in feature-level decision cards before implementation or E2E tasks encode it.
- Proof design and implementation remain separate planning concerns because tests must be reviewable before implementation is accepted.
- Integration certification must exercise the built artifact and real daemon/browser/API surfaces.

## Structural Rules

- TDD blocks only its implementation slice. Proof definition and implementation are coupled locally, but one slice's proof does not serialize unrelated slices.
- Semantic decisions block the phases and tasks that encode those semantics. E2E certification must cite accepted contracts rather than infer behavior during test writing.
- Integration E2E work has multiple dependency sources. A cross-surface proof can depend on semantic contracts, implementation surfaces, and E2E infrastructure at the same time.
- Completion has a single terminal meaning. The plan is not satisfied by passing unit tests alone; completion requires fresh E2E verification from built artifacts.

## Phase Overview

This plan turns [[FEATURE-DAEMON-REFACTOR]] and [[SPEC-DAEMON-E2E-CERTIFICATION]] into six implementation phases. Each phase has a distinct planning purpose: settle contracts, create proof infrastructure, define slice proofs, implement slices, certify integration, and verify release readiness.

| Phase | Outcome | Depends on | Blocks |
|-------|---------|------------|--------|
| [[PHASE-0]] | All behavior that affects user-visible daemon semantics has an accepted observable contract. | Approved feature/spec cards and [[DECISION-D1]]-[[DECISION-D6]]. | Proof design, implementation, and E2E assertions that encode daemon behavior. |
| [[PHASE-1]] | The repository has a real E2E harness that can build, launch, drive, and clean up the daemon artifact. | Approved release proof contract. | Cross-slice E2E certification and final release verification. |
| [[PHASE-2-TDD]] | Each implementation slice has proof obligations that fail on missing behavior and pass only on accepted behavior. | [[PHASE-0]] for behavior semantics and [[PHASE-1]] where slice proofs need harness support. | [[PHASE-2]] acceptance for the corresponding implementation slices. |
| [[PHASE-2]] | The daemon, CLI, wrappers, local storage, and packaging surfaces satisfy the accepted contracts through implementation slices. | [[PHASE-0]] and the relevant [[PHASE-2-TDD]] proof definitions. | Cross-slice E2E certification and final release verification. |
| [[PHASE-3]] | Integrated E2E proofs certify the daemon workflow across lifecycle, state, CLI, browser, wrappers, persistence, packaging, and deleted surfaces. | [[PHASE-0]], [[PHASE-1]], [[PHASE-2-TDD]], and [[PHASE-2]]. | [[PHASE-4]]. |
| [[PHASE-4]] | The terminal release gate passes from built artifacts and clean daemon state twice. | All prior phases. | Release acceptance. |

## [[PHASE-0]] - Semantic Contracts

### Outcome

Every downstream implementation or E2E task can cite an accepted daemon contract instead of inferring behavior from current code, prior plans, or agent assumptions.

### Scope

In scope:
- CLI and hook-shim exit codes.
- Verdict broadcast, wait-consumption, and request identity semantics.
- Crash recovery, stale daemon metadata, state-directory routing, signals, and concurrent submission behavior.
- Observable inputs, outputs, state transitions, persistence effects, and recovery commands for those behaviors.

Out of scope:
- Implementing the daemon internals.
- Building the E2E harness except where a behavior must be made observable for contract review.
- Browser UI polish, packaging changes, or wrapper rewrites.

### Todo Clusters

- Inventory all daemon behaviors that downstream work would otherwise infer.
- Convert exit-code and error-envelope behavior into an explicit contract for CLI, hook, and JSON consumers.
- Define verdict delivery, multi-waiter behavior, stale verdict handling, and request identity rules.
- Define crash, stale metadata, state-directory, signal, and fixed-port recovery behavior.
- Define concurrent submission behavior for CLI and agent-wrapper callers.
- Review contracts against the feature and spec, rejecting unresolved decision language.
- Map each accepted contract to the implementation and E2E proof surfaces that must encode it.

### Dependencies

Depends on:
- The approved feature boundary and release proof spec.

Blocks:
- Slice proof definitions and implementations that encode daemon behavior.
- E2E certification assertions for lifecycle, state, wait, recovery, JSON, hook, and plugin behavior.

### Validation Expectations

- Contract review shows every covered behavior has observable preconditions, inputs, outputs, state effects, persistence effects, and recovery behavior.
- Downstream proof plans cite named contracts instead of inventing semantics.
- No accepted implementation or E2E task contains unresolved product or API decision language for these behaviors.

### Risks / Blocking Decisions

- [[DECISION-D1]] blocks exit-code and hook-envelope contracts.
- [[DECISION-D2]] blocks verdict delivery, multi-waiter behavior, stale-verdict handling, and request identity contracts.
- [[DECISION-D3]] blocks crash recovery and daemon durability contracts.
- [[DECISION-D4]] blocks state-directory routing and fixed-port ownership contracts.
- [[DECISION-D5]] blocks signal-handling contracts.
- [[DECISION-D6]] blocks concurrent submission contracts.

## [[PHASE-1]] - E2E Infrastructure

### Outcome

The repository can certify Plannotator by building the artifact, creating isolated daemon state, starting and stopping real daemon processes, driving real fixtures and browser/API surfaces, and proving cleanup without ad hoc harness work in later phases.

### Scope

In scope:
- Built-artifact creation for E2E tests.
- Isolated `PLANNOTATOR_HOME` setup and teardown.
- Real daemon process lifecycle helpers.
- Fixture submission, browser/API driving, and cleanup assertions.
- Serial execution support for singleton daemon and fixed-port cases.

Out of scope:
- Completing the full daemon implementation.
- Encoding unresolved daemon semantics as test expectations.
- Replacing release certification with mocks or source-only smoke tests.

### Todo Clusters

- Define the harness entry points for building and locating the test artifact.
- Provide isolated state creation, fixture loading, daemon startup, readiness, termination, and cleanup utilities.
- Prove the binary surface can be inspected before daemon tests run.
- Establish conventions for serial daemon tests and fixed-port/state contamination checks.
- Add failure diagnostics that expose leaked processes, contaminated state, and unreachable daemon ports.
- Document which later proof areas may reuse the harness and which remain phase-local.

### Dependencies

Depends on:
- The release proof spec's requirement to use real artifacts and observable outcomes.

Blocks:
- Cross-slice E2E certification.
- Final release verification.

### Validation Expectations

- Harness smoke tests repeatedly build or locate the artifact, start the daemon, reach it, submit a fixture, terminate it, and confirm cleanup.
- Binary-surface checks run against the same artifact family later E2E tests will use.
- Harness tests fail on leaked daemon processes or state contamination.

### Risks / Blocking Decisions

- Detached process handling and cleanup may be platform-sensitive.
- Fixed-port tests must not make unrelated tests flaky or parallel-unsafe.
- Harness helpers must not quietly fall back to source execution when release proof requires built artifacts.

## [[PHASE-2-TDD]] - Slice Proof Design

### Outcome

Each implementation slice has an accepted proof obligation that can fail before the slice exists and pass only when the intended behavior satisfies the feature, spec, and semantic contracts.

### Scope

In scope:
- Proof requirements for remote-surface deletion, daemon state, routing, lifecycle, submit/wait/clear, CLI, notifications, agent wrappers, and packaging.
- Expected failure modes for old behavior where applicable.
- Slice-local validation surfaces that implementation work must satisfy.
- Shared testing policy for proof-first work.

Out of scope:
- Implementing the slices.
- Writing cross-slice E2E certification as the final release gate.
- Deciding product behavior that belongs in semantic contracts.

### Todo Clusters

- Define a shared proof-first policy for implementation slices.
- For each slice, identify the behavior that must be proven before implementation can be accepted.
- Separate slice-local proof from cross-slice E2E certification so responsibilities do not blur.
- Ensure each proof targets observable behavior rather than implementation structure.
- Include negative or regression coverage where removed or illegal behavior is part of the contract.
- Review proof tasks for weak assertions, mocks that hide correctness gaps, and unresolved decision language.

### Dependencies

Depends on:
- [[PHASE-0]] for accepted behavior semantics.
- [[PHASE-1]] where a slice proof needs built-artifact or daemon harness support.

Blocks:
- Acceptance of the corresponding implementation slice in [[PHASE-2]].
- [[PHASE-3]] where E2E proofs rely on slice-local guarantees.

### Validation Expectations

- Each proof can be run independently enough to guide its slice implementation.
- Each proof fails for missing or old behavior where that is meaningful.
- Proof review confirms no test was weakened to accommodate incomplete implementation.

### Risks / Blocking Decisions

- Proof tasks can become too implementation-specific if they name private functions instead of observable behavior.
- Proof tasks can become too weak if they assert only that code paths execute, rather than proving contract outcomes.
- Slice proofs that depend on unresolved daemon behavior remain blocked by the relevant feature-level decision card.

## [[PHASE-2]] - Implementation Slices

### Outcome

The daemon implementation exposes the required local operation, CLI, wrapper, persistence, packaging, and recovery surfaces, and each slice satisfies the accepted semantic contracts and its proof obligations.

### Scope

In scope:
- Removing obsolete remote collaboration surface area.
- Creating the daemon state model and multiplexed router.
- Implementing daemon lifecycle, submit, wait, state, clear, and recovery paths.
- Defining the public CLI and local notification behavior.
- Converting Claude Code and OpenCode integrations into thin daemon-backed clients.
- Aligning build and packaging around the daemon-plus-CLI artifact.

Out of scope:
- Changing the approved feature boundary or release proof contract.
- Treating implementation success as release completion without cross-slice E2E certification.
- Adding new public behavior not accepted by feature, spec, or semantic contract cards.

### Todo Clusters

- Remove deleted remote/share surfaces from code, docs, package scripts, and UI.
- Route daemon state transitions through one explicit model instead of ad hoc process or global state behavior.
- Route plan, review, annotate, submit, wait, state, clear, and verdict paths through the daemon contract.
- Establish daemon lifecycle behavior for start, stop, status, foreground, stale lock recovery, and fixed-port ownership.
- Make CLI output, JSON output, and exit-code behavior consistent with accepted contracts.
- Convert agent integrations into thin wrappers around the CLI while preserving protocol-specific envelopes.
- Preserve storage, draft, upload, history, and editor integration behavior under the daemon model.
- Update build and packaging so the releasable artifact exposes the intended command surface.

### Dependencies

Depends on:
- [[PHASE-0]] for behavior contracts.
- [[PHASE-2-TDD]] for the proof obligations attached to each slice.
- [[PHASE-1]] where implementation validation needs harness support.

Blocks:
- Cross-slice E2E certification.
- Final release verification.

### Validation Expectations

- Slice-local proof obligations pass without weakening tests.
- Unit and integration coverage proves legal transitions, rejected transitions, CLI/API agreement, and removed-surface regressions.
- Implementation review confirms no new public contract was invented during coding.

### Risks / Blocking Decisions

- Browser-side assumptions may depend on one fresh random port per invocation.
- Wrapper code may hide daemon errors unless CLI JSON and hook envelopes are explicitly preserved.
- Packaging can pass source-level tests while still shipping stale or incomplete built artifacts.

## [[PHASE-3]] - Cross-Slice E2E Certification

### Outcome

Integrated E2E proofs certify the daemon workflow as one system across lifecycle, singleton state, submit/wait/clear, review, annotate, storage, UI, JSON, Claude hook, OpenCode plugin, packaging, and deleted-surface behavior.

### Scope

In scope:
- Built-artifact E2E tests that compose multiple implementation slices.
- Lifecycle, state machine, submit/wait/clear, crash recovery, history/storage, UI, JSON, hook, plugin, packaging, and deleted-surface proof areas.
- Dependency mapping from semantic contracts and implementation slices to E2E proofs.
- Failure-path and illegal-state tests required by the release proof contract.

Out of scope:
- Implementing missing slice behavior except through explicit return to [[PHASE-2]].
- Accepting expected-failing E2E specs as release evidence.
- Rewriting the harness except for fixes needed to keep certification faithful.

### Todo Clusters

- Define E2E proof areas that cover binary surface, daemon lifecycle, state, submit/wait/clear, review, annotate, storage, UI, JSON, hooks, plugins, packaging, and deleted surfaces.
- Map each proof area to the semantic contracts and implementation surfaces it depends on.
- Ensure concurrency and stale-verdict behavior are covered by the proof areas that expose them.
- Add failure-path coverage before accepting happy-path-only certification.
- Run E2E specs from clean state and ensure process/state cleanup after each relevant scenario.
- Reject or return any expected-failing proof area before release acceptance.

### Dependencies

Depends on:
- [[PHASE-0]] for accepted semantics.
- [[PHASE-1]] for the E2E harness.
- [[PHASE-2-TDD]] for slice proof expectations.
- [[PHASE-2]] for implemented surfaces.

Blocks:
- Final release verification.

### Validation Expectations

- E2E proofs run against built artifacts and real daemon/browser/API surfaces.
- Each proof area can be traced to the contract or implementation surface it certifies.
- Full E2E certification leaves no daemon processes or contaminated state after runs.

### Risks / Blocking Decisions

- E2E tests can accidentally certify source execution rather than the built artifact.
- Cross-slice failures may reveal missing contracts, requiring return to [[PHASE-0]] rather than local test patching.
- Parallel execution can corrupt singleton daemon state unless serial boundaries are explicit.

## [[PHASE-4]] - Final Release Verification

### Outcome

The terminal release gate proves the daemon refactor from clean state and built artifacts twice, with no leaked daemon process, contaminated state, or reintroduced remote surface.

### Scope

In scope:
- Full unit, typecheck, lint, build, slice proof, and E2E verification.
- Built CLI/binary execution from empty daemon state.
- Repeated full-suite execution to catch state leakage.
- Post-run process and state cleanup inspection.
- Final command, docs, packaging, and deleted-surface consistency checks.

Out of scope:
- Adding new features or changing accepted contracts.
- Treating manual inspection as a substitute for failed proof commands.
- Releasing with expected-failing E2E specs or unreviewed P0 findings.

### Todo Clusters

- Build the releasable artifact and confirm the command surface matches the accepted contract.
- Run unit, typecheck, lint, slice proof, and full E2E commands through the repo recipe path.
- Run the full E2E suite from empty daemon state and repeat it to expose leaks.
- Inspect generated artifacts, daemon state, process tables, and persisted files after verification.
- Confirm removed remote surfaces remain absent from commands, docs, packages, and UI.
- Record any blocker as a return to the owning phase rather than patching around the release gate.

### Dependencies

Depends on:
- Acceptance of all prior phases.

Blocks:
- Release acceptance for the daemon refactor.

### Validation Expectations

- The full verification sequence passes twice from empty state.
- No daemon process remains after verification.
- No contaminated daemon state affects the repeated run.
- Deleted remote-surface checks pass against the built artifact and user-facing docs.

### Risks / Blocking Decisions

- A successful first run can mask leaked state that only appears on the repeated run.
- Build output can drift from source tests if packaging copies stale HTML or command assets.
- Any P0 failure at this gate should return to the owning phase instead of being waived.

Operational inputs for the certification pass:

- The compiled binary's `--help` output.
- `README.md` on the active branch as the user-facing contract.
- The daemon HTTP API contract documented by the feature/spec cards and accepted semantic decision cards.
- Fork-specific README changes that define observable behavior.

Stop the plan immediately on these P0 failures:

- Any binary-surface test fails.
- Illegal-state errors do not provide an executable recovery path.
- Daemon crash can leave a CLI waiting indefinitely.
- Concurrent hook or CLI submissions can overwrite active request state, lose data, or hang.
- Approve, deny, or cancel verdicts are lost, delivered to the wrong waiter, delivered twice to unrelated commands, or leave an eligible waiter blocked indefinitely.

## Completion criteria

All phase cards are accepted. No open P0 findings remain. The full E2E suite passes twice in a row from empty `PLANNOTATOR_HOME`. No daemon processes remain after the suite. No remote-surface command remains available.
