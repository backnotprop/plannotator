# Spike: Annotate Agent Terminal Production Runtime

Date: 2026-06-18

Status: Research

## Goal

Decide what Plannotator needs before shipping the annotate-mode WebTUI terminal to a large user base.

The feature already works in local development: annotate mode can show a WebTUI terminal, launch one selected coding agent, route Ask AI / Send Annotations into that running agent, and theme the terminal from Plannotator's active theme.

The remaining question is production reliability: how the compiled Bun CLI, Node sidecar, WebTUI package, WebSocket route, installers, and release smoke tests should fit together.

## Current Runtime Shape

The browser renders the terminal through `@plannotator/webtui/react`.

The Bun annotate server owns the browser-facing endpoint. In `packages/server/annotate.ts`, `/api/plan` returns `agentTerminal` capability metadata, and `/api/agent-terminal/pty` upgrades to a WebSocket.

The Bun WebSocket bridge lives in `packages/server/agent-terminal.ts`.

The actual PTY runs in Node, not Bun. Bun starts `packages/server/agent-terminal-node-sidecar.mjs`, and that sidecar imports `@plannotator/webtui/core` and `@plannotator/webtui/server`.

The sidecar binds to `127.0.0.1` on a random internal port. The browser never sees that port. The browser only connects to Plannotator's normal annotate server port.

The Pi runtime is separate Node server code. It should keep the same browser-facing capability shape and route semantics.

## Verified Production Gap

The compiled Bun binary can materialize `agent-terminal-node-sidecar.mjs` to a real file under the Plannotator data dir.

That is not enough. Node still has to import `@plannotator/webtui` from a real on-disk `node_modules`.

In local development, this works because repo `node_modules` exists.

In a compiled Bun binary, `import.meta.resolve("@plannotator/webtui/core")` can point at Bun's bundled virtual filesystem. Node cannot import packages from that virtual filesystem.

The practical failure mode is bad: `/api/plan` can advertise the terminal as enabled, but clicking Start fails because the Node sidecar exits before reporting ready.

So the release blocker is not the React panel. It is the production terminal runtime.

## Existing Patterns In The Repo

The closest existing pattern is the semantic diff sidecar:

- Install scripts place a managed optional runtime under `~/.plannotator/vendor/sem/<version>/`.
- Runtime code prefers the managed binary when it exists.
- Install failure is non-fatal. Plannotator still installs and the optional feature degrades.
- The install is bounded and explicit, not a surprise network operation during normal app use.

The compiled binary already has one smaller materialization pattern in `packages/server/codex-review.ts`: schema JSON is embedded in Bun and written to a real file because an external process cannot read Bun virtual paths.

There is no current pattern for doing `npm install` at first terminal launch. That is good. We should not create one for this feature.

## Recommended Design

Use an installer-managed terminal runtime.

Proposed location:

```text
~/.plannotator/vendor/agent-terminal/webtui-0.1.0/
```

Contents:

```text
agent-terminal-node-sidecar.mjs
package.json
node_modules/
```

The installed `node_modules` must include `@plannotator/webtui@0.1.0` and its server-side dependencies, especially `node-pty` and `ws`.

The install scripts should create this runtime during Plannotator installation, after the main binary lands. This should follow the semantic diff sidecar style:

- skip env var, for example `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1`
- Node version check, because WebTUI requires Node 20+
- non-fatal failure
- clear install output
- versioned install directory
- no runtime network install from the browser click path

Runtime behavior should be honest:

- In source/dev mode, use the repo dependency path.
- In compiled mode, use the managed runtime under the data dir.
- If the managed runtime is missing or broken, `/api/plan` should report `agentTerminal.enabled: false` with a useful message.
- The UI should not show a Start button for a terminal that cannot start.

The Node sidecar should run from the managed runtime directory, or receive file URLs that point into that directory. Bare imports are acceptable only if Node module resolution is anchored in the managed runtime.

## WebSocket Protection

The current terminal WebSocket path is static:

```text
/api/agent-terminal/pty
```

That is too weak for this endpoint because the endpoint can start a terminal-backed coding agent in the user's working directory.

Use a random per-session token in the path:

```text
/api/agent-terminal/pty/<session-token>
```

The server should generate the token when the annotate server starts, return the tokenized `wsPath` from `/api/plan`, and reject upgrades that do not match.

This is not "enterprise auth." It is a simple same-session secret so a predictable endpoint is not enough to drive the terminal.

Also validate the request origin host where the runtime exposes enough information to do it cleanly.

Remote mode needs an explicit product decision. Because remote mode binds `0.0.0.0`, the safest first release is either:

- disable the terminal in remote mode by default, with an opt-in env var/config flag, or
- allow remote mode only after the tokenized path and origin check are in place.

For broad release, the conservative path is remote disabled by default until we intentionally support that threat model.

## Release Verification Needed

Add tests that hit the real failure points:

1. Unit test capability generation for enabled, disabled, missing runtime, and tokenized path.
2. Bun server WebSocket smoke test in source mode.
3. Compiled binary smoke test that starts `plannotator annotate README.md`, fetches `/api/plan`, opens the returned `agentTerminal.wsPath`, sends a spawn request, and expects a real protocol response rather than sidecar import failure.
4. Installer tests for the shell, PowerShell, and cmd installers so the managed terminal runtime does not silently disappear from release flow.

The current release smoke only checks that `/api/plan` responds. That does not prove the sidecar can import WebTUI or start a PTY.

## What Not To Do

Do not install `@plannotator/webtui` on first Start click. That creates a slow, network-dependent, hard-to-debug user interaction.

Do not advertise the terminal as enabled unless the server has enough evidence that the runtime can actually start.

Do not bundle this as a raw browser terminal that accepts arbitrary commands. The shipped surface should remain "launch one selected WebTUI built-in agent in the Plannotator launch directory."

Do not make the UI own production runtime errors. The server should expose an honest capability state.

## Open Decisions

Remote terminal support for the first public release:

- Preferred: off by default in remote mode.
- Alternative: on after tokenized socket and origin validation.

Installer implementation depth:

- First pass: npm-managed runtime directory.
- Later improvement: prebuilt platform-specific terminal runtime archives if `node-pty` installation friction is too high.

Package split:

- Current `@plannotator/webtui` package works.
- A future `@plannotator/webtui-server` package could reduce install weight, but it is not required to ship this safely.

## Proposed Implementation Order

1. Add tokenized WebSocket paths and remote-mode gating.
2. Add terminal runtime resolver and preflight. Make `/api/plan` honest.
3. Add installer-managed terminal runtime to `install.sh`, `install.ps1`, and `install.cmd`, following the semantic diff sidecar pattern.
4. Add release smoke coverage for compiled annotate terminal startup.
5. Address smaller UI lifecycle edge cases after the production path is proven.

## Bottom Line

The feature's architecture is sound: Bun owns Plannotator, Node owns the PTY, and WebTUI owns terminal behavior.

The production release needs one missing layer: a managed on-disk terminal runtime that Node can import from a compiled Plannotator install.

Once that exists, the server can reliably advertise the feature, the UI can stay simple, and failures become normal optional-feature degradation instead of a broken Start button.
