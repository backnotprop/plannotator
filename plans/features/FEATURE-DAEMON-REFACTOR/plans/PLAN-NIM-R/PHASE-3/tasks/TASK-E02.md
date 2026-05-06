---
id: TASK-E02
trackerStatus:
  type: task
title: daemon lifecycle (start/stop/status/aliases/port)
description: '| # | Test | Pass condition | |---|------|----------------| | 2.1 |
  Cold start: no daemon, run `daemon start` | exits 0; prints port + URL on stdout;
  `daemon.json` exists with live PID; `GET /api/status` returns `idle` | | 2.2 | Idempotent
  start: `daemon start` while running | exits 0; PID in lockfile unchanged; no duplicate
  process | | 2.3 | `daemon status` running | exits 0; stdout names a status; URL
  printed | | 2.4 | `daemon status` not running | exits non-zero; says "not running";
  no stale lockfile assertion failure | | 2.5 | `daemon stop` | exits 0; PID gone;
  lockfile removed | | 2.6 | `daemon stop` when already stopped | exits 0 (idempotent);
  no error | | 2.7 | Stale lockfile: write `daemon.json` with non-existent PID, then
  `daemon start` | starts cleanly; reports stale lockfile; ends with a live daemon
  | | 2.8 | Aliases: `plannotator start`, `plannotator stop`, `plannotator status`
  | behave identically to their `daemon` forms | | 2.9 | Port collision: bind configured
  port from another process, then `daemon start` | exits non-zero with "port in use"
  message; does NOT fall back silently | | 2.10 | Foreground mode: `daemon start --foreground`
  | runs in current shell; SIGTERM cleanly stops it; lockfile cleaned up on exit |'
successCriteria:
- E2E coverage proves cold start, idempotent start, running and stopped status, stop behavior, stale lockfile recovery, aliases, port collisions, and foreground mode.
- Lifecycle assertions use real daemon processes, lockfiles, PID ownership, and daemon state rather than mocked lifecycle helpers.
- Lifecycle behavior matches the accepted crash, state-directory, and signal contracts referenced by this task.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: unstarted
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-4]]'
- '[[TASK-S-6]]'
- '[[TASK-D3]]'
- '[[TASK-D4]]'
- '[[TASK-D5]]'
- '[[TASK-E00]]'
---


## Activity Log

- 2026-05-02T04:03:46.503Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
