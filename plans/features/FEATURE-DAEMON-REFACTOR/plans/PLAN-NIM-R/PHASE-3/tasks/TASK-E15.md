---
id: TASK-E15
trackerStatus:
  type: task
title: Packaging and install path
description: 'Semantic deps: None.  Verifies the sprint''s deleted surfaces are gone
  and docs are consistent.  | # | Test | Pass condition | |---|------|----------------|
  | 99.1 | `apps/marketing/` does not exist | filesystem check | | 99.2 | `apps/paste-service/`
  does not exist | filesystem check | | 99.3 | `apps/portal/` does not exist | filesystem
  check | | 99.4 | `packages/server/share-url.ts` does not exist | filesystem check
  | | 99.5 | `packages/ui/utils/sharing.ts` does not exist | filesystem check | |
  99.6 | `packages/ui/hooks/useSharing.ts` does not exist | filesystem check | | 99.7
  | `package.json` scripts do not contain `build:portal`, `build:marketing`, `dev:portal`,
  `dev:marketing` | grep + assertion | | 99.8 | README mentions no `PLANNOTATOR_REMOTE`,
  `PLANNOTATOR_SHARE`, `PLANNOTATOR_SHARE_URL`, `PLANNOTATOR_PASTE_URL` | grep README;
  if any appear, P1 finding | | 99.9 | `AGENTS.md` is up to date with the daemon model
  | **expected to FAIL today** — AGENTS.md is stale, still describing per-invocation
  server architecture. Test asserts this; failure is tracked doc-debt. Goes green
  once doc is fixed. | | 99.10 | No reference to `share.plannotator.ai` or `plannotator-paste.plannotator.workers.dev`
  anywhere in source tree (excluding `legacy/`) | grep + assertion | | 99.11 | `apps/pi-extension/`
  — codify whether it stays or goes | assert expected state; catches accidental re-introduction
  or deletion |'
successCriteria:
- Filesystem and grep-backed checks prove deleted remote/share surfaces stay absent from the active source tree, scripts, and docs.
- 'Packaging and install verification keeps the daemon-first artifact path consistent with `--help`, `--version`, and install documentation.'
- Repo guidance and source tree checks catch accidental reintroduction of removed surfaces or stale daemon-model documentation.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: needs-review
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-1]]'
- '[[TASK-S-9]]'
- '[[TASK-E00]]'
- '[[TASK-E01]]'
---


## Activity Log

- 2026-05-02T04:05:59.257Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
