---
id: FEATURE-DAEMON-REFACTOR
trackerStatus:
  type: feature
parents: []
dependsOn: []
plans:
- '[[PLAN-NIM-R]]'
title: Local daemon refactor with E2E certification
status: in-progress
priority: critical
owner: dzack
description: Replace Plannotator's per-invocation server model with a persistent local
  single-user daemon, a stable CLI surface, and thin Claude Code/OpenCode wrappers,
  with completion certified by real built-artifact E2E tests.
releaseVersion: daemon-refactor
releaseNotes: 'Ships a local daemon-backed Plannotator workflow: one active review
  slot, daemon lifecycle commands, submit/wait/clear recovery, local-only operation,
  thin agent integrations, and proof-backed packaging.'
---

## Purpose

This feature defines the daemon refactor. Plannotator moves from a per-invocation ephemeral-server tool to a local single-user daemon with a clean CLI as the primary interface. Claude Code and OpenCode integrations become thin wrappers around that CLI and keep only agent-specific policy.

The feature card is the hierarchy root. Plans and specs are children of this feature, not peers and not duplicate source nodes.

## Child Cards

- [[SPEC-DAEMON-E2E-CERTIFICATION]] defines the proof and acceptance contract.
- [[PLAN-NIM-R]] executes the implementation and verification phases.

## User Outcome

Agents interact with Plannotator through a stable local CLI instead of launching a fresh server for each invocation. A user can start the daemon once, submit plans or review documents repeatedly, recover from interrupted clients, clear stuck state, and verify that Claude Code and OpenCode wrappers pass decisions through the same daemon-backed contract.

## Scope

- Local-only operation with no share URLs, paste service, public portal, or remote collaboration surface.
- Single active document slot with deterministic collision handling.
- Daemon lifecycle commands for start, stop, status, foreground mode, stale lock recovery, and fixed-port ownership.
- Submit, wait, state, clear, approve, deny, cancel, review, annotate, draft, upload, and feedback paths served through the daemon.
- CLI output and exit-code behavior stable enough for shell users, Claude hook JSON envelopes, and OpenCode JSON consumers.
- Claude Code and OpenCode integrations reduced to thin CLI clients with agent-specific policy only.
- Build and packaging aligned around one compiled daemon-plus-CLI artifact.
- E2E proof coverage that drives real binaries, real daemon processes, real HTTP endpoints, real fixtures, and browser-visible behavior.

## Current Architecture

Plannotator currently has per-invocation server entry points:

- Plan review uses `packages/server/index.ts` through `startPlannotatorServer()`.
- Code review uses `packages/server/review.ts` through `startReviewServer()`.
- Markdown annotation uses `packages/server/annotate.ts` through `startAnnotateServer()`.

Each invocation binds a local port, opens a browser, blocks on a decision promise, and then exits through cleanup paths such as `/api/shutdown`, signals, or explicit stop handles.

## Target Architecture

The target model is one long-running Bun daemon on a local port, serving a singleton review state machine and a browser-plus-CLI HTTP API.

State model:

- `idle`: no active document; submissions are accepted.
- `in_review`: a document is submitted; the user is reviewing; agent CLI clients wait on a verdict.
- `verdict_ready`: the user acted, but the verdict has not been fully consumed under the accepted wait contract.

Core daemon API:

- `GET /`: serve the UI matching the current mode.
- `GET /api/state` or `/api/status`: return the current daemon state snapshot, according to the accepted API contract.
- `GET /api/wait`: wait for the verdict of the current active request.
- `POST /api/submit`: accept a new document only when idle; otherwise return structured collision guidance.
- `POST /api/approve`, `/api/deny`, and `/api/cancel`: apply browser-driven state transitions.
- `POST /api/clear`: force reset to idle under the accepted clear contract.

Persistent files:

- `~/.plannotator/daemon.json`
- `~/.plannotator/state.json`
- `~/.plannotator/history/...`
- `~/.plannotator/drafts/...`

Port and locality model:

- The daemon binds locally.
- The CLI and integrations communicate with the local daemon.
- Headless or remote use goes through user-managed port forwarding, not a Plannotator-hosted sharing service.

## Non-Goals

- Queueing multiple active review documents.
- Reintroducing share links, paste services, marketing portals, or public collaboration endpoints.
- Treating mocks, fake backends, or package-level approximations as release certification.
- Accepting passing unit tests as the terminal completion signal without fresh E2E runs from built artifacts.

## Retained Surfaces

- `packages/server/integrations.ts`
- `apps/vscode-extension/`
- `packages/server/storage.ts`
- `packages/server/draft.ts`

## Primary Contracts

The feature is not complete until the Phase 0 contracts are explicit and all dependent implementation/spec work conforms to them:

- [[TASK-D1]] defines CLI and hook-shim exit codes.
- [[TASK-D2]] defines verdict broadcast and wait-consumption semantics.
- [[TASK-D3]] defines daemon crash and recovery behavior.
- [[TASK-D4]] defines `PLANNOTATOR_HOME` and state-directory behavior.
- [[TASK-D5]] defines signal handling.
- [[TASK-D6]] defines concurrent hook submission behavior.

## Implementation Slices

The implementation work remains decomposed by [[PHASE-2]] and [[PHASE-2-TDD]]:

- [[TASK-S-1]] removes remote collaboration surface area.
- [[TASK-S-2]] creates the daemon state machine.
- [[TASK-S-3]] creates the multiplexed daemon router.
- [[TASK-S-4]] owns daemon lifecycle.
- [[TASK-S-5]] adds submit, wait, state, and clear endpoints.
- [[TASK-S-6]] defines the public CLI.
- [[TASK-S-7]] adds local notifications.
- [[TASK-S-8]] converts agent integrations into thin wrappers.
- [[TASK-S-9]] updates build and packaging.
- [[TASK-S-10]] performs final verification.

## Acceptance Summary

This feature reaches `done` only when [[PHASE-4]] passes: all semantic decisions are frozen, implementation slices satisfy their paired proof tasks, cross-slice E2E specs pass from clean state, and the final verification run proves the built artifact rather than TypeScript source alone.

## Risks

- Detached daemon spawning may be cross-platform fragile.
- Browser-side state may assume one fresh random port per session.
- Wait and verdict delivery can lose or duplicate decisions if request identity is underspecified.
- Removing share and marketing surfaces can expose hidden build assumptions.
- Collision handling is a user-facing recovery surface and needs explicit proof.
