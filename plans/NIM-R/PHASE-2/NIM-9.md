---
id: NIM-9
trackerStatus:
  type: task
title: S-8 Refactor agent integrations into thin CLI clients
status: needs-review
priority: high
tags:
- plannotator
- daemon-refactor
- agent-wrappers
progress: 100
parents:
- PHASE-2
dependsOn:
- NIM-6
- NIM-7
- NIM-20
---

## Description

Parent phase: Phase 2 (Slice TDD + implementation). 
Reduce the Claude Code and OpenCode integrations to thin wrappers around the CLI.

Subtasks:
- Refactor the Claude Code hook shim so it reads stdin payloads, shells out to `plannotator submit`, and converts exit codes into hook decision JSON.
- Refactor OpenCode tools so `submit_plan`, review, and annotate shell out to the CLI instead of hosting their own server paths.
- Keep agent-specific policy in the integration layer, including the OpenCode compliance token validation.
- Decide the fate of `apps/pi-extension/`; preferred path is deletion or the same thin shell-out model.

Architectural rule:
- The daemon must stay general-purpose. Agent policy belongs in the wrappers, not in daemon state transitions or transport logic.

## Comments

### Comment (2026-05-01T16:39:19.398Z)

Delegated to child session `a4bc8409-eb8e-4345-9799-9f86474c8e41` in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/grand-lark` after checkpoint commit `e7c6c93`.

Acceptance target:
- `bun test tests/nim-20.agent-wrapper-proof.test.ts`

Production code must satisfy the accepted NIM-20 proof without weakening it.

## Activity Log

- 2026-04-29T02:30:28.818Z: created
- 2026-04-29T03:11:58.563Z: updated (complexityScore) -> 74
- 2026-05-01T16:39:19.045Z: status_changed (status) -> in-progress
- 2026-05-01T16:39:19.046Z: updated (owner) -> child-session:a4bc8409-eb8e-4345-9799-9f86474c8e41 (gpt-5.4)
- 2026-05-01T16:39:19.046Z: updated (progress) -> 1
- 2026-05-01T16:39:19.398Z: commented
- 2026-05-01T17:02:23.301Z: status_changed (status) -> needs-review
- 2026-05-01T17:02:23.301Z: updated (progress) -> 100
