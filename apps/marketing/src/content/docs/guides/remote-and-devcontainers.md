---
title: "Remote & Devcontainers"
description: "Using Plannotator over SSH, in VS Code Remote, devcontainers, and Docker."
sidebar:
  order: 20
section: "Guides"
---

Plannotator works in remote environments — SSH sessions, VS Code Remote, devcontainers, and Docker. In remote mode the server binds beyond localhost and never opens a browser on the remote host; instead it surfaces a URL you open on your local machine.

## Remote mode

Set `PLANNOTATOR_REMOTE=1` (or `true`) to force remote mode:

```bash
export PLANNOTATOR_REMOTE=1
```

Remote mode changes these behaviors:

1. **Binds beyond localhost** — The server listens on `0.0.0.0` on a random port (so parallel sessions never collide), instead of loopback only
2. **Reachable via a resolved hostname** — Plannotator surfaces a URL built from `PLANNOTATOR_HOSTNAME` if set, otherwise an auto-detected [Tailscale](#tailscale-recommended) hostname. No fixed port forwarding required. If no reachable hostname is found, it generates a read-only share link instead
3. **No browser on the remote host** — The reachable URL is printed to stderr and, if `CLAUDE_HOOKS_NTFY_URL` is set, sent as an ntfy push. Open it on your local machine

## Tailscale (recommended)

If both your remote host and local machine are on the same [Tailscale](https://tailscale.com/) tailnet, Plannotator auto-detects the host's Tailscale DNS name via `tailscale status` and builds a directly-reachable URL (full review with approve/deny) — no port forwarding or share link needed. Nothing to configure beyond having Tailscale running on the remote host.

To override auto-detection (or to use a non-Tailscale reachable hostname), set it explicitly:

```bash
export PLANNOTATOR_HOSTNAME=mybox.ts.net
```

## Fixed port + forwarding (fallback)

If you can't use a reachable hostname, pin a port and forward it yourself. Setting `PLANNOTATOR_PORT` opts back into a stable port for forwarding:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999  # Choose a port you'll forward
```

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
