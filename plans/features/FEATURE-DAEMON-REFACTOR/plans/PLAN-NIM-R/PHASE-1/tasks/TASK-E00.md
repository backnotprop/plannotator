---
id: TASK-E00
trackerStatus:
  type: task
title: 'E2E test infrastructure: helpers, fixtures, playwright config'
description: Set up the E2E infrastructure, helpers, and fixtures for the end-to-end
  test suite.
successCriteria:
- 'Shared helpers exist for daemon lifecycle, CLI execution, filesystem sandboxing, and browser control under `tests/e2e/helpers/`.'
- 'Fixture data exists for plan submissions, markdown annotation targets, and temporary git repos under `tests/e2e/fixtures/`.'
- 'Per-test isolation through `PLANNOTATOR_HOME` and test-local port allocation is documented and enforced by the harness.'
- Browser auto-open is disabled or bypassed in tests while Playwright can still drive the daemon URL directly.
- Common state and JSON-shape assertions are available for later E2E tasks to reuse.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-1
status: complete
parents:
- '[[PHASE-1]]'
---

## Description

Parent phase: Phase 1 (E2E infrastructure usable). [[TASK-E00]] — prerequisite for all E2E specs.

## Layout

```
tests/
├── e2e/
│   ├── helpers/
│   │   ├── daemon.ts        # spawn/kill helpers, wait-for-bound-port
│   │   ├── cli.ts           # exec the binary, capture stdout/stderr
│   │   ├── fs-sandbox.ts    # tmp PLANNOTATOR_HOME per test
│   │   └── browser.ts       # Playwright fixture wired to daemon URL
│   ├── fixtures/
│   │   ├── plans/
│   │   │   ├── small.md
│   │   │   ├── multi-section.md
│   │   │   ├── identical.md
│   │   │   ├── revision-base.md
│   │   │   ├── revision-revised.md
│   │   │   └── plan-no-heading.md
│   │   ├── markdown/
│   │   │   └── annotate-target.md
│   │   └── repos/
│   │       └── make-repo.sh
└── playwright.config.ts
```

## Per-test isolation
Every test sets `PLANNOTATOR_HOME=$(mktemp -d)` before spawning the daemon. If the binary does not honor `PLANNOTATOR_HOME`, wrap each test in `HOME=<tmpdir>` override and verify the daemon respects it. If it doesn't, that's a P0 finding.

## Port allocation
Set `PLANNOTATOR_PORT` to a random free port per test (allocated via a `getFreePort()` helper that binds-then-releases a TCP socket, then waits a beat to avoid TIME_WAIT collisions).

## Browser handling
The daemon opens the system browser by default. Tests must defeat that: either set `PLANNOTATOR_BROWSER=/bin/true` or pass `--no-browser`. Playwright connects to `http://localhost:${PLANNOTATOR_PORT}/` directly.

## Common assertions (extract to helpers)
- `expectIdle()` — `GET /api/status` returns `{ status: "idle" }`
- `expectActive(expectations)` — status is `active`, with mode and doc title matching
- `expectVerdictReady(expectations)` — status is `verdict_ready`
- `expectDaemonRunning()` / `expectDaemonStopped()`
- `expectJsonShape(blob, schema)` — validates `--json` mode output

## Activity Log

- 2026-05-02T04:03:25.604Z: created
- 2026-05-02T04:07:50.901Z: status_changed (status) -> in-progress
- 2026-05-02T17:02:55.752Z: status_changed (status) -> needs-review
- 2026-05-02T17:02:55.752Z: updated (progress) -> 100
