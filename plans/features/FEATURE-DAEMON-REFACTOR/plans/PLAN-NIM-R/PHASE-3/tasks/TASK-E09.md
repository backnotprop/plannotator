---
id: TASK-E09
trackerStatus:
  type: task
title: history and storage (git versioning, drafts, Obsidian)
description: 'Tests verify disk side-effects without touching the UI.  | # | Test
  | Pass condition | |---|------|----------------| | 9.1 | Submit + approve → inspect
  `${PLANNOTATOR_HOME}/.plannotator/plans/{project}/` | directory exists; is a git
  repo; contains `{slug}.md` with plan content | | 9.2 | `git log --format=%s` in
  that dir | first commit message contains `--commit-message` value; empty commit
  follows with approval feedback in body | | 9.3 | Project name detection: cwd inside
  git repo | `{project}` matches repo''s root directory name (sanitized) | | 9.4 |
  Project name detection: cwd NOT inside git repo | `{project}` falls back to current
  directory name | | 9.5 | Submit-deny-resubmit-approve cycle | git log shows: content
  commit, deny event commit (feedback in body), revised content commit, approve event
  commit | | 9.6 | `~/.plannotator/drafts/` persistence | annotation in progress saved
  to disk; killing browser tab and reopening restores draft | | 9.7 | Obsidian integration
  | approved plan appears in vault as markdown file with YAML frontmatter (`created`,
  `source`, `tags`) and [[Plannotator Plans]] backlink — or drop to smoke test if
  not realistically testable |'
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


## Activity Log

- 2026-05-02T04:04:55.736Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
