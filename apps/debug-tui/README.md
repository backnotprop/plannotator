# @plannotator/debug-tui

Terminal UI agent simulator for testing daemon sessions. **Not production code** — this exercises
Plannotator's real agent protocols against the daemon runtime using local fixtures.

The simulator spawns the same `plannotator` commands that agents use, writes realistic stdin
payloads, captures stdout/stderr, watches for `PLANNOTATOR_SESSION_READY`, and can complete sessions
through the daemon-scoped browser API. Multiple sessions can run concurrently.

## Commands

```bash
bun run --cwd apps/debug-tui start
bun run --cwd apps/debug-tui run -- --scenario opencode-plan
bun run --cwd apps/debug-tui test:e2e
```

Or from the repo root:

```bash
bun run dev:debug-tui
bun run check:debug-tui
bun run dev:debug-stack    # starts daemon + opens browser + launches TUI
```

## TUI keys

- `Enter` — start selected scenario
- `a` — start all scenarios concurrently
- `m` — toggle manual/auto-complete mode
- `c` — copy latest log to clipboard
- `p` — copy log file path
- `q` — quit

Fixtures are local: temporary workspaces, local git repositories, markdown/html files, and archived
plan files. External hosted agents, live PR URLs, and hosted sharing services are not required.
