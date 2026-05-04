---
id: NIM-8
trackerStatus:
  type: task
title: S-7 Add notifications for state transitions
status: in-review
priority: medium
tags:
- plannotator
- daemon-refactor
- notifications
progress: 100
parents:
- PHASE-2
dependsOn:
- NIM-5
- NIM-6
- NIM-19
---

## Description

Parent phase: Phase 2 (Slice TDD + implementation). 
Add local OS notifications when a document enters review.

Subtasks:
- Create `packages/server/notify.ts`.
- Implement cross-platform dispatch for macOS, Linux, and Windows with runtime detection.
- Fire notifications on `idle -> in_review` with the document title and daemon URL.
- Do not notify on `in_review -> verdict_ready`.
- Optionally respect `PLANNOTATOR_NOTIFY=0`.

Scope note:
- This remains local-only. The goal is a practical user signal, not a broader collaboration mechanism.

## Comments

### Comment (2026-05-01T05:04:25.817Z)

Delegated to child session `0dad2ebd-951b-49f6-8280-ca4f8ee39a22` in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/fleeting-moose` after checkpoint commit `2f948e8`.

Acceptance target:
- `bun test tests/nim-19.notification-proof.test.ts`

Implementation must satisfy the accepted NIM-19 proof without weakening tests.

### Comment (2026-05-01T05:06:08.738Z)

The initial delegate `0dad2ebd-951b-49f6-8280-ca4f8ee39a22` was explicitly abandoned and replaced after showing no worktree changes and no session activity beyond creation. Reassigning NIM-8 to a fresh child session.

### Comment (2026-05-01T05:06:30.343Z)

Replacement delegation assigned to child session `592727ce-a5af-40c4-b9f5-1e24c7890c5b` in worktree `/home/dzack/gitclones/plannotator-dzg-fork_worktrees/neat-vapor`.

Acceptance target remains:
- `bun test tests/nim-19.notification-proof.test.ts`

The first delegate was explicitly abandoned for inactivity.

### Comment (2026-05-01T05:08:08.433Z)

The second delegate `592727ce-a5af-40c4-b9f5-1e24c7890c5b` was explicitly abandoned and replaced after showing no worktree diff or result output despite repeated polling. Escalating NIM-8 to a direct worker delegate.

### Comment (2026-05-01T05:14:07.341Z)

NIM-8 is now reassigned to direct worker agent `019de1f5-2bea-74f0-a632-2c42cd8a8a16` (`Bohr`) after two inactive meta-session delegates. Acceptance target is unchanged: `bun test tests/nim-19.notification-proof.test.ts`.

### Comment (2026-05-01T05:21:24.131Z)

Accepted in `main` as `0e361ba` `feat: add local review-entry notifications`.

Verification in `main`:
- `bun test tests/nim-19.notification-proof.test.ts`
- result: `4 pass, 0 fail`
- `bun run build:hook`
- result: success

Note: the root `build:hook` script change was retained because the previous script failed on current `main` by trying to copy `../review/dist/index.html` before it existed.

## Activity Log

- 2026-04-29T02:30:16.626Z: created
- 2026-04-29T03:11:56.313Z: updated (complexityScore) -> 34
- 2026-05-01T05:04:25.511Z: status_changed (status) -> in-progress
- 2026-05-01T05:04:25.511Z: updated (owner) -> child-session:0dad2ebd-951b-49f6-8280-ca4f8ee39a22 (gpt-5.4)
- 2026-05-01T05:04:25.511Z: updated (progress) -> 1
- 2026-05-01T05:04:25.817Z: commented
- 2026-05-01T05:06:08.738Z: commented
- 2026-05-01T05:06:30.080Z: updated (owner) -> child-session:592727ce-a5af-40c4-b9f5-1e24c7890c5b (gpt-5.4)
- 2026-05-01T05:06:30.080Z: updated (progress) -> 1
- 2026-05-01T05:06:30.343Z: commented
- 2026-05-01T05:08:08.433Z: commented
- 2026-05-01T05:14:07.064Z: updated (owner) -> worker-agent:019de1f5-2bea-74f0-a632-2c42cd8a8a16 (Bohr)
- 2026-05-01T05:14:07.064Z: updated (progress) -> 1
- 2026-05-01T05:14:07.341Z: commented
- 2026-05-01T05:21:23.898Z: status_changed (status) -> in-review
- 2026-05-01T05:21:23.898Z: updated (progress) -> 100
- 2026-05-01T05:21:24.131Z: commented
