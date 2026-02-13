---
title: "Environment Variables"
description: "Complete reference for all Plannotator environment variables."
sidebar:
  order: 30
section: "Reference"
---

All Plannotator environment variables and their defaults.

## Core variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_REMOTE` | auto-detect | Set to `1` or `true` to force remote mode. Uses fixed port and skips browser auto-open. |
| `PLANNOTATOR_PORT` | random (local) / `19432` (remote) | Fixed server port. When not set, local sessions use a random port; remote sessions default to `19432`. |
| `PLANNOTATOR_BROWSER` | system default | Custom browser to open the UI in. macOS: app name or path. Linux/Windows: executable path. Can also be a script. Takes priority over `BROWSER`. |
| `BROWSER` | (none) | Standard env var for specifying a browser. VS Code sets this automatically in devcontainers. Used as fallback when `PLANNOTATOR_BROWSER` is not set. |
| `PLANNOTATOR_SHARE` | enabled | Set to `disabled` to turn off sharing. Hides share UI and import options. |
| `PLANNOTATOR_SHARE_URL` | `https://share.plannotator.ai` | Base URL for share links. Set this when self-hosting the share portal. |

## Install script variables

| Variable | Default | Description |
|----------|---------|-------------|
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Custom Claude Code config directory. The install script places hooks here instead of the default location. |

## Remote mode behavior

When `PLANNOTATOR_REMOTE=1` or SSH is detected:

- Server binds to `PLANNOTATOR_PORT` (default `19432`) instead of a random port
- Browser auto-open is skipped
- The URL is printed to stderr for manual access

### Legacy SSH detection

These environment variables are still detected for backwards compatibility:

| Variable | Description |
|----------|-------------|
| `SSH_TTY` | Set by SSH when a TTY is allocated |
| `SSH_CONNECTION` | Set by SSH with connection details |

If either is present, Plannotator enables remote mode automatically. Prefer `PLANNOTATOR_REMOTE=1` for explicit control.

## Port resolution order

1. `PLANNOTATOR_PORT` environment variable (if valid integer 1-65535)
2. `19432` if in remote mode
3. `0` (random) if in local mode

## Custom browser examples

```bash
# macOS: open in Chrome
export PLANNOTATOR_BROWSER="Google Chrome"

# macOS: open in specific app
export PLANNOTATOR_BROWSER="/Applications/Firefox.app"

# Linux: open in Firefox
export PLANNOTATOR_BROWSER="/usr/bin/firefox"

# Custom script for remote URL handling
export PLANNOTATOR_BROWSER="/path/to/my-open-script.sh"
```
