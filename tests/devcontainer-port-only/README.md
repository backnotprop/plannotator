# Plannotator Test - Port Only (Expected to Fail)

This test simulates the common misconfiguration reported by users running `opencode web` in Docker: setting only `PLANNOTATOR_PORT` without `PLANNOTATOR_REMOTE`.

## Setup

Before opening in a devcontainer, create the auth symlink from your host machine:

```bash
mkdir -p .opencode
ln ~/.local/share/opencode/auth.json .opencode/auth.json
```

## The Problem

Users in Docker/devcontainer environments often set:
```bash
PLANNOTATOR_PORT=9999
```

But forget to set:
```bash
PLANNOTATOR_REMOTE=1
```

Without `PLANNOTATOR_REMOTE=1` (and no `SSH_TTY`/`SSH_CONNECTION` in the environment), the plugin will:
1. ✅ Use port 9999
2. ❌ Still try to open a browser (fails silently or hangs)

## Expected Behavior

When you trigger a plan in this devcontainer:
- Server starts on port 9999
- Plugin attempts to open browser (fails)
- No feedback to user
- Appears to hang

## The Fix

Users need BOTH environment variables:
```bash
PLANNOTATOR_REMOTE=1
PLANNOTATOR_PORT=9999
```

See `tests/devcontainer/` for the correct configuration.

## Testing

1. Open this folder in VS Code
2. Reopen in Container
3. Run `opencode web` to start the web interface
4. Access OpenCode via the forwarded port (usually 4096)
5. Ask for a plan
6. Observe the hang/failure - nothing on port 9999
7. Compare with `tests/devcontainer/` which works correctly
