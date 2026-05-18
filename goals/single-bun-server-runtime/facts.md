# Facts

- Phase one delivers one Plannotator server runtime: the Bun server used by the released `plannotator` binary is the only implementation that serves plan, review, annotate, and archive UI flows.
- The Pi extension no longer ships, builds, vendors, or calls its mirrored `node:http` server implementation under `apps/pi-extension/server/`.
- The OpenCode plugin no longer imports `@plannotator/server` or starts Plannotator HTTP servers inside the OpenCode plugin process.
- The OpenCode and Pi packages do not package Plannotator browser HTML assets as plugin-owned runtime payloads.
- OpenCode and Pi become clients of the installed `plannotator` binary rather than owners of Plannotator server/runtime code.
- The binary/client boundary is designed daemon-first, even if the first implementation may still use existing Bun session machinery behind that boundary.
- The plan identifies the full daemon endpoint as a long-running Plannotator service that can manage multiple concurrent plan/review/annotate sessions from multiple agents.
- The plan does not treat the current single-session ephemeral server model as sufficient for the final daemon architecture; it calls out session IDs, routing, decisions, cleanup, and concurrency as daemon work.
- OpenCode keeps only OpenCode-specific behavior: submit-plan tool registration, backing-file line edits, workflow/prompt behavior, slash-command interception, and session feedback injection.
- Pi keeps only Pi-specific behavior: phase state, tool gating, slash commands, current-session fallback, and `plannotator:request` event-channel compatibility.
- Both OpenCode and Pi discover the installed binary using an explicit override, PATH, and standard Plannotator install locations before attempting installation.
- If the required binary is missing, OpenCode and Pi can automatically install the official Plannotator binary instead of bundling a binary inside the plugin package.
- Plugins verify that the installed binary supports the required integration surface and report a clear error or install/update path when it is missing or incompatible.
- Claude Code hooks, OpenCode `submit_plan`, OpenCode `/plannotator-*` commands, Pi plan mode, Pi `/plannotator-*` commands, and Pi event-channel integrations continue to work after the migration.
- The migration does not redesign the UI, change annotation data formats, rename user-facing commands, or replace the existing release binary build pipeline.
- Automated tests cover binary discovery/install behavior, plugin-to-binary command behavior, and the absence of plugin-owned server/HTML runtime dependencies.
