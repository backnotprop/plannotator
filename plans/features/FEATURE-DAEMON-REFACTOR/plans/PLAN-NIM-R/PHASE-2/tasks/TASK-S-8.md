---
id: TASK-S-8
trackerStatus:
  type: task
title: S-8 Refactor agent integrations into thin CLI clients
description: Reduce the Claude Code and OpenCode integrations to thin wrappers around
  the CLI.
successCriteria:
- Claude Code and OpenCode integrations shell out to the CLI instead of directly hosting their own server implementation path.
- Agent-specific policy remains in wrapper code while daemon-general behavior stays out of the integration layer.
- Hook-envelope and tool-return behavior match the accepted wrapper contract for submit, review, and annotate flows.
- The targeted proof for [[TASK-TDD-S-8]] passes without weakening the accepted wrapper test surface.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2
status: blocked
parents:
- '[[PHASE-2]]'
dependsOn:
- '[[TASK-S-5]]'
- '[[TASK-S-6]]'
- '[[TASK-TDD-S-8]]'
---

## Subtasks
- Refactor the Claude Code hook shim so it reads stdin payloads, shells out to `plannotator submit`, and converts exit codes into hook decision JSON.
- Refactor OpenCode tools so `submit_plan`, review, and annotate shell out to the CLI instead of hosting their own server paths.
- Keep agent-specific policy in the integration layer, including the OpenCode compliance token validation.
- Decide the fate of `apps/pi-extension/`; preferred path is deletion or the same thin shell-out model.

Architectural rule:
- The daemon must stay general-purpose. Agent policy belongs in the wrappers, not in daemon state transitions or transport logic.
## Review Findings (2026-05-05)

**Kick back.** Subtasks contain unresolved decision language: "Decide the fate of `apps/pi-extension/`; preferred path is deletion or the same thin shell-out model."

Per framework rules in `/home/dzack/gitclones/ai/planning/AGENTS.md` §Task Cards: tasks must not contain "decide whether", "figure out", or "choose an approach". Resolve the pi-extension fate during task authoring (decide between delete vs. thin shell-out, encode the chosen contract, and update the wrapper proof in [[TASK-TDD-S-8]] / [[TASK-E15]] to assert that exact state). Either reflect the decision already made by the integrated implementation, or open a feature-level decision card if the choice is genuinely open.

## Comments

### Comment (2026-05-01T16:39:19.398Z)

Delegated to child session `a4bc8409-eb8e-4345-9799-9f86474c8e41` in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/grand-lark` after checkpoint commit `e7c6c93`.

Acceptance target:
- `bun test tests/nim-20.agent-wrapper-proof.test.ts`

Production code must satisfy the accepted [[TASK-TDD-S-8]] proof without weakening it.

## Activity Log

- 2026-04-29T02:30:28.818Z: created
- 2026-04-29T03:11:58.563Z: updated (complexityScore) -> 74
- 2026-05-01T16:39:19.045Z: status_changed (status) -> in-progress
- 2026-05-01T16:39:19.046Z: updated (owner) -> child-session:a4bc8409-eb8e-4345-9799-9f86474c8e41 (gpt-5.4)
- 2026-05-01T16:39:19.046Z: updated (progress) -> 1
- 2026-05-01T16:39:19.398Z: commented
- 2026-05-01T17:02:23.301Z: status_changed (status) -> needs-review
- 2026-05-01T17:02:23.301Z: updated (progress) -> 100
