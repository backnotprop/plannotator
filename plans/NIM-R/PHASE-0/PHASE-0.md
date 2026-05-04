---
id: PHASE-0
trackerStatus:
  type: phase
title: "Phase 0: Semantics frozen — all open questions converted to explicit contracts"
status: unstarted
priority: critical
tags:
  - plannotator
  - semantics
  - contracts
  - phase
progress: 10
parents:
  - NIM-R
dependsOn:
  - "[[D1]]"
  - "[[D2]]"
  - "[[D3]]"
  - "[[D4]]"
  - "[[D5]]"
  - "[[D6]]"
---

## Description

Phase: no E2E spec may rely on unstated behavior. Each open question becomes a short contract entry with observable behavior: command, state before, state after, stdout/stderr shape, exit code, persistence effect, and recovery behavior.

## Decision tasks

| Task | Contract | Blocks |
|------|----------|--------|
| [[D1]] | Exit-code table (CLI vs hook shim) | [[E03]], [[E07]], [[E11]], [[E12]] |
| [[D2]] | Verdict broadcast / wait-consumption semantics | [[E03]], [[E04]], [[E06]], [[E13]] |
| [[D3]] | Daemon crash/recovery contract | [[E02]], [[E08]] |
| [[D4]] | PLANNOTATOR_HOME / state-dir contract | [[E02]], [[E08]], [[E09]] |
| [[D5]] | Signal-handling contract | [[E02]], [[E08]], [[E11]] |
| [[D6]] | Concurrent hook submission contract | [[E12]], [[E13]] |

## Acceptance criteria

- Each [[D1]]-[[D6]] has a written contract in its task file
- All six contracts reviewed and accepted
- Every E2E spec references only named contracts for behaviors it tests
- Exit-code table reviewed and matches actual implementation
- Daemon state transition table reviewed
- Crash/recovery table reviewed

## Phase check

- Manual review of exit-code table
- Manual review of daemon state transition table
- Manual review of crash/recovery table
- Grep or scripted check that every E2E spec references only named contracts

## Activity Log

- 2026-05-04T08:00:01.000Z: created (unified phase from E2E test plan open questions)
