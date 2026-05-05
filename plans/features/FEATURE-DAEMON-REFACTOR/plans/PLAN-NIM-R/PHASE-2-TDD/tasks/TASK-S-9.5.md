---
id: TASK-S-9.5
trackerStatus:
  type: task
title: S-9.5 Create real end-to-end proof harness and TDD phase
description: 'Create the umbrella testing policy and shared proof-harness direction
  for the sprint.  Role of this task:'
successCriteria:
- The shared proof policy explicitly requires real fixtures, real commands, real servers, and real user-visible workflows instead of mocks as terminal evidence.
- Per-slice TDD tasks [[TASK-TDD-S-1]] through [[TASK-TDD-S-9]] inherit one consistent proof-writing standard and handoff rule.
- The reusable harness and fixture direction cover daemon lifecycle, review, annotate, buffered verdict recovery, and GUI-visible correctness.
- Later verification work can execute the accepted proof phase without redefining the proof standard late in the sprint.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2-TDD
status: needs-review
parents:
- '[[PHASE-2-TDD]]'
dependsOn:
- '[[TASK-S-2]]'
- '[[TASK-S-3]]'
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
---

## Description
- Define the real end-to-end proof standard for the sprint.
- Establish the no-mocks, no-fake-data, real-fixtures, real-commands, real-servers policy.
- Provide the shared acceptance and proof-writing constraints that the per-slice TDD tasks must follow.
- This is not the only testing task. The sprint also requires paired TDD tasks for each implementation slice: [[TASK-TDD-S-1]] through [[TASK-TDD-S-9]].

Requirements:
- No mocks, no faked data, no synthetic substitute backends, and no tests that only prove internal consistency or glue wiring.
- Use real fixtures, real use cases, real logic, real servers, and real commands.
- Cover the actual daemon, CLI, browser-facing flows, review flows, recovery paths, and end-to-end interactions that matter to users.
- Prioritize acceptance proofs for GUI-visible correctness and real workflow behavior, not just unit-level invariants.

Process constraints:
- Testing is a separate task from writing.
- The authoring of the proof harness and acceptance tests must be separated from the implementation-writing phase.
- After the proof tasks are written and handed off, implementation writers may not modify those tests. Fixes must be made in production code until the proofs pass.
- Any expansion of test scope after handoff must be treated as explicit new testing work, not folded into implementation silently.

Deliverables:
- Shared proof-writing rules and reusable fixture direction for plan review, review mode, annotate mode, daemon lifecycle, buffered verdict recovery, and visible GUI outcomes.
- A repeatable way to run real end-to-end checks locally with actual commands.
- A clear phase the later verification task can execute without rewriting the proof definition late in the sprint.

Why this exists:
- GUI correctness and workflow correctness are hard to validate by late ad hoc tests. This task establishes the standard that the paired TDD tasks and the final verification task must enforce.
## Activity Log

- 2026-04-29T04:12:52.266Z: created
- 2026-04-29T04:16:08.378Z: updated (description) -> Parent plan: [[PLAN-NIM-R]]

Create the umbrella testing policy and shared proof-harness direction for the sprint.

Role of this task:
- Define the real end-to-end proof standard for the sprint.
- Establish the no-mocks, no-fake-data, real-fixtures, real-commands, real-servers policy.
- Provide the shared acceptance and proof-writing constraints that the per-slice TDD tasks must follow.
- This is not the only testing task. The sprint also requires paired TDD tasks for each implementation slice: [[TASK-TDD-S-1]] through [[TASK-TDD-S-9]].

Requirements:
- No mocks, no faked data, no synthetic substitute backends, and no tests that only prove internal consistency or glue wiring.
- Use real fixtures, real use cases, real logic, real servers, and real commands.
- Cover the actual daemon, CLI, browser-facing flows, review flows, recovery paths, and end-to-end interactions that matter to users.
- Prioritize acceptance proofs for GUI-visible correctness and real workflow behavior, not just unit-level invariants.

Process constraints:
- Testing is a separate task from writing.
- The authoring of the proof harness and acceptance tests must be separated from the implementation-writing phase.
- After the proof tasks are written and handed off, implementation writers may not modify those tests. Fixes must be made in production code until the proofs pass.
- Any expansion of test scope after handoff must be treated as explicit new testing work, not folded into implementation silently.

Deliverables:
- Shared proof-writing rules and reusable fixture direction for plan review, review mode, annotate mode, daemon lifecycle, buffered verdict recovery, and visible GUI outcomes.
- A repeatable way to run real end-to-end checks locally with actual commands.
- A clear phase the later verification task can execute without rewriting the proof definition late in the sprint.

Why this exists:
- GUI correctness and workflow correctness are hard to validate by late ad hoc tests. This task establishes the standard that the paired TDD tasks and the final verification task must enforce.
- 2026-05-01T22:21:08.619Z: status_changed (status) -> in-progress
- 2026-05-02T03:37:01.210Z: status_changed (status) -> needs-review
- 2026-05-02T03:37:01.210Z: updated (progress) -> 100
