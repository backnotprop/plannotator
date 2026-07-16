# Spec: Annotate Agent Terminal Production Runtime

Date: 2026-06-18

Status: Draft

## Intent

Make the annotate-mode WebTUI terminal safe and reliable in production compiled installs.

The user experience stays simple: if the terminal is available, the user can start one selected WebTUI built-in agent from annotate mode. If it is not available, annotate mode still works and the UI does not offer a broken Start flow.

## User-Facing Behavior

In local non-remote sessions, annotate mode shows the agent button when the server reports terminal capability.

The terminal only starts after the user chooses to start it.

If the production runtime is missing or broken, the terminal feature is disabled. The document annotation UI still loads normally.

Remote sessions do not enable the terminal by default. A user can opt in with:

```text
PLANNOTATOR_AGENT_TERMINAL_REMOTE=1
```

If remote terminal support is disabled, the UI should treat it like any other unavailable capability.

## Runtime Layout

Managed runtime location:

```text
~/.plannotator/vendor/agent-terminal/webtui-0.1.0/
```

Expected contents after install/runtime materialization:

```text
package.json
node_modules/@plannotator/webtui/
node_modules/node-pty/
node_modules/ws/
agent-terminal-node-sidecar.mjs
```

The sidecar file may be written by the compiled Plannotator binary at runtime. The npm dependencies must be installed by the installer path, not by the browser Start action.

## New Or Updated Environment Variables

```text
PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1
```

Skips managed terminal runtime installation during Plannotator install.

```text
PLANNOTATOR_AGENT_TERMINAL_REMOTE=1
```

Enables the terminal in remote mode after tokenized WebSocket protection is in place.

## Shared Types

Update `packages/shared/agent-terminal.ts`.

Keep this file browser-safe.

Add a base path and helper:

```ts
export const AGENT_TERMINAL_WS_BASE_PATH = "/api/agent-terminal/pty";
export function buildAgentTerminalWsPath(token: string): string;
```

Keep `AgentTerminalCapability.wsPath` as the browser-facing path returned by `/api/plan`.

Add disabled reasons:

```ts
| "remote-disabled"
| "runtime-unavailable"
```

Do not put Node filesystem or process logic in this browser-shared file.

## Server Runtime Resolver

Add `packages/server/agent-terminal-runtime.ts`.

Responsibilities:

- define `AGENT_TERMINAL_WEBTUI_VERSION`
- compute the managed runtime dir from `getPlannotatorDataDir()`
- decide source/dev mode vs compiled mode
- find `node`
- validate Node 20+
- validate managed WebTUI runtime in compiled mode
- materialize `agent-terminal-node-sidecar.mjs` into the runtime dir
- preflight sidecar imports with Node before `/api/plan` advertises enabled terminal support
- install the managed runtime for the internal install command

The preflight should not start an agent or allocate a PTY.

Suggested preflight command:

```text
node --input-type=module -e "await import('@plannotator/webtui/core'); await import('@plannotator/webtui/server')"
```

Run it with `cwd` set to the managed runtime dir so Node resolves the managed `node_modules`.

Use a short timeout and return a disabled capability on failure.

## Bun Bridge

Update `packages/server/agent-terminal.ts`.

Behavior:

- generate a random token per annotate server session
- set capability `wsPath` to the tokenized path
- expose a path matcher or validate inside `upgrade`
- reject static `/api/agent-terminal/pty`
- pass the tokenized path to the Node sidecar through `PLANNOTATOR_AGENT_WS_PATH`
- start Node with `cwd` or import URLs anchored to the resolved runtime
- keep lazy sidecar startup when the browser opens the terminal socket
- keep one active terminal session at a time

Bun bridge origin handling:

- if an `Origin` header is present, require it to match the request host
- allow missing origin for tests and non-browser clients
- keep remote mode gated separately

## Annotate Server

Update `packages/server/annotate.ts`.

Do not compare request paths to a shared static WebSocket path.

Instead, delegate to the bridge:

```ts
if (agentTerminal.matches(url.pathname)) {
  ...
}
```

`/api/plan` should return the bridge capability exactly as resolved.

## Pi Runtime

Update `apps/pi-extension/server/agent-terminal.ts` and `apps/pi-extension/server/serverAnnotate.ts`.

Pi does not need the compiled Bun managed runtime, but it should mirror the same browser-facing semantics:

- tokenized WebSocket path
- same capability shape
- same disabled reason for unsupported annotate modes
- one session at a time

The current Pi implementation uses WebTUI's Node WebSocket helper, which does not expose a separate `Origin` validation hook. Pi relies on the random path token and the same remote-mode opt-in gate unless WebTUI adds that hook or Plannotator replaces the helper.

If shared generated files are affected, update `apps/pi-extension/vendor.sh`.

## Internal Runtime Install Command

Add an internal CLI path in `apps/hook/server/index.ts`:

```text
plannotator install-runtime agent-terminal
```

This command should:

- call the server runtime installer
- print clear success, skip, or failure messages
- exit `0` on skip/success and nonzero on real install failure
- let installer scripts decide that terminal runtime failure is non-fatal for the overall Plannotator install

The installer implementation should create a minimal package in the runtime dir and run npm:

```text
npm install --omit=dev --no-audit --no-fund @plannotator/webtui@0.1.0
```

Do not use `--ignore-scripts`; `node-pty` may need install scripts.

## Install Scripts

Update:

- `scripts/install.sh`
- `scripts/install.ps1`
- `scripts/install.cmd`

After the binary is installed, call:

```text
plannotator install-runtime agent-terminal
```

The call is non-fatal. If Node/npm/package install fails, print a clear skip message and continue.

Respect:

```text
PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1
```

Keep the semantic diff sidecar logic unchanged.

## Release Workflow

Update `.github/workflows/release.yml`.

The compiled binary smoke test must cover the terminal runtime path:

1. install or prepare the managed terminal runtime in a temporary `PLANNOTATOR_DATA_DIR`
2. start compiled `plannotator annotate README.md`
3. fetch `/api/plan`
4. assert `agentTerminal.enabled === true`
5. open `ws://...${agentTerminal.wsPath}`
6. send a spawn request without an agent
7. assert the response is the expected WebTUI protocol error, not sidecar import failure

This proves Node can import the managed WebTUI runtime from a compiled Plannotator binary.

## Tests

Add or update focused tests:

- `packages/shared/agent-terminal.test.ts`
  - tokenized path helper
  - supported annotate modes still unchanged

- `packages/server/agent-terminal.test.ts`
  - disabled when feature off
  - disabled when remote mode is on without opt-in
  - enabled capability uses tokenized path
  - static path is not accepted
  - missing runtime reports `runtime-unavailable`

- `apps/pi-extension/server/agent-terminal.test.ts`
  - tokenized same-port WebSocket round trip
  - static path rejected
  - annotate-last remains disabled

- `scripts/install.test.ts`
  - all installers mention `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL`
  - all installers call `install-runtime agent-terminal`
  - call is non-fatal

- release smoke
  - compiled binary terminal WebSocket reaches sidecar successfully

## Non-Goals

Do not add arbitrary command entry.

Do not add multiple terminal sessions.

Do not install npm packages from the browser Start action.

Do not redesign the terminal panel.

Do not expand this feature to plan review, code review, archive, or `annotate-last`.

Do not solve file watching, git diff surfacing, or editor awareness in this pass.

## Acceptance Criteria

From source mode:

- annotate still starts
- terminal can start when WebTUI is installed
- tokenized WebSocket works
- Ask AI and Send Annotations still route to the ready terminal

From compiled binary mode:

- install command can prepare the managed runtime
- `/api/plan` advertises terminal enabled only when runtime preflight passes
- terminal WebSocket reaches the Node sidecar
- missing runtime disables terminal without breaking annotation

From remote mode:

- terminal is disabled by default
- opt-in enables the normal tokenized path flow

From release CI:

- binary smoke fails if the sidecar cannot import WebTUI

## Implementation Order

1. Add tokenized path helpers and bridge path validation.
2. Add remote-mode gating.
3. Add runtime resolver and preflight.
4. Add internal install command.
5. Wire install scripts to call the command.
6. Add tests.
7. Add compiled binary terminal smoke.
8. Run typecheck, focused tests, build, and smoke.
