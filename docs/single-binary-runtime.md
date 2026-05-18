# Single Binary Runtime

Plannotator has one UI server runtime: the Bun server compiled into the released `plannotator` binary. Claude Code invokes that binary directly. OpenCode and Pi are binary clients.

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
- `plannotator plugin archive --origin opencode|pi`

Requests and responses are JSON over stdin/stdout today. The protocol is intentionally transport-neutral so the same request and result shapes can be implemented by an IPC or HTTP daemon later.

## What Plugins Own

OpenCode owns OpenCode behavior: workflow/prompt transforms, `submit_plan`, backing-file edits, line-number denial feedback, slash-command interception, feedback injection, and agent switching.

Pi owns Pi behavior: phase state, tool gating, non-UI auto-approval, checklist progress, slash commands, current-session fallback, and `plannotator:request` / `plannotator:review-result` compatibility.

Neither plugin owns browser HTML assets, starts Plannotator HTTP servers, or ships the mirrored Pi `node:http` server.

## Daemon Next

Phase one is daemon-ready, not the final daemon. The current binary still starts request-scoped browser sessions behind the plugin protocol. The follow-on daemon should be one long-running binary-owned service with:

- session creation for plan, review, annotate, and archive requests
- stable session IDs returned before human review completes
- session-scoped browser URLs and API routing
- decision delivery back to the requesting client
- cancellation and TTL cleanup for abandoned sessions
- concurrent requests from Claude Code, OpenCode, Pi, Codex, Gemini, and Copilot without state collisions

The current `packages/server/sessions.ts` registry is a session discovery aid, not the final multi-session daemon.

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

Turn `plannotator` into one long-running service that can host concurrent plan, review, annotate, and archive sessions. This requires stable session IDs, session-scoped browser URLs and API routing, result delivery back to the requesting client, cancellation, cleanup, and collision-free state management across multiple agent runtimes.

### 4. Transport Swap

Keep the protocol shape from phase one, but replace subprocess-backed `plannotator plugin ...` calls with IPC or HTTP calls to the daemon. OpenCode and Pi should not need another behavior rewrite if the protocol remains stable.
