---
title: "Remote & Devcontainers"
description: "Using Plannotator over SSH, in VS Code Remote, devcontainers, and Docker."
sidebar:
  order: 20
section: "Guides"
---

Plannotator works in remote environments — SSH sessions, VS Code Remote, devcontainers, and Docker. The key difference is that remote sessions benefit from a fixed port for forwarding, and browser-opening behavior depends on your environment.

## Remote mode

Set `PLANNOTATOR_REMOTE=1` (or `true`) to force remote mode:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999  # Choose a port you'll forward
```

Remote mode changes two behaviors:

1. **Fixed port** — Uses `PLANNOTATOR_PORT` (default: `19432`) instead of a random port, so you can set up port forwarding once
2. **Browser handling changes** — In headless setups you may need to open the forwarded URL manually instead of relying on browser auto-open

### Legacy detection

Plannotator also detects `SSH_TTY` and `SSH_CONNECTION` environment variables for automatic remote mode when `PLANNOTATOR_REMOTE` is unset. Use `PLANNOTATOR_REMOTE=1` / `true` to force remote mode or `PLANNOTATOR_REMOTE=0` / `false` to force local mode.

## VS Code Remote / devcontainers

VS Code sets the `BROWSER` environment variable in devcontainers to a helper script that opens URLs on your local machine. Plannotator respects this — in most cases, the browser opens automatically with no extra configuration.

If the automatic `BROWSER` detection doesn't work for your setup, you can fall back to manual remote mode:

1. Set the environment variables in your devcontainer config:

```json
{
  "containerEnv": {
    "PLANNOTATOR_REMOTE": "1",
    "PLANNOTATOR_PORT": "9999"
  },
  "forwardPorts": [9999]
}
```

2. When Plannotator opens, check the VS Code **Ports** tab — the port should be automatically forwarded
3. Open `http://localhost:9999` in your local browser

## SSH port forwarding

For direct SSH connections, forward the port in your `~/.ssh/config`:

```
Host your-server
    LocalForward 9999 localhost:9999
```

Or forward ad-hoc when connecting:

```bash
ssh -L 9999:localhost:9999 your-server
```

Then open `http://localhost:9999` locally if Plannotator does not open a browser for you.

## Docker (without VS Code)

For standalone Docker containers, expose the port and set environment variables:

```dockerfile
ENV PLANNOTATOR_REMOTE=1
ENV PLANNOTATOR_PORT=9999
EXPOSE 9999
```

Or via `docker run`:

```bash
docker run -e PLANNOTATOR_REMOTE=1 -e PLANNOTATOR_PORT=9999 -p 9999:9999 your-image
```

## Custom browser

The `PLANNOTATOR_BROWSER` environment variable lets you specify a custom browser or script for opening the UI.

**macOS** — Set to an app name or path:

```bash
export PLANNOTATOR_BROWSER="Google Chrome"
# or
export PLANNOTATOR_BROWSER="/Applications/Firefox.app"
```

**Linux** — Set to an executable path:

```bash
export PLANNOTATOR_BROWSER="/usr/bin/firefox"
```

**Windows / WSL** — Set to an executable:

```bash
export PLANNOTATOR_BROWSER="chrome.exe"
```

You can also point `PLANNOTATOR_BROWSER` at a custom script that handles URL opening in your specific environment — for example, a script that opens the URL on a different machine or sends a notification with the link.
