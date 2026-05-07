---
id: TASK-E09
trackerStatus:
  type: task
title: history and storage (git versioning, drafts, Obsidian smoke)
description: 'Prove disk-side effects of approve/deny/resubmit flows under the
  [[TASK-D4]] canonical-home contract: history repo creation, project-name detection,
  commit-message propagation, deny-resubmit sequencing, and draft persistence.'
successCriteria:
- E2E coverage proves history repo creation, commit-message propagation, project-name detection, deny-resubmit-approve history sequencing, and draft persistence.
- Disk-side effects are asserted directly from the generated storage paths rather than inferred through UI behavior alone.
- Storage and history behavior matches the accepted state-directory contract for repo and draft isolation.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-3
status: needs-review
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-4]]'
- '[[TASK-S-5]]'
- '[[TASK-D4]]'
- '[[TASK-E00]]'
---


## Test Matrix

Tests verify disk side-effects under an isolated `PLANNOTATOR_HOME` per [[TASK-D4]].

| # | Test | Pass condition |
|---|------|----------------|
| 9.1 | Submit + approve → inspect `${PLANNOTATOR_HOME}/.plannotator/plans/{project}/` | directory exists; is a git repo; contains `{slug}.md` with plan content |
| 9.2 | `git log --format=%s` in that dir | first commit subject contains the `--commit-message` value; an empty commit follows with the approval feedback in the body |
| 9.3 | Project-name detection: cwd inside git repo | `{project}` matches the repo's root directory name (sanitized) |
| 9.4 | Project-name detection: cwd NOT inside git repo | `{project}` falls back to the current directory name |
| 9.5 | Submit → deny → resubmit → approve cycle | git log shows, in order: content commit, deny event commit (feedback in body), revised content commit, approve event commit |
| 9.6 | `${PLANNOTATOR_HOME}/.plannotator/drafts/` persistence | annotation in progress saved to disk; killing the browser tab and reopening restores the draft |
| 9.7 | Obsidian integration smoke | when an Obsidian vault is configured, an approved plan appears in the configured vault directory as a markdown file with non-empty contents. Richer assertions (frontmatter shape, backlink format) are deferred to a separate dedicated task; this task only smokes the integration end-to-end. |

## Activity Log

- 2026-05-02T04:04:55.736Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
- 2026-05-05T01:00:00.000Z: §9.7 narrowed to a single smoke acceptance (file exists, non-empty); richer Obsidian-frontmatter assertions deferred to a future task per framework rule against conditional acceptance
