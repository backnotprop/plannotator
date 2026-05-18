# Daemon Serves The Frontend Shell

Wire the long-running Plannotator daemon to serve the new `apps/frontend` React shell as the local runtime application. The daemon should own the shell at `/` and `/s/<sessionId>`, while existing per-mode backend APIs continue to run behind `/s/<sessionId>/api/*`.

Use [facts.md](./facts.md) as the accepted behavior contract. Use [plan.md](./plan.md) as the execution plan.

Done means the daemon serves the single-file frontend shell for daemon-backed sessions, the shell bootstraps real daemon sessions through the existing API contract, direct non-daemon servers remain on their current HTML path, and the verification commands in `plan.md` pass.
