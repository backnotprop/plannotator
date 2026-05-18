# Single Plannotator Binary Runtime

Move Plannotator to one canonical Bun/binary-owned server runtime. OpenCode and Pi should become clients of the installed `plannotator` binary, keeping only agent-specific integration behavior while removing plugin-owned server/runtime implementations and browser asset payloads.

The shared understanding is in [facts.md](facts.md). The approved execution plan is in [plan.md](plan.md).

Done when the accepted facts are verified, the current OpenCode and Pi functionality inventory has been checked for parity, OpenCode and Pi no longer own or package Plannotator server/runtime code, and the binary/client boundary is ready to evolve into the full multi-session daemon architecture.

## Future Phases

1. Single binary runtime: completed by this goal. OpenCode and Pi no longer own Plannotator server implementations or browser HTML payloads; they call the installed binary.
2. Dumb plugin clients: move remaining prompt formatting, command parsing, content preparation, and shared helper usage behind the binary protocol where practical. Pi/OpenCode should mainly receive events, call the binary, and inject returned actions/messages. This is where Pi `vendor.sh` should shrink further or disappear.
3. True daemon: turn `plannotator` into one long-running multi-session service with session IDs, session-scoped routes, decision delivery, cancellation/TTL cleanup, and safe concurrency across Claude Code, OpenCode, Pi, Codex, Gemini, and Copilot.
4. Transport swap: keep the protocol shape but change OpenCode/Pi from subprocess-backed `plannotator plugin ...` calls to IPC or HTTP calls against the daemon.
