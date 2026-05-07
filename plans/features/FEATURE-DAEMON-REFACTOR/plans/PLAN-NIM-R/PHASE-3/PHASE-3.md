---
id: PHASE-3
trackerStatus:
  type: phase
title: 'Phase 3: Cross-slice E2E specs complete'
description: 'Phase: each E2E spec declares its semantic-decision dependencies and
  implementation dependencies. Specs that cover multiple slices are integration specs,
  not assigned to one slice. Expected-failing specs are allowed only before implementation
  acceptance; they must become passing before Phase 3 closes.'
successCriteria:
- Each spec declares its semantic-decision dependencies and implementation dependencies
- Expected-failing specs become passing after implementation acceptance
- Each spec run twice against fresh PLANNOTATOR_HOME
- Failure-path tests run before happy-path-only acceptance
- Serial execution when daemon state or fixed port is involved
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
status: complete
parents:
- PLAN-NIM-R
---
## E2E task inventory

Each task owns one executable E2E proof area.
Status lives in the task card frontmatter; do not copy task status into this phase body.

| Task | Proof area | Test file target |
| --- | --- | --- |
| [[TASK-E01]] | Binary surface, help/version, aliases, deleted flag absence | `tests/e2e/specs/01-binary.spec.ts` |
| [[TASK-E02]] | Daemon lifecycle, singleton behavior, stale PID, port ownership, foreground stop | `tests/e2e/specs/02-daemon-lifecycle.spec.ts` |
| [[TASK-E03]] | State machine legality, illegal transitions, verdict-consumption semantics | `tests/e2e/specs/03-state-machine.spec.ts` |
| [[TASK-E04]] | Submit plan, approve/deny/cancel, annotations, history, no-browser behavior | `tests/e2e/specs/04-submit-plan.spec.ts` |
| [[TASK-E05]] | Review mode, diff matrix, async feedback, git-add behavior | `tests/e2e/specs/05-review-mode.spec.ts` |
| [[TASK-E06]] | Annotate mode, path handling, feedback, cancel, invalid file behavior | `tests/e2e/specs/06-annotate-mode.spec.ts` |
| [[TASK-E07]] | Wait behavior, buffered verdict recovery, multi-waiter behavior, JSON wait output | `tests/e2e/specs/07-wait-recovery.spec.ts` |
| [[TASK-E08]] | Clear contingency for submitter, waiter, daemon, and verdict persistence boundaries | `tests/e2e/specs/08-clear-contingency.spec.ts` |
| [[TASK-E09]] | History, storage, drafts, git side effects, corruption recovery | `tests/e2e/specs/09-history-storage.spec.ts` |
| [[TASK-E10]] | Browser UI actions, sidebar, annotations, review UI, annotate UI, image upload | `tests/e2e/specs/10-ui-actions.spec.ts` |
| [[TASK-E11]] | Cancel, reset, destructive state mutations, signal-driven cancellation | `tests/e2e/specs/11-cancel-and-reset.spec.ts` |
| [[TASK-E12]] | JSON output schemas for submit, review, annotate, wait, errors, and recovery commands | `tests/e2e/specs/12-json-output.spec.ts` |
| [[TASK-E13]] | Claude hook shim, PermissionRequest stdin, concurrent hook identity, error envelopes | `tests/e2e/specs/13-claude-hook-shim.spec.ts` |
| [[TASK-E14]] | OpenCode plugin shim behavior and JSON CLI contract integration | `tests/e2e/specs/14-opencode-shim.spec.ts` |
| [[TASK-E15]] | Packaging, install path, deleted surfaces, stale docs checks, final surface consistency | `tests/e2e/specs/99-deletions-and-doc.spec.ts` |

Concurrency coverage is distributed by surface: multi-waiter behavior belongs to
[[TASK-E07]], concurrent CLI submit belongs to [[TASK-E04]] and [[TASK-E03]], concurrent
Claude hook identity belongs to [[TASK-E13]], and stale verdict isolation belongs to
[[TASK-E03]].

## Phase check

- `bun test tests/e2e/<spec>.spec.ts` for each spec
- Full suite passes
- No daemon processes remain after suite

## Activity Log

- 2026-05-04T08:00:04.000Z: created (unified phase for all 16 E2E specs)
- 2026-05-07T18:00:00.000Z: status_changed (status) -> needs-review (all 15 E-tasks
  reached needs-review)
- 2026-05-07T18:00:00.000Z: updated (spec file refs) -> fixed 07/08/15 filenames to
  match actual specs
