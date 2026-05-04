---
id: NIM-10
trackerStatus:
  type: task
title: S-9 Update build and packaging around the daemon artifact
status: needs-review
priority: medium
tags:
- plannotator
- daemon-refactor
- build
- packaging
progress: 100
parents:
- [[PHASE-2]]
dependsOn:
- [[NIM-8]]
- [[NIM-21]]
---

## Description

Parent phase: Phase 2 (Slice TDD + implementation). 
Align the build and install flow with the single compiled daemon-plus-CLI artifact.

Subtasks:
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
