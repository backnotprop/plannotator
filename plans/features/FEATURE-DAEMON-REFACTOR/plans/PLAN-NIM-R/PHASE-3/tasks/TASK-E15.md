---
id: TASK-E15
trackerStatus:
  type: task
title: Packaging and install path
description: Verify deleted remote/share/portal/paste/pi-extension surfaces stay
  absent and that user-facing docs match the daemon-first contract from
  [[FEATURE-DAEMON-REFACTOR]].
successCriteria:
- Filesystem and grep-backed checks prove deleted remote/share surfaces stay absent from the active source tree, scripts, and docs.
- 'Packaging and install verification keeps the daemon-first artifact path consistent with `--help`, `--version`, and install documentation.'
- Repo guidance and source tree checks catch accidental reintroduction of removed surfaces or stale daemon-model documentation.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: unstarted
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-1]]'
- '[[TASK-S-9]]'
- '[[TASK-E00]]'
- '[[TASK-E01]]'
---


## Test Matrix

All checks must pass cleanly (no expected-failing assertions per framework release-evidence rule).

| # | Test | Pass condition |
|---|------|----------------|
| 99.1 | `apps/marketing/` does not exist | filesystem check |
| 99.2 | `apps/paste-service/` does not exist | filesystem check |
| 99.3 | `apps/portal/` does not exist | filesystem check |
| 99.4 | `packages/server/share-url.ts` does not exist | filesystem check |
| 99.5 | `packages/ui/utils/sharing.ts` does not exist | filesystem check |
| 99.6 | `packages/ui/hooks/useSharing.ts` does not exist | filesystem check |
| 99.7 | `package.json` scripts do not contain `build:portal`, `build:marketing`, `dev:portal`, `dev:marketing` | grep + assertion |
| 99.8 | `README.md` contains no references to `PLANNOTATOR_REMOTE`, `PLANNOTATOR_SHARE`, `PLANNOTATOR_SHARE_URL`, `PLANNOTATOR_PASTE_URL` | grep + assertion |
| 99.9 | `AGENTS.md` describes the daemon model and contains no "per-invocation server" prose | grep + assertion (the doc-update is a prerequisite for this task, not encoded as an expected-failure) |
| 99.10 | No reference to `share.plannotator.ai` or `plannotator-paste.plannotator.workers.dev` anywhere in the source tree, excluding `legacy/` | grep + assertion |
| 99.11 | `apps/pi-extension/` does not exist | filesystem check (per [[TASK-S-8]] decided contract: pi-extension is deleted) |

## Activity Log

- 2026-05-02T04:05:59.257Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: §99.11 pinned to "pi-extension does not exist" (decided contract from [[TASK-S-8]]); §99.9 rewritten as a real passing assertion (AGENTS.md is already up to date — verified via grep) instead of an expected-fail
