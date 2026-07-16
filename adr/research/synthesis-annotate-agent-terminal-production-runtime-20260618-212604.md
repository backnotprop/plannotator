# Synthesis: Annotate Agent Terminal Production Runtime

Date: 2026-06-18

Status: Synthesis

## What The Research Says

The feature is conceptually right. Plannotator owns annotate mode and the browser-facing WebSocket. WebTUI owns terminal rendering and PTY behavior. Node owns the actual PTY through `node-pty`. Bun stays the main server runtime.

The production gap is specific: a compiled Bun binary can write the Node sidecar file to disk, but Node cannot import `@plannotator/webtui` from Bun's virtual filesystem. Local development hides this because repo `node_modules` exists.

So this is not a UI problem. It is a distribution/runtime problem.

The second real issue is the terminal WebSocket. A static, unauthenticated path is too loose for an endpoint that can start an agent in the user's working directory.

## What We Should Build

We should add a managed terminal runtime installed at Plannotator install time.

That runtime should live under the Plannotator data dir, versioned by the WebTUI version:

```text
~/.plannotator/vendor/agent-terminal/webtui-0.1.0/
```

It should contain a real `node_modules` tree with `@plannotator/webtui`, `node-pty`, and `ws`.

The compiled Plannotator binary should resolve the Node sidecar against that runtime. In source/dev mode it can keep using repo dependencies.

We should also add a tokenized WebSocket path:

```text
/api/agent-terminal/pty/<random-session-token>
```

`/api/plan` should return the tokenized path. The server should reject every other path.

## Best Implementation Shape

Use one Plannotator-owned runtime installer path, then have the platform installers call it.

Instead of duplicating `npm install` logic across `install.sh`, `install.ps1`, and `install.cmd`, add an internal CLI path like:

```text
plannotator install-runtime agent-terminal
```

The public installers should call that command after installing the binary. If it fails, installation still succeeds and the terminal feature degrades.

This keeps the cross-platform behavior in TypeScript/Bun code, where we can unit test it, while keeping shell scripts thin.

The runtime installer should:

- respect `PLANNOTATOR_SKIP_AGENT_TERMINAL_INSTALL=1`
- require Node 20+
- require npm
- install `@plannotator/webtui@0.1.0` into the managed runtime dir
- avoid audit/funding noise
- report install failure honestly
- print clear output

The runtime resolver should:

- detect source/dev mode vs compiled mode
- use repo imports in source/dev mode
- use the managed runtime in compiled mode
- materialize `agent-terminal-node-sidecar.mjs` into the managed runtime dir
- preflight Node imports before advertising the terminal as enabled

## Remote Mode

Remote mode is the only product decision still open.

Because remote mode binds `0.0.0.0`, the safest first release is to disable the terminal in remote mode unless explicitly enabled.

That does not mean remote users never get it. It means remote terminal support is opt-in until we deliberately support that threat model.

Suggested env flag:

```text
PLANNOTATOR_AGENT_TERMINAL_REMOTE=1
```

If remote mode is disabled, annotate still works. The terminal capability reports disabled with a clear reason.

## What Counts As Done

The feature is production-ready when:

- local compiled installs can start the terminal sidecar
- missing Node/npm/WebTUI runtime produces a disabled capability, not a broken Start button
- the WebSocket path is per-session and not guessable
- remote mode is either gated or explicitly supported
- release smoke tests exercise the actual terminal WebSocket, not just `/api/plan`

## Keep Out Of Scope

Do not add arbitrary terminal commands.

Do not install packages when the user clicks Start.

Do not redesign the annotate UI.

Do not fix every terminal lifecycle edge case in this production-runtime pass unless it is directly touched.

Do not make the browser responsible for diagnosing server runtime problems.

## Recommendation

Proceed with a focused implementation:

1. Tokenized terminal WebSocket.
2. Managed terminal runtime resolver and preflight.
3. Internal runtime install command.
4. Installer scripts call the runtime install command.
5. Release smoke test proves compiled binary terminal startup.

This keeps the feature lean while removing the two real release risks: broken compiled installs and an overly predictable terminal socket.
