# Facts

- Plannotator has a real long-running binary-owned daemon process that can serve multiple browser sessions instead of starting a separate request-scoped server for every plan, review, annotate, or archive request.
- There is one normal Plannotator daemon per user/machine environment, and it is the authoritative owner of active session registry, ports, and daemon-backed command state.
- Daemon-backed CLI and plugin commands connect to the daemon instead of owning session state themselves; trivial bootstrap commands such as help, version, start, status, and stop may still run directly in the CLI process.
- The first daemon transport is localhost HTTP, with protocol types kept reusable so a future IPC transport can implement the same request and result shapes.
- CLI and plugin requests connect to the single Plannotator daemon; if it is not running they auto-start it, and if a compatible daemon is already running they reuse it.
- When daemon discovery finds missing, stale, unhealthy, or protocol-incompatible daemon state, clients recover by starting or reconnecting to a compatible daemon when safe, or report a clear actionable error instead of spawning parallel daemons.
- Plannotator provides basic daemon lifecycle commands for users and debugging, including commands to start the daemon, check its status, and stop it.
- Daemon status reports enough information to understand what is running, including daemon PID, port or endpoint, protocol/version compatibility, and active session count.
- Every plan, review, annotate, and archive request creates or uses a stable session ID that uniquely identifies that browser session and its result state.
- All sessions live under the same daemon endpoint and port, with session-scoped browser URLs and API routes so concurrent Plannotator sessions cannot read or mutate each other's state and the architecture can later grow into one UI that shows all sessions.
- The daemon supports both blocking callers, such as Claude hook decisions, and asynchronous callers, such as OpenCode and Pi, which can launch a session and receive or inject results later.
- Multiple concurrent requests from Claude Code, OpenCode, Pi, Codex, Gemini, Copilot, or direct CLI usage can run without state collisions.
- Daemon sessions support cancellation and TTL cleanup so abandoned browser sessions and waiting client requests do not leak forever.
- Remote mode continues to work with the daemon: PLANNOTATOR_REMOTE, PLANNOTATOR_PORT, SSH/devcontainer detection, browser-open fallback behavior, and reachable session URLs are handled deliberately for the shared daemon endpoint.
- Existing Claude Code hook and CLI flows, OpenCode binary-client calls, Pi binary-client calls, review, annotate, annotate-last, archive, and remote-mode URL behavior continue to work through the daemon migration.
- The existing `plannotator plugin ...` command surface becomes a daemon client under the hood rather than a request-scoped server launcher, without requiring OpenCode or Pi to change their public command behavior.
- This daemon goal does not redesign the UI, change annotation data formats, or introduce a hosted/cloud daemon.
- Broad dumb-plugin-client cleanup, Pi `vendor.sh` removal, and plugin publishing changes are out of scope unless a narrow change is required for daemon connectivity.
