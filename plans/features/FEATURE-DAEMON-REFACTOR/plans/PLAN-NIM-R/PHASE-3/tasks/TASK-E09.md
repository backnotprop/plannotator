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
status: blocked
parents:
- '[[PHASE-3]]'
dependsOn:
- '[[TASK-S-4]]'
- '[[TASK-S-5]]'
- '[[TASK-D4]]'
- '[[TASK-E00]]'
---


## Review Findings (2026-05-05)

**Kick back.** §9.7 contains conditional acceptance language: "or drop to smoke test if not realistically testable".

Per framework: tasks must define a single acceptance contract, not an implementation-time downgrade option. Either:

- assert the full Obsidian-vault behavior (frontmatter fields, backlink format) and require that path to be testable, or
- restrict §9.7 to the smoke check up front (file appears in vault) and move richer assertions to a separate task.

## Activity Log

- 2026-05-02T04:04:55.736Z: created
- 2026-05-05T00:00:00.000Z: status_changed (status) -> needs-review
