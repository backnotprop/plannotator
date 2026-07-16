# 2. Add WebTUI agent panel for annotate mode

Date: 2026-06-16

## Status

Accepted

## Context

Plannotator annotate mode supports reviewing a single file or a folder of files in the plan app. Users sometimes need to run a coding agent while annotating those files.

WebTUI provides an importable React terminal, xterm.js rendering, a real PTY through node-pty, built-in agent launch plans, PTY exit events, and PTY kill support.

The feature should keep annotate mode lightweight. Opening an annotate session must not start an agent process or allocate a PTY until the user explicitly starts one.

## Decision

We will add an optional WebTUI-powered agent terminal to `plannotator annotate` only.

This applies to single-file and folder annotation. It does not apply to plan review, code review, archive, goal setup, or `annotate-last`.

The panel will be opened from a top-left icon next to the existing sidebar controls. The icon will reuse the existing `ReviewAgentsIcon` used by code review agent jobs.

When open, the layout will be:

```text
[ Agent terminal panel ] [ Files/TOC sidebar ] [ Document ] [ Annotations/AI panel ]
```

The agent terminal panel will be separate from the file sidebar. It will be resizable and collapsible.

No agent starts automatically. The first open shows a small start view. The user selects an agent and starts it. The user may save that choice as the default for future annotate sessions.

The terminal launches one selected WebTUI built-in agent in the original Plannotator launch directory. It does not launch from the annotated file or folder path unless that was also the launch directory.

The first version will not provide an arbitrary command box, automatic prompt injection, annotation syncing, file-sidebar integration, multiple agents, or background agent jobs.

On stop or close, Plannotator will clean up the terminal process. The UI should first send interrupt input when appropriate, then kill the PTY if the agent does not exit. If the process exits on its own, WebTUI `onExit` will mark the panel stopped or close it.

The annotate server will expose the launch cwd to the browser and provide the WebTUI PTY backend/WebSocket support needed by the panel. The terminal WebSocket will use the same browser-facing origin and port as the annotate server.

The Bun annotate server will implement the browser-facing WebSocket route with Bun's WebSocket runtime and proxy it to a lazy Node sidecar running WebTUI's Node PTY WebSocket server. The sidecar binds loopback on a random internal port, starts only when the user starts the terminal, and is not exposed to the browser. This preserves same-origin browser behavior while using the Node runtime path that WebTUI's examples use.

The Pi Node annotate server will attach WebTUI's Node WebSocket server to the existing Node HTTP server. Both runtimes should expose the same browser-facing path and capability shape.

Server shutdown must clean up any active PTY session. In the Bun runtime, the sidecar must also exit when the Bun parent exits or closes its parent-death pipe.

If Pi annotate support is included, the Pi Node annotate server must mirror the Bun annotate server support.

## Consequences

Annotate sessions stay lightweight until the user starts an agent.

Users can inspect files and run an agent in the same workspace while annotating.

The feature adds a WebTUI dependency to Plannotator. Before shipping, WebTUI must be available as a real dependency through publishing, vendoring, or another explicit package strategy.

The feature depends on node-pty. If WebTUI or node-pty cannot load on a user's machine, annotate mode must continue to work and the agent terminal should be disabled with a clear message.

The server gains PTY/WebSocket lifecycle responsibility for annotate sessions.

Using the existing Plannotator browser-facing port avoids extra port-forwarding friction in remote, SSH, and devcontainer sessions.

The Bun runtime has one extra moving part: a Node sidecar process after terminal start. This is intentional. Local verification showed WebTUI's `NodePtyBackend` under Bun could launch the PTY but delivered no terminal data, while the same backend under Node delivered shell and Claude output correctly. The sidecar keeps the risky runtime boundary small and isolated to terminal transport.

The first version is intentionally narrow. Broader integration with review mode, plan mode, annotate-last, annotation context, or agent jobs can be considered later.
