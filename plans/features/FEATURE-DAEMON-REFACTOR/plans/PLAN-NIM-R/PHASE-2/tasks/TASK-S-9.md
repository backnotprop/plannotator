---
id: TASK-S-9
trackerStatus:
  type: task
title: S-9 Update build and packaging around the daemon artifact
description: Align the build and install flow with the single compiled daemon-plus-CLI
  artifact.
successCriteria:
- The compiled daemon-plus-CLI binary is the primary build and install artifact for the repo.
- Removed portal and marketing targets are no longer part of the default build path or install documentation.
- 'End-to-end `plannotator --version` and `plannotator --help` behavior matches the documented install flow.'
- The targeted proof for [[TASK-TDD-S-9]] passes without weakening build, packaging, or install assertions.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2
status: complete
parents:
- '[[PHASE-2]]'
dependsOn:
- '[[TASK-S-7]]'
- '[[TASK-TDD-S-9]]'
---

## Subtasks
- Ensure the compiled binary from `bun build apps/hook/server/index.ts --compile` is the primary artifact.
- Remove portal and marketing targets from the default build expectations and verify they are no longer part of the main path.
- Update install documentation to the daemon-first flow.
- Verify `plannotator --version` and `plannotator --help` end-to-end.

Goal:
- The project should build and install around one coherent local-tool artifact instead of a mix of ephemeral server paths and unrelated remote assets.
## Activity Log

- 2026-04-29T02:30:34.552Z: created
- 2026-04-29T03:12:00.879Z: updated (complexityScore) -> 49
- 2026-05-01T21:55:32.366Z: status_changed (status) -> in-progress
- 2026-05-01T22:00:57.496Z: status_changed (status) -> needs-review
- 2026-05-01T22:00:57.496Z: updated (progress) -> 100
