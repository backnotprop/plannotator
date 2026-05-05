---
id: TASK-TDD-S-8
trackerStatus:
  type: task
title: TDD for S-8 agent wrapper behavior
description: Write the proof cases for Claude Code and OpenCode wrapper behavior before
  implementation completion.
successCriteria:
- Proof cases cover real CLI shell-outs, stdin/stdout flows, hook-envelope behavior, and OpenCode wrapper behavior.
- The proof distinguishes daemon-general logic from agent-specific wrapper policy through observable wrapper outputs.
- The proof exposes the missing thin-wrapper behavior before [[TASK-S-8]] and remains the acceptance gate afterward.
tags:
- FEATURE-DAEMON-REFACTOR
- PLAN-NIM-R
- PHASE-2-TDD
status: needs-review
parents:
- '[[PHASE-2-TDD]]'
---

## Description
Requirements:
- Use real CLI shell-outs, real stdin and stdout flows, and real wrapper behavior.
- Prove hook-envelope behavior, tool-shell-out behavior, and the separation between daemon-general logic and agent-specific policy.
- Avoid mock-only wrapper tests that never exercise the actual CLI contract.

Process rule:
- This proof task must be authored separately from implementation, and [[TASK-S-8]] writers may not weaken or rewrite the tests after handoff.
## Comments

### Comment (2026-05-01T05:21:47.150Z)

Delegated to child session `c1051204-95b6-48ca-8a98-bfb582ee06af` in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/radiant-birch` after checkpoint commit `90a55b1`.

Acceptance target:
- new [[TASK-TDD-S-8]] proof file with a real CLI/wrapper-behavior harness
- child-worktree verification should yield a clean red phase for the missing [[TASK-S-8]] implementation surface

### Comment (2026-05-01T16:29:54.728Z)

The current delegate `c1051204-95b6-48ca-8a98-bfb582ee06af` is being explicitly abandoned after repeated polling showed a stable partial diff, no completion commit, and no response to a forced finish-or-blocker prompt. Taking over [[TASK-TDD-S-8]] locally to salvage the proof and keep the workflow moving.

### Comment (2026-05-01T16:38:19.104Z)

Accepted in `main` as `eb8ddbf` `test: add [[TASK-TDD-S-8]] agent wrapper proof`.

Verification in `main`:
- `bun test tests/nim-20.agent-wrapper-proof.test.ts`
- result: intentional red phase
- failures:
  - Claude hook wrapper cannot load because `apps/hook/server/index.ts` still imports `@plannotator/server` directly in the disposable CLI environment
  - OpenCode wrapper cannot load because `apps/opencode-plugin/index.ts` still imports `@plannotator/server` directly in the disposable CLI environment

This is the expected missing [[TASK-S-8]] thin-wrapper surface.

## Activity Log

- 2026-04-29T04:15:19.749Z: created
- 2026-05-01T05:21:46.776Z: status_changed (status) -> in-progress
- 2026-05-01T05:21:46.776Z: updated (owner) -> child-session:c1051204-95b6-48ca-8a98-bfb582ee06af (gpt-5.4)
- 2026-05-01T05:21:46.776Z: updated (progress) -> 1
- 2026-05-01T05:21:47.150Z: commented
- 2026-05-01T16:29:54.728Z: commented
- 2026-05-01T16:38:18.988Z: status_changed (status) -> needs-review
- 2026-05-01T16:38:18.988Z: updated (progress) -> 100
- 2026-05-01T16:38:19.104Z: commented
