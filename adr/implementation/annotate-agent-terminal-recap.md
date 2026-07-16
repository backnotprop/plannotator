# Annotate Agent Terminal Handoff

Updated: 2026-06-18

Status: implemented and verified on PR #941.

PR: https://github.com/backnotprop/plannotator/pull/941

## Summary

Plannotator annotate mode now has an optional WebTUI-backed coding agent terminal for single-file and folder annotation sessions.

The feature stays narrow:

- Works for `plannotator annotate <file>` and `plannotator annotate <folder>`.
- Does not run for plan review, code review, archive, goal setup, or `annotate-last`.
- Starts only after the user opens the agent panel and clicks Start.
- Launches exactly one selected WebTUI built-in agent at a time.
- Launches in the directory where Plannotator was started.
- Rebuilds the actual launch command on the server side; the browser only selects the agent and terminal size.
- Renders as a separate resizable panel to the left of the normal file/sidebar area.
- Allows hiding the panel without killing the running session.
- Stops through WebTUI/PTY lifecycle: interrupt first, then kill if needed.

Ask AI and Send Annotations can route into the running terminal agent when it is ready. When no terminal agent is ready, existing provider/server feedback paths remain available.

## Current Runtime Shape

The browser always talks to the normal Plannotator annotate server origin.

The browser-facing terminal WebSocket path is now tokenized per annotate server session:

```text
/api/agent-terminal/pty/<random-token>
```

The static path is rejected. `/api/plan` returns the only valid `agentTerminal.wsPath` for that session.

## Bun Runtime

The Bun annotate server owns the browser-facing WebSocket. The actual PTY runs in a lazy Node sidecar because WebTUI's `node-pty` path is reliable under Node.

Flow:

1. Annotate server starts and resolves terminal capability.
2. If terminal support is available, `/api/plan` returns cwd, available agents, and a tokenized `wsPath`.
3. Browser opens the tokenized same-origin WebSocket only after the user starts the terminal.
4. Bun validates the path and same-host `Origin`.
5. Bun starts the Node sidecar lazily on the first terminal socket.
6. Node sidecar imports WebTUI server modules, binds a loopback internal WebSocket, and owns `node-pty`.
7. Bun proxies between browser socket and sidecar socket.
8. Sidecar validates the requested built-in agent and forces the configured Plannotator cwd.

Important files:

- `packages/server/annotate.ts`
- `packages/server/agent-terminal.ts`
- `packages/server/agent-terminal-runtime.ts`
- `packages/server/agent-terminal-node-sidecar.mjs`
- `packages/shared/agent-terminal.ts`

## Production Runtime

Compiled Bun binaries cannot let Node import WebTUI from Bun's bundled virtual filesystem. The fix is a managed on-disk terminal runtime installed under the Plannotator data dir:

```text
~/.plannotator/vendor/agent-terminal/webtui-0.1.0/
```

Expected contents:

```text
package.json
node_modules/@plannotator/webtui/
node_modules/node-pty/
node_modules/ws/
agent-terminal-node-sidecar.mjs
```

Plannotator now has an internal repair/install command:

```bash
plannotator install-runtime agent-terminal
```

The command:

- requires Node 20+ and npm
- installs `@plannotator/webtui@0.1.0`
- allows `node-pty` install scripts
- preflights Node imports for `@plannotator/webtui/core` and `@plannotator/webtui/server`
- exits successfully for skip/success cases and exits nonzero for real install failures

Installers call this command after installing the binary:

- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/install.cmd`

Installer scripts keep this runtime optional: if `plannotator install-runtime agent-terminal` fails because Node/npm or the network is unavailable, Plannotator still installs and annotate mode runs without the integrated terminal.

Opt out:

```bash
PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1
```

If the runtime is missing or broken, annotate mode still loads and `/api/plan` reports:

```json
{ "enabled": false, "reason": "runtime-unavailable" }
```

## Remote Mode

Remote mode binds the Plannotator server to `0.0.0.0`, so the terminal is disabled by default in remote sessions.

Opt in explicitly:

```bash
PLANNOTATOR_AGENT_TERMINAL_REMOTE=1
```

Even with opt-in, the Bun terminal bridge still uses the tokenized WebSocket path and same-host `Origin` validation.

## Pi Runtime

The Pi extension server runs on Node, so it does not need the Bun sidecar or managed compiled-binary runtime.

It mirrors the browser-facing contract:

- tokenized WebSocket path served by the annotate server
- same `agentTerminal` capability shape
- one terminal session at a time
- unsupported modes stay disabled

Unlike the Bun bridge, the current Pi/WebTUI helper path does not perform a separate `Origin` check. Its practical protections are the random path token and the same remote-mode opt-in gate.

Important files:

- `apps/pi-extension/server/serverAnnotate.ts`
- `apps/pi-extension/server/agent-terminal.ts`
- `apps/pi-extension/server/agent-terminal.test.ts`

Generated shared copies under `apps/pi-extension/generated/` are ignored and regenerated by:

```bash
bash apps/pi-extension/vendor.sh
```

## UI Behavior

The UI adds a top-left agent icon next to the existing sidebar controls.

The panel includes:

- available-agent selector
- Start button
- compact settings popover for terminal display
- compact Stop control
- full-bleed WebTUI/xterm terminal surface

The redundant agent header was removed. When running, the first row is the agent name, cwd context, settings, and stop action.

The terminal intentionally has no rounded card frame or extra padding around xterm. The xterm scrollbar gap is hidden so the terminal fills the panel cleanly.

Important files:

- `packages/editor/App.tsx`
- `packages/editor/components/AnnotateAgentTerminalPanel.tsx`
- `packages/editor/components/annotateAgentTerminalTheme.ts`
- `packages/editor/index.css`
- `packages/ui/utils/annotateAgentTerminal.ts`

## Theming

Terminal colors are derived from active Plannotator CSS theme tokens.

The browser reads live CSS variables where possible, then maps them into xterm/WebTUI options. Static theme presets are fallback data, not the primary source.

This fixed the earlier gray/brown/default terminal look and makes the terminal follow Plannotator light/dark themes more closely.

Relevant files:

- `packages/editor/components/annotateAgentTerminalTheme.ts`
- `packages/editor/components/annotateAgentTerminalTheme.test.ts`
- `packages/ui/theme.css`

## Ask AI And Send Annotations

When a terminal agent is running and ready:

- Ask AI sends the question into the visible agent through WebTUI.
- File-backed asks include the active file path and tell the agent to read the file from disk.
- Selected/context text is included so the agent knows what the user asked about.
- Send Annotations sends exported annotation feedback into the same terminal agent.
- Duplicate sends for the same terminal session, target, and feedback body are blocked.
- Successful in-panel sends do not show extra toast noise.
- The comment popover closes after sending to the agent.

When no terminal agent is ready, existing Ask AI and feedback behavior remains in place.

Important files:

- `packages/editor/App.tsx`
- `packages/editor/agentTerminalIntegration.ts`
- `packages/editor/agentTerminalIntegration.test.ts`
- `packages/ui/components/CommentPopover.tsx`

## Draft And Feedback Hardening

This work also included related cleanup that should stay with the feature:

- annotation draft generations and tombstones to prevent stale autosaves from resurrecting sent drafts
- centralized feedback template helpers shared across runtimes

Important files:

- `packages/shared/draft.ts`
- `packages/shared/draft.test.ts`
- `packages/ui/hooks/useAnnotationDraft.ts`
- `packages/ui/hooks/useCodeAnnotationDraft.ts`
- `packages/ui/annotationDraftPersistence.test.tsx`
- `packages/shared/feedback-templates.ts`
- `packages/shared/feedback-templates.test.ts`

## Package State

Plannotator consumes:

```json
"@plannotator/webtui": "^0.1.0"
```

The package is published as `@plannotator/webtui@0.1.0`.

React and ReactDOM remain peer dependencies of WebTUI. Plannotator owns the React runtime, avoiding duplicate-React issues.

Do not reintroduce local `file:` dependencies for WebTUI.

## ADR

Earlier accepted ADR: `adr/0002-add-webtui-agent-panel-for-annotate-mode.md`.

## Verification

Current verification completed locally:

```bash
bun test packages/shared/agent-terminal.test.ts packages/server/agent-terminal.test.ts apps/pi-extension/server/agent-terminal.test.ts scripts/install.test.ts
bun run typecheck
bun run build:hook
bun run build:pi
git diff --check
```

Additional smoke checks completed:

- `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1 bun apps/hook/server/index.ts install-runtime agent-terminal`
- real temp `install-runtime agent-terminal` into a temp `PLANNOTATOR_DATA_DIR`
- compiled Bun binary smoke with installed managed runtime:
  - install runtime
  - start `plannotator annotate README.md`
  - fetch `/api/plan`
  - connect to returned tokenized terminal WebSocket
  - send a spawn request without an agent
  - confirm the sidecar returns WebTUI's expected protocol error
- compiled Bun binary smoke without managed runtime:
  - start `plannotator annotate README.md`
  - confirm `/api/plan` reports `runtime-unavailable`
- release workflow YAML parses successfully

`actionlint` was not installed locally, so the GitHub Actions-specific linter was not run.

## Release Workflow

`.github/workflows/release.yml` now smoke-tests the compiled binary terminal path on Linux and Windows.

The smoke test prepares a temporary managed runtime, starts annotate, fetches `/api/plan`, opens the returned tokenized WebSocket, and verifies the Node sidecar responds through WebTUI's protocol.

This is important because the previous release smoke only proved `/api/plan` loaded. It did not prove Node could import WebTUI from a compiled install.

## Known Non-Goals

This feature does not add:

- arbitrary terminal command entry
- multiple simultaneous terminal agents
- terminal persistence or saved scrollback
- file tree live watching
- git changed-file badges
- agent attribution for disk edits
- plan review or code review terminal support
- `annotate-last` terminal support

## Follow-Up Work

Useful follow-ups:

- run `actionlint` or CI to validate the edited release workflow
- decide whether to promote the ADR draft into an accepted formal ADR
- add live file-tree invalidation for annotate folders
- add git-backed changed-file surfacing and lazy diffs
- add editor disk-change awareness for files modified by agents
- consider a smaller server-only WebTUI package later if install weight matters
- consider prebuilt platform-specific terminal runtime archives if `node-pty` installation friction appears in the field
