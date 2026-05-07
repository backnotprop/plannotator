---
id: TASK-E06
trackerStatus:
  type: task
title: annotate mode
description: '| # | Test | Pass condition | |---|------|----------------| | 6.1 |
  `plannotator annotate fixtures/markdown/annotate-target.md` | daemon enters `active/mode:annotate`;
  UI loads file content | | 6.2 | `@`-prefixed path | works identically (`@` is stripped)
  | | 6.3 | Annotate, send feedback | feedback delivered to agent via async path |
  | 6.4 | Cancel annotation | message: `"Annotation of {file_path} cancelled by user."`
  (verify exact string) | | 6.5 | Non-existent file | exits non-zero with clear error;
  daemon stays `idle` (does NOT enter `active`) | | 6.6 | File outside cwd | works
  (absolute paths supported) |'
successCriteria:
- 'E2E coverage proves annotate mode activation, `@`-prefixed path handling, feedback delivery, cancellation output, non-existent file handling, and absolute-path support.'
- Invalid annotate targets fail without corrupting daemon state or transitioning into an active review.
- Annotate-mode behavior matches the accepted verdict and CLI contract for this surface.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: complete
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-D2]]'
- '[[TASK-E00]]'
---


## Activity Log

- 2026-05-02T04:04:24.833Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
