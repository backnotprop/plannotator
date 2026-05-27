# Single Binary Runtime

Plannotator has one UI server runtime: the Bun server compiled into the released `plannotator` binary. Claude Code invokes that binary directly. OpenCode and Pi are binary clients.

The daemon runtime work is a stacked follow-on to the single-binary-runtime PR. The daemon PR should target `feat/single-server-runtime` / PR #733, not `main`.

## Phase One Boundary

OpenCode and Pi discover the binary with this order:

1. `PLANNOTATOR_BIN`
2. `plannotator` on `PATH`
3. Standard install locations such as `~/.local/bin/plannotator`

Clients call `plannotator plugin capabilities` first and require the versioned `plannotator-plugin` protocol. If the binary is missing or incompatible, clients can run the official installer unless `PLANNOTATOR_DISABLE_AUTO_INSTALL` is set.

The binary-owned plugin surface is:

- `plannotator plugin capabilities`
- `plannotator plugin plan --origin opencode|pi`
- `plannotator plugin review --origin opencode|pi`
- `plannotator plugin annotate --origin opencode|pi`

Requests and responses are JSON over stdin/stdout at the plugin boundary. Inside the binary, daemon-backed commands create sessions through a localhost HTTP daemon using the same stable request/result shapes.

## What Plugins Own

OpenCode owns OpenCode behavior: workflow/prompt transforms, `submit_plan`, backing-file edits, line-number denial feedback, slash-command interception, feedback injection, and agent switching.

Pi owns Pi behavior: phase state, tool gating, non-UI auto-approval, checklist progress, slash commands, current-session fallback, and `plannotator:request` / `plannotator:review-result` compatibility.

Neither plugin owns browser HTML assets, starts Plannotator HTTP servers, or ships the mirrored Pi `node:http` server.

## Daemon Runtime

The daemon is one long-running binary-owned service per user/machine environment. CLI and plugin commands auto-start it when no compatible daemon is running, then create session-scoped plan, review, and annotate sessions through the shared endpoint.

Lifecycle commands:

```bash
plannotator daemon start
plannotator daemon status
plannotator daemon stop
plannotator sessions
```

The daemon provides:

- session creation for plan, review, and annotate requests
- stable session IDs and session-scoped URLs such as `/s/<sessionId>`
- session-scoped API routing such as `/s/<sessionId>/api/...`
- decision delivery back to blocking callers such as Claude hooks
- async-compatible plugin behavior for OpenCode and Pi subprocess clients
- cancellation and TTL cleanup for abandoned sessions
- concurrent requests from Claude Code, OpenCode, Pi, Codex, Gemini, and Copilot without shared-state collisions

`packages/server/sessions.ts` is no longer the authoritative runtime registry for daemon-backed commands. `plannotator sessions` queries the daemon.

## Remote Mode

Daemon startup uses the same remote rules as the old request-scoped servers:

- local mode binds `127.0.0.1` and uses a random port unless `PLANNOTATOR_PORT` is set
- remote mode binds `0.0.0.0` and uses `PLANNOTATOR_PORT` or default `19432`
- `PLANNOTATOR_REMOTE=1` / `true` forces remote mode
- `PLANNOTATOR_REMOTE=0` / `false` forces local mode
- when `PLANNOTATOR_REMOTE` is unset, SSH environment variables still auto-detect remote sessions

Clients compare their requested remote/port settings to the running daemon. A local/remote mismatch or explicit port mismatch returns a stop/retry error instead of starting a parallel daemon.

## Future Phases

### 1. Single Binary Runtime

Status: completed in the single-server migration.

The released Bun binary is the only Plannotator server/UI runtime. OpenCode and Pi discover and call the installed binary instead of importing server code, copying browser HTML, or shipping a mirrored server.

### 2. Dumb Plugin Clients

Move more integration behavior behind the binary protocol so OpenCode and Pi do less local Plannotator work. The binary should own prompt formatting, command argument interpretation, content preparation, and config-driven Plannotator wording wherever practical.

The target shape is:

- plugin receives command/hook/event input
- plugin calls the binary with raw or lightly structured input
- binary returns exact actions/messages to inject
- plugin applies the result to its host agent

This phase should shrink or remove Pi's `vendor.sh` by eliminating most generated shared-helper imports from the Pi package.

### 3. True Multi-Session Daemon

Status: implemented in the stacked daemon-runtime branch.

`plannotator` runs as one long-running service that can host concurrent plan, review, and annotate sessions. It owns stable session IDs, session-scoped browser URLs and API routing, result delivery back to the requesting client, cancellation, cleanup, and collision-free state management across multiple agent runtimes.

### 4. Transport Swap

Keep the protocol shape from phase one, but allow OpenCode and Pi to call the daemon directly instead of launching `plannotator plugin ...` subprocesses. The current daemon branch keeps the public plugin command behavior stable while moving session ownership behind the binary.
