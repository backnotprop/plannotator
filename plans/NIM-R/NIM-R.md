---
id: NIM-R
trackerStatus:
  type: plan
title: 'Root: Daemon refactor implemented and E2E-certified'
status: in-progress
priority: critical
tags:
- plannotator
- daemon-refactor
- epic
- root
progress: 15
dependsOn:
- [[PHASE-0]]
- [[PHASE-1]]
- [[PHASE-2]]
- [[PHASE-3]]
- [[PHASE-4]]
---

## Description

Single root task certifying: daemon implementation exists, all slice-level tests pass, E2E coverage exercises integrated daemon behavior, and unresolved semantics have been converted into explicit decisions.

**This replaces the two-sprint model ([[NIM-1]] + [[NIM-22]]).** [[NIM-1]] and [[NIM-22]] remain as historical sources but all active tracking flows through this root.

## Structural rules

1. **TDD blocks only its implementation slice** — [[NIM-14]] blocks [[NIM-3]] but not [[NIM-4]]
2. **Semantic decisions block specs and implementations that encode those semantics** — [[D2]] blocks [[E03]], [[E04]], [[E06]], [[E13]]
3. **Integration specs have multiple parents** — [[E08]] crash recovery depends on [[D3]], [[D4]], [[D5]], [[NIM-3]], [[NIM-5]], [[NIM-6]], [[NIM-7]], [[NIM-23]]
4. **Single terminal meaning of completion** — root is not satisfied by passing unit tests alone; requires fresh E2E run from built artifacts

## Completion criteria

All five phase tasks (Phase 0-Phase 4) are accepted. No open P0 findings. Full E2E suite passes twice in a row from empty `PLANNOTATOR_HOME`. No daemon processes remain after suite. No remote-surface commands available.

## Activity Log

- 2026-05-04T08:00:00.000Z: created (replaces [[NIM-1]] + [[NIM-22]] as unified root)
