---
id: NIM-1
trackerStatus:
  type: plan
title: Plannotator local daemon refactor sprint
status: needs-review
priority: high
tags:
  - plannotator
  - daemon-refactor
  - sprint
  - local-daemon
  - cli
progress: 100
dependsOn:
  - "[[NIM-21]]"
---

## Description

# Goal
Convert Plannotator from a per-invocation ephemeral-server tool into a local single-user daemon with a clean CLI as the primary interface. Claude Code and OpenCode integrations become thin wrappers around the CLI that add agent-specific policy but contain no server logic.

# Scope constraints
- Local only. No share URLs, paste service, public portal, or remote-collaboration surface area.
- Single sprint. The work is one cohesive dependency-ordered sprint, not a phased roadmap.
- Singleton document slot. The daemon manages exactly one active document at a time. Concurrent submissions are illegal-state attempts that must surface resume and clear guidance.
- Real proof standard. Validation must rely on real fixtures, real commands, real servers, real use cases, and real visible behavior. No mocks or fake substitute data for sprint signoff.

# Background: current architecture
Plannotator currently spawns a fresh HTTP server per agent invocation:
- Plan review: `packages/server/index.ts` via `startPlannotatorServer()`
- Code review: `packages/server/review.ts` via `startReviewServer()`
- Markdown annotate: `packages/server/annotate.ts` via `startAnnotateServer()`

Each server binds a random local port, opens a browser, blocks on a decision promise, and shuts down through cleanup paths such as `/api/shutdown`, signals, or explicit stop handles. Claude Code, OpenCode, and Pi integrations each spin up their own server instance.

# Target architecture
The target model is one long-running Bun daemon on a fixed port, serving a singleton review state machine and a browser-plus-CLI HTTP API.

State machine:
- `idle`: no active document, submissions accepted.
- `in_review`: document submitted, user reviewing, agent CLI waiting on verdict.
- `verdict_ready`: user acted but the verdict has not yet been consumed by a client.

Core daemon API:
- `GET /`: serve the UI matching the current mode.
- `GET /api/state`: current daemon state snapshot.
- `GET /api/wait`: SSE endpoint that closes on verdict.
- `POST /api/submit`: accept new document only when idle; otherwise return structured 409.
- `POST /api/approve`, `/api/deny`, `/api/cancel`: browser-driven state transitions.
- `POST /api/clear`: force reset to idle.

Persistent files:
- `~/.plannotator/daemon.json`
- `~/.plannotator/state.json`
- `~/.plannotator/history/...`
- `~/.plannotator/drafts/...`

Port model:
- Fixed port, default `19432`, override `PLANNOTATOR_PORT`.
- No random-port discovery, no remote-mode branching, no share URLs.
- Headless or remote use is only through user-managed port forwarding.

# Out-of-scope deletions
Delete outright, not deprecate:
- `apps/marketing/`
- `apps/paste-service/`
- `apps/portal/` if present
- `packages/server/share-url.ts`
- `packages/ui/utils/sharing.ts`
- `packages/ui/hooks/useSharing.ts`
- Share UI in `packages/ui/components/`
- `PLANNOTATOR_SHARE_URL` and `PLANNOTATOR_PASTE_URL`
- `packages/server/remote.ts`
- `PLANNOTATOR_REMOTE`
- `apps/pi-extension/` unless explicitly retained as a thin CLI wrapper

Keep in place:
- `packages/server/integrations.ts`
- `apps/vscode-extension/`
- `packages/server/storage.ts`
- `packages/server/draft.ts`

# Tracker backlog map
Implementation slices:
- [[S-1]]: S-1 Strip remote collaboration surface area
- [[S-2]]: S-2 Define daemon state machine module
- [[S-3]]: S-3 Refactor per-mode servers into a multiplexed router
- [[S-4]]: S-4 Implement daemon process lifecycle
- [[S-5]]: S-5 Add submit, wait, state, and clear daemon endpoints
- [[S-6]]: S-6 Define the CLI surface around the daemon
- [[S-7]]: S-7 Add notifications for state transitions
- [[S-8]]: S-8 Refactor agent integrations into thin CLI clients
- [[S-9]]: S-9 Update build and packaging around the daemon artifact

Testing and proof tasks:
- [[S-9.5]]: Sprint-wide proof policy and shared TDD phase
- [[NIM-13]]: TDD for S-1 remote-surface deletion and build invariants
- [[NIM-14]]: TDD for S-2 state transition correctness
- [[NIM-15]]: TDD for S-3 multiplexed router behavior
- [[NIM-16]]: TDD for S-4 daemon lifecycle and recovery
- [[NIM-17]]: TDD for S-5 submit/wait/verdict semantics
- [[NIM-18]]: TDD for S-6 CLI contract and collision UX
- [[NIM-19]]: TDD for S-7 notification behavior
- [[NIM-20]]: TDD for S-8 agent wrapper behavior
- [[NIM-21]]: TDD for S-9 build, packaging, and install flow
- [[S-10]]: Final verification and proof execution

# Testing and validation policy
- The sprint requires a separate TDD and proof-authoring phase before verification is considered meaningful.
- Each implementation slice must have a paired TDD or proof task before completion.
- Acceptance proofs must target real behavior, including GUI-visible outcomes, daemon lifecycle, CLI behavior, recovery paths, and full workflow correctness.
- Writers may not patch or weaken tests after the proof harness is written; production code must be made to satisfy the frozen proofs.
- Expanding test scope after handoff must be tracked as explicit testing work rather than silently folded into implementation.

# Deferred decisions
- VS Code extension: leave untouched during the sprint, but verify compatibility before merge and file follow-up work if needed.
- Obsidian and Bear integrations: keep as-is unless the daemon changes break them.
- Cookie persistence vs `localStorage`: out of scope, but worth a follow-up once the fixed-port model lands.
- Pi extension fate: preferred outcome is deletion or rewrite as a thin CLI shell-out.

# Risk register
- Detached daemon spawning may be finicky cross-platform, especially on Windows.
- Browser-side state may assume per-session random ports and need a submission/session key.
- SSE may misbehave behind some proxies or forwarded sessions.
- Removing share and marketing surfaces may break build assumptions.
- The structured 409 response is a core UX surface and needs explicit review.
- Late test writing may drift into proving only internal consistency instead of externally visible correctness.

# Definition of done
1. The out-of-scope deletion set is merged and the tree builds clean.
2. `plannotator daemon {start,stop,status}` work as specified.
3. `plannotator submit <file>` notifies, opens the browser, blocks, and returns the verdict without per-invocation server startup.
4. Concurrent submit attempts produce the structured 409 response and the recovery commands actually work.
5. Daemon crash and restart preserve an in-flight verdict.
6. Claude Code and OpenCode become thin CLI wrappers and pass end-to-end smoke tests.
7. Real end-to-end proofs exist for each implementation slice, use real fixtures and commands, and pass without mocks or fake substitute data.
8. `README.md`, `CLAUDE.md`, and `AGENTS.md` describe the daemon model and no longer describe the removed remote-sharing path.

## Comments

### Comment (2026-04-29T02:30:53.939Z)

Imported sprint backlog from the daemon refactor plan.

Task map:
- [[S-1]]: S-1 Strip remote collaboration surface area
- [[S-2]]: S-2 Define daemon state machine module
- [[S-3]]: S-3 Refactor per-mode servers into a multiplexed router
- [[S-4]]: S-4 Implement daemon process lifecycle
- [[S-5]]: S-5 Add submit, wait, state, and clear daemon endpoints
- [[S-6]]: S-6 Define the CLI surface around the daemon
- [[S-7]]: S-7 Add notifications for state transitions
- [[S-8]]: S-8 Refactor agent integrations into thin CLI clients
- [[S-9]]: S-9 Update build and packaging around the daemon artifact
- [[S-10]]: S-10 Run manual and automated verification for the daemon model

Notes:
- The tracker import keeps the sprint as one parent plan plus ten ordered task items.
- Detailed subtasks, dependency notes, and acceptance intent are embedded in each task description.

### Comment (2026-04-29T02:34:25.723Z)

Expanded the tracker detail using the newer attached copy of the sprint plan.

What was upgraded:
- [[NIM-1]] now carries the current-state summary, target daemon architecture, state model, core API, fixed-port model, out-of-scope deletion list, backlog map, deferred decisions, risks, and definition of done.
- [[S-6]] now preserves the CLI command matrix, exit code expectations, and 409-renderer requirements.
- [[S-10]] now preserves the exact manual smoke-test sequence and the automated verification expectations.

The tracker should now be detailed enough to reconstruct the sprint intent even without the original pasted plan file.

### Comment (2026-04-29T03:17:18.758Z)

Added `complexityScore` as a 0-100 planning field for task routing.

Rubric:
- 0-20: trivial, narrowly scoped, low ambiguity, easy verification
- 21-40: small implementation task, limited coupling
- 41-60: moderate task, some refactor or multi-step coordination
- 61-80: high complexity, cross-module work, meaningful ambiguity or testing burden
- 81-100: architecture-level or correctness-critical work with broad coupling, recovery concerns, or difficult validation

Current scores:
- [[S-1]]: 58
- [[S-2]]: 76
- [[S-3]]: 91
- [[S-4]]: 83
- [[S-5]]: 94
- [[S-6]]: 78
- [[S-7]]: 34
- [[S-8]]: 74
- [[S-9]]: 49
- [[S-10]]: 57

Suggested model-routing use:
- 0-40: small/cheap model
- 41-70: standard strong model
- 71-85: stronger reasoning model
- 86-100: strongest model plus explicit review or verification phase

### Comment (2026-04-29T04:17:09.526Z)

Per-slice TDD pairing map:
- - - - - - - - - 
Intent:
- every implementation slice has its own separate proof-authoring task
- the sprint-wide TDD task [[S-9.5]] defines the common standard
- [[S-10]] executes the proof suites and final verification

## Activity Log

- 2026-04-29T02:29:23.155Z: created
- 2026-04-29T02:30:53.939Z: commented
- 2026-04-29T02:33:55.454Z: updated (description) -> # Goal
Convert Plannotator from a per-invocation ephemeral-server tool into a local single-user daemon with a clean CLI as the primary interface. Claude Code and OpenCode integrations become thin wrappers around the CLI that add agent-specific policy but contain no server logic.

# Scope constraints
- Local only. No share URLs, paste service, public portal, or remote-collaboration surface area.
- Single sprint. The work is one cohesive dependency-ordered sprint, not a phased roadmap.
- Singleton document slot. The daemon manages exactly one active document at a time. Concurrent submissions are illegal-state attempts that must surface resume and clear guidance.

# Background: current architecture
Plannotator currently spawns a fresh HTTP server per agent invocation:
- Plan review: `packages/server/index.ts` via `startPlannotatorServer()`
- Code review: `packages/server/review.ts` via `startReviewServer()`
- Markdown annotate: `packages/server/annotate.ts` via `startAnnotateServer()`

Each server binds a random local port, opens a browser, blocks on a decision promise, and shuts down through cleanup paths such as `/api/shutdown`, signals, or explicit stop handles. Claude Code, OpenCode, and Pi integrations each spin up their own server instance.

# Target architecture
The target model is one long-running Bun daemon on a fixed port, serving a singleton review state machine and a browser-plus-CLI HTTP API.

State machine:
- `idle`: no active document, submissions accepted.
- `in_review`: document submitted, user reviewing, agent CLI waiting on verdict.
- `verdict_ready`: user acted but the verdict has not yet been consumed by a client.

Core daemon API:
- `GET /`: serve the UI matching the current mode.
- `GET /api/state`: current daemon state snapshot.
- `GET /api/wait`: SSE endpoint that closes on verdict.
- `POST /api/submit`: accept new document only when idle; otherwise return structured 409.
- `POST /api/approve`, `/api/deny`, `/api/cancel`: browser-driven state transitions.
- `POST /api/clear`: force reset to idle.

Persistent files:
- `~/.plannotator/daemon.json`
- `~/.plannotator/state.json`
- `~/.plannotator/history/...`
- `~/.plannotator/drafts/...`

Port model:
- Fixed port, default `19432`, override `PLANNOTATOR_PORT`.
- No random-port discovery, no remote-mode branching, no share URLs.
- Headless or remote use is only through user-managed port forwarding.

# Out-of-scope deletions
Delete outright, not deprecate:
- `apps/marketing/`
- `apps/paste-service/`
- `apps/portal/` if present
- `packages/server/share-url.ts`
- `packages/ui/utils/sharing.ts`
- `packages/ui/hooks/useSharing.ts`
- Share UI in `packages/ui/components/`
- `PLANNOTATOR_SHARE_URL` and `PLANNOTATOR_PASTE_URL`
- `packages/server/remote.ts`
- `PLANNOTATOR_REMOTE`
- `apps/pi-extension/` unless explicitly retained as a thin CLI wrapper

Keep in place:
- `packages/server/integrations.ts`
- `apps/vscode-extension/`
- `packages/server/storage.ts`
- `packages/server/draft.ts`

# Tracker backlog map
- [[S-1]]: S-1 Strip remote collaboration surface area
- [[S-2]]: S-2 Define daemon state machine module
- [[S-3]]: S-3 Refactor per-mode servers into a multiplexed router
- [[S-4]]: S-4 Implement daemon process lifecycle
- [[S-5]]: S-5 Add submit, wait, state, and clear daemon endpoints
- [[S-6]]: S-6 Define the CLI surface around the daemon
- [[S-7]]: S-7 Add notifications for state transitions
- [[S-8]]: S-8 Refactor agent integrations into thin CLI clients
- [[S-9]]: S-9 Update build and packaging around the daemon artifact
- [[S-10]]: S-10 Run manual and automated verification for the daemon model

# Deferred decisions
- VS Code extension: leave untouched during the sprint, but verify compatibility before merge and file follow-up work if needed.
- Obsidian and Bear integrations: keep as-is unless the daemon changes break them.
- Cookie persistence vs `localStorage`: out of scope, but worth a follow-up once the fixed-port model lands.
- Pi extension fate: preferred outcome is deletion or rewrite as a thin CLI shell-out.

# Risk register
- Detached daemon spawning may be finicky cross-platform, especially on Windows.
- Browser-side state may assume per-session random ports and need a submission/session key.
- SSE may misbehave behind some proxies or forwarded sessions.
- Removing share and marketing surfaces may break build assumptions.
- The structured 409 response is a core UX surface and needs explicit review.

# Definition of done
1. The out-of-scope deletion set is merged and the tree builds clean.
2. `plannotator daemon {start,stop,status}` work as specified.
3. `plannotator submit <file>` notifies, opens the browser, blocks, and returns the verdict without per-invocation server startup.
4. Concurrent submit attempts produce the structured 409 response and the recovery commands actually work.
5. Daemon crash and restart preserve an in-flight verdict.
6. Claude Code and OpenCode become thin CLI wrappers and pass end-to-end smoke tests.
7. `README.md`, `CLAUDE.md`, and `AGENTS.md` describe the daemon model and no longer describe the removed remote-sharing path.
- 2026-04-29T02:34:25.723Z: commented
- 2026-04-29T03:17:18.758Z: commented
- 2026-04-29T04:13:23.972Z: updated (description) -> # Goal
Convert Plannotator from a per-invocation ephemeral-server tool into a local single-user daemon with a clean CLI as the primary interface. Claude Code and OpenCode integrations become thin wrappers around the CLI that add agent-specific policy but contain no server logic.

# Scope constraints
- Local only. No share URLs, paste service, public portal, or remote-collaboration surface area.
- Single sprint. The work is one cohesive dependency-ordered sprint, not a phased roadmap.
- Singleton document slot. The daemon manages exactly one active document at a time. Concurrent submissions are illegal-state attempts that must surface resume and clear guidance.
- Real proof standard. Validation must rely on real fixtures, real commands, real servers, real use cases, and real visible behavior. No mocks or fake substitute data for sprint signoff.

# Background: current architecture
Plannotator currently spawns a fresh HTTP server per agent invocation:
- Plan review: `packages/server/index.ts` via `startPlannotatorServer()`
- Code review: `packages/server/review.ts` via `startReviewServer()`
- Markdown annotate: `packages/server/annotate.ts` via `startAnnotateServer()`

Each server binds a random local port, opens a browser, blocks on a decision promise, and shuts down through cleanup paths such as `/api/shutdown`, signals, or explicit stop handles. Claude Code, OpenCode, and Pi integrations each spin up their own server instance.

# Target architecture
The target model is one long-running Bun daemon on a fixed port, serving a singleton review state machine and a browser-plus-CLI HTTP API.

State machine:
- `idle`: no active document, submissions accepted.
- `in_review`: document submitted, user reviewing, agent CLI waiting on verdict.
- `verdict_ready`: user acted but the verdict has not yet been consumed by a client.

Core daemon API:
- `GET /`: serve the UI matching the current mode.
- `GET /api/state`: current daemon state snapshot.
- `GET /api/wait`: SSE endpoint that closes on verdict.
- `POST /api/submit`: accept new document only when idle; otherwise return structured 409.
- `POST /api/approve`, `/api/deny`, `/api/cancel`: browser-driven state transitions.
- `POST /api/clear`: force reset to idle.

Persistent files:
- `~/.plannotator/daemon.json`
- `~/.plannotator/state.json`
- `~/.plannotator/history/...`
- `~/.plannotator/drafts/...`

Port model:
- Fixed port, default `19432`, override `PLANNOTATOR_PORT`.
- No random-port discovery, no remote-mode branching, no share URLs.
- Headless or remote use is only through user-managed port forwarding.

# Out-of-scope deletions
Delete outright, not deprecate:
- `apps/marketing/`
- `apps/paste-service/`
- `apps/portal/` if present
- `packages/server/share-url.ts`
- `packages/ui/utils/sharing.ts`
- `packages/ui/hooks/useSharing.ts`
- Share UI in `packages/ui/components/`
- `PLANNOTATOR_SHARE_URL` and `PLANNOTATOR_PASTE_URL`
- `packages/server/remote.ts`
- `PLANNOTATOR_REMOTE`
- `apps/pi-extension/` unless explicitly retained as a thin CLI wrapper

Keep in place:
- `packages/server/integrations.ts`
- `apps/vscode-extension/`
- `packages/server/storage.ts`
- `packages/server/draft.ts`

# Tracker backlog map
- [[S-1]]: S-1 Strip remote collaboration surface area
- [[S-2]]: S-2 Define daemon state machine module
- [[S-3]]: S-3 Refactor per-mode servers into a multiplexed router
- [[S-4]]: S-4 Implement daemon process lifecycle
- [[S-5]]: S-5 Add submit, wait, state, and clear daemon endpoints
- [[S-6]]: S-6 Define the CLI surface around the daemon
- [[S-7]]: S-7 Add notifications for state transitions
- [[S-8]]: S-8 Refactor agent integrations into thin CLI clients
- [[S-9]]: S-9 Update build and packaging around the daemon artifact
- [[S-9.5]]: S-9.5 Create real end-to-end proof harness and TDD phase
- [[S-10]]: S-10 Run manual and automated verification for the daemon model

# Testing and validation policy
- The sprint requires a separate TDD and proof-authoring phase before verification is considered meaningful.
- Acceptance proofs must target real behavior, including GUI-visible outcomes, daemon lifecycle, CLI behavior, recovery paths, and full workflow correctness.
- Writers may not patch or weaken tests after the proof harness is written; production code must be made to satisfy the frozen proofs.
- Expanding test scope after handoff must be tracked as explicit testing work rather than silently folded into implementation.

# Deferred decisions
- VS Code extension: leave untouched during the sprint, but verify compatibility before merge and file follow-up work if needed.
- Obsidian and Bear integrations: keep as-is unless the daemon changes break them.
- Cookie persistence vs `localStorage`: out of scope, but worth a follow-up once the fixed-port model lands.
- Pi extension fate: preferred outcome is deletion or rewrite as a thin CLI shell-out.

# Risk register
- Detached daemon spawning may be finicky cross-platform, especially on Windows.
- Browser-side state may assume per-session random ports and need a submission/session key.
- SSE may misbehave behind some proxies or forwarded sessions.
- Removing share and marketing surfaces may break build assumptions.
- The structured 409 response is a core UX surface and needs explicit review.
- Late test writing may drift into proving only internal consistency instead of externally visible correctness.

# Definition of done
1. The out-of-scope deletion set is merged and the tree builds clean.
2. `plannotator daemon {start,stop,status}` work as specified.
3. `plannotator submit <file>` notifies, opens the browser, blocks, and returns the verdict without per-invocation server startup.
4. Concurrent submit attempts produce the structured 409 response and the recovery commands actually work.
5. Daemon crash and restart preserve an in-flight verdict.
6. Claude Code and OpenCode become thin CLI wrappers and pass end-to-end smoke tests.
7. Real end-to-end proofs exist, use real fixtures and commands, and pass without mocks or fake substitute data.
8. `README.md`, `CLAUDE.md`, and `AGENTS.md` describe the daemon model and no longer describe the removed remote-sharing path.
- 2026-04-29T04:17:01.439Z: updated (description) -> # Goal
Convert Plannotator from a per-invocation ephemeral-server tool into a local single-user daemon with a clean CLI as the primary interface. Claude Code and OpenCode integrations become thin wrappers around the CLI that add agent-specific policy but contain no server logic.

# Scope constraints
- Local only. No share URLs, paste service, public portal, or remote-collaboration surface area.
- Single sprint. The work is one cohesive dependency-ordered sprint, not a phased roadmap.
- Singleton document slot. The daemon manages exactly one active document at a time. Concurrent submissions are illegal-state attempts that must surface resume and clear guidance.
- Real proof standard. Validation must rely on real fixtures, real commands, real servers, real use cases, and real visible behavior. No mocks or fake substitute data for sprint signoff.

# Background: current architecture
Plannotator currently spawns a fresh HTTP server per agent invocation:
- Plan review: `packages/server/index.ts` via `startPlannotatorServer()`
- Code review: `packages/server/review.ts` via `startReviewServer()`
- Markdown annotate: `packages/server/annotate.ts` via `startAnnotateServer()`

Each server binds a random local port, opens a browser, blocks on a decision promise, and shuts down through cleanup paths such as `/api/shutdown`, signals, or explicit stop handles. Claude Code, OpenCode, and Pi integrations each spin up their own server instance.

# Target architecture
The target model is one long-running Bun daemon on a fixed port, serving a singleton review state machine and a browser-plus-CLI HTTP API.

State machine:
- `idle`: no active document, submissions accepted.
- `in_review`: document submitted, user reviewing, agent CLI waiting on verdict.
- `verdict_ready`: user acted but the verdict has not yet been consumed by a client.

Core daemon API:
- `GET /`: serve the UI matching the current mode.
- `GET /api/state`: current daemon state snapshot.
- `GET /api/wait`: SSE endpoint that closes on verdict.
- `POST /api/submit`: accept new document only when idle; otherwise return structured 409.
- `POST /api/approve`, `/api/deny`, `/api/cancel`: browser-driven state transitions.
- `POST /api/clear`: force reset to idle.

Persistent files:
- `~/.plannotator/daemon.json`
- `~/.plannotator/state.json`
- `~/.plannotator/history/...`
- `~/.plannotator/drafts/...`

Port model:
- Fixed port, default `19432`, override `PLANNOTATOR_PORT`.
- No random-port discovery, no remote-mode branching, no share URLs.
- Headless or remote use is only through user-managed port forwarding.

# Out-of-scope deletions
Delete outright, not deprecate:
- `apps/marketing/`
- `apps/paste-service/`
- `apps/portal/` if present
- `packages/server/share-url.ts`
- `packages/ui/utils/sharing.ts`
- `packages/ui/hooks/useSharing.ts`
- Share UI in `packages/ui/components/`
- `PLANNOTATOR_SHARE_URL` and `PLANNOTATOR_PASTE_URL`
- `packages/server/remote.ts`
- `PLANNOTATOR_REMOTE`
- `apps/pi-extension/` unless explicitly retained as a thin CLI wrapper

Keep in place:
- `packages/server/integrations.ts`
- `apps/vscode-extension/`
- `packages/server/storage.ts`
- `packages/server/draft.ts`

# Tracker backlog map
Implementation slices:
- [[S-1]]: S-1 Strip remote collaboration surface area
- [[S-2]]: S-2 Define daemon state machine module
- [[S-3]]: S-3 Refactor per-mode servers into a multiplexed router
- [[S-4]]: S-4 Implement daemon process lifecycle
- [[S-5]]: S-5 Add submit, wait, state, and clear daemon endpoints
- [[S-6]]: S-6 Define the CLI surface around the daemon
- [[S-7]]: S-7 Add notifications for state transitions
- [[S-8]]: S-8 Refactor agent integrations into thin CLI clients
- [[S-9]]: S-9 Update build and packaging around the daemon artifact

Testing and proof tasks:
- [[S-9.5]]: Sprint-wide proof policy and shared TDD phase
- [[NIM-13]]: TDD for S-1 remote-surface deletion and build invariants
- [[NIM-14]]: TDD for S-2 state transition correctness
- [[NIM-15]]: TDD for S-3 multiplexed router behavior
- [[NIM-16]]: TDD for S-4 daemon lifecycle and recovery
- [[NIM-17]]: TDD for S-5 submit/wait/verdict semantics
- [[NIM-18]]: TDD for S-6 CLI contract and collision UX
- [[NIM-19]]: TDD for S-7 notification behavior
- [[NIM-20]]: TDD for S-8 agent wrapper behavior
- [[NIM-21]]: TDD for S-9 build, packaging, and install flow
- [[S-10]]: Final verification and proof execution

# Testing and validation policy
- The sprint requires a separate TDD and proof-authoring phase before verification is considered meaningful.
- Each implementation slice must have a paired TDD or proof task before completion.
- Acceptance proofs must target real behavior, including GUI-visible outcomes, daemon lifecycle, CLI behavior, recovery paths, and full workflow correctness.
- Writers may not patch or weaken tests after the proof harness is written; production code must be made to satisfy the frozen proofs.
- Expanding test scope after handoff must be tracked as explicit testing work rather than silently folded into implementation.

# Deferred decisions
- VS Code extension: leave untouched during the sprint, but verify compatibility before merge and file follow-up work if needed.
- Obsidian and Bear integrations: keep as-is unless the daemon changes break them.
- Cookie persistence vs `localStorage`: out of scope, but worth a follow-up once the fixed-port model lands.
- Pi extension fate: preferred outcome is deletion or rewrite as a thin CLI shell-out.

# Risk register
- Detached daemon spawning may be finicky cross-platform, especially on Windows.
- Browser-side state may assume per-session random ports and need a submission/session key.
- SSE may misbehave behind some proxies or forwarded sessions.
- Removing share and marketing surfaces may break build assumptions.
- The structured 409 response is a core UX surface and needs explicit review.
- Late test writing may drift into proving only internal consistency instead of externally visible correctness.

# Definition of done
1. The out-of-scope deletion set is merged and the tree builds clean.
2. `plannotator daemon {start,stop,status}` work as specified.
3. `plannotator submit <file>` notifies, opens the browser, blocks, and returns the verdict without per-invocation server startup.
4. Concurrent submit attempts produce the structured 409 response and the recovery commands actually work.
5. Daemon crash and restart preserve an in-flight verdict.
6. Claude Code and OpenCode become thin CLI wrappers and pass end-to-end smoke tests.
7. Real end-to-end proofs exist for each implementation slice, use real fixtures and commands, and pass without mocks or fake substitute data.
8. `README.md`, `CLAUDE.md`, and `AGENTS.md` describe the daemon model and no longer describe the removed remote-sharing path.
- 2026-04-29T04:17:09.526Z: commented
- 2026-05-02T03:41:49.731Z: status_changed (status) -> needs-review
- 2026-05-02T03:41:49.731Z: updated (progress) -> 100

## Revised P0 Priority Assessment (post-ChatGPT review - 2026-05-04)

Original P0s are directionally correct but need tightening:

1. **"Daemon crash leaves CLI hung"** — remains P0, but current `wait-recovery` tests only cover submitter-client crash, NOT daemon crash. Need explicit daemon-kill cases.
2. **"Concurrent hook invocations lose data or hang"** — P0, current contract is "single active request; later hooks get protocol-level deny with exit 0". Must prove non-overwrite and no stale active state.
3. **"Illegal-state errors lack recovery"** — P0 for normal collision flows. Recovery command must be EXECUTABLE (not just string assertion). Command must: exit successfully, daemon becomes idle, subsequent submit succeeds.
4. **NEW P0: Verdict delivery contract violation** — any case where approve/deny/cancel is lost, delivered to wrong waiter, delivered twice to unrelated commands, or blocks indefinitely.

## Highest-Impact Additions (from ChatGPT feedback)

- Daemon-kill tests (not just submitter kill)
- Executable recovery command tests (`plannotator clear --force` must actually work)
- Multi-waiter broadcast tests (exact semantics: request-addressed broadcast)
- Request identity/non-overwrite tests
- Fixed-port/wrong-daemon tests
- Signal handling tests (SIGINT→exit 130, SIGTERM to daemon during active request)

## Activity Log Addition
- 2026-05-04T06:30:00Z: updated E2E Test Plan with ChatGPT feedback; added 4th P0 for verdict delivery contract violation; clarified daemon crash testing gap
