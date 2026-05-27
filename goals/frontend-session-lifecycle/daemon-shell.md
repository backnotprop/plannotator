# Daemon Shell HTML — How It Works

## Production (default)

The daemon serves the production frontend (`apps/frontend/dist/index.html`) at all session URLs (`/s/:id`). This HTML is statically imported in `apps/hook/server/daemon-shell-html.ts` and bundled into the compiled binary.

When the CLI creates a session, it opens the daemon's URL in the browser. The production frontend mounts, TanStack Router matches `/s/:id`, and the session surface renders. The daemon injects a `<script>` that sets `window.__PLANNOTATOR_API_BASE__` to rewrite API calls to the session-scoped path (`/s/:id/api/...`).

## Debug shell (dev-only)

Set `PLANNOTATOR_DEBUG_SHELL=1` to serve the debug frontend (`apps/debug-frontend/`) instead. This is a separate prototype app for inspecting daemon internals — WebSocket event streams, connection state, session lifecycle. It is **not** a substitute for the production frontend and cannot review plans or code.

The debug shell is **never bundled** in the compiled binary. It's read from disk at runtime via `Bun.file()`. If the file doesn't exist, the flag silently falls back to the production frontend.

### Developer setup for debug shell

```bash
# 1. Build the debug frontend (creates apps/debug-frontend/dist/index.html)
bun run build:debug-frontend

# 2. Start with the flag
PLANNOTATOR_DEBUG_SHELL=1 bun run dev:frontend
```

If you skip the build step, the flag does nothing — no error, just the production UI.

### Why it's not distributed

The debug shell is a development tool, not a user-facing feature. It has no session surfaces, no plan review, no code review. Distributing it in the binary would add dead weight and confuse users. The env var exists solely for developers working in the repo.

## Build dependency

The production frontend must be built before the daemon binary is compiled:

```bash
bun run --cwd apps/frontend build    # builds dist/index.html
bun build apps/hook/server/index.ts --compile --outfile ~/.local/bin/plannotator
```

The `build:hook` script should include this step. See CLAUDE.md's "Build order matters" section.

## File reference

| File | Role |
|------|------|
| `apps/hook/server/daemon-shell-html.ts` | Imports production HTML, optional runtime disk read for debug |
| `apps/hook/server/index.ts` | Calls `loadDaemonShellHtml()` and passes result to daemon runtime |
| `apps/frontend/dist/index.html` | Built production frontend (single-file, includes all JS/CSS) |
| `apps/debug-frontend/dist/index.html` | Built debug shell (only exists locally after `build:debug-frontend`) |
| `packages/server/daemon/server.ts` | Serves shell HTML at `/s/:id`, injects API base script |
