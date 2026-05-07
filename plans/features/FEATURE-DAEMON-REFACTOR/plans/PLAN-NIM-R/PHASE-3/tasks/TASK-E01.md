---
id: TASK-E01
trackerStatus:
  type: task
title: binary surface (--version, --help, subcommands)
description: 'Semantic deps: None.  Fast, hermetic phase. If any test here fails,
  stop and fix before running anything else.  | # | Test | Pass condition | |---|------|----------------|
  | 1.1 | `plannotator --version` | exit 0; stdout matches `/^\d+\.\d+\.\d+/`; nothing
  on stderr | | 1.2 | `plannotator --help` | exit 0; stdout contains every advertised
  subcommand: `daemon start`, `daemon stop`, `daemon status`, `submit`, `review`,
  `annotate`, `wait`, `clear`, `open` | | 1.3 | `plannotator` (no args, stdin not
  a TTY) | reads stdin as a Claude Code hook event; at minimum, doesn''t crash with
  empty stdin | | 1.4 | `plannotator badcommand` | exit non-zero; clear error message,
  not a stack trace | | 1.5 | `plannotator submit --help` | exit 0; flags `--mode`,
  `--no-browser`, `--commit-message`, `--json` all listed | | 1.6 | `plannotator review
  --help` | exit 0; `--diff-type` documented with all values including `worktree:`
  |  Capture the actual `--help` output as a snapshot file. Subsequent specs reference
  these snapshots to detect surface drift.'
successCriteria:
- 'Built-artifact checks cover `--version`, `--help`, empty-stdin invocation, invalid subcommand handling, and subcommand help surfaces.'
- Help output is snapshotted so later drift in the documented binary surface is caught automatically.
- Failures in this task are treated as release-blocking binary-surface regressions before broader E2E work proceeds.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: complete
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-9]]'
- '[[TASK-E00]]'
---


## Activity Log

- 2026-05-02T04:03:37.867Z: created
- 2026-05-02T04:07:51.113Z: status_changed (status) -> in-progress
- 2026-05-02T17:02:55.958Z: status_changed (status) -> needs-review
- 2026-05-02T17:02:55.958Z: updated (progress) -> 100
