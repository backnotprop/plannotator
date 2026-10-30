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

Remote mode changes these behaviors:

1. **Fixed port** — Uses `PLANNOTATOR_PORT` (default: `19432`) instead of a random port, so you can set up port forwarding once
2. **Browser handling changes** — In headless setups you may need to open the forwarded URL manually instead of relying on browser auto-open
3. **Wider bind** — The server listens on every interface (`0.0.0.0`), not only loopback, so a forwarder or another device can reach it
4. **These features are turned off** — Ask AI's "Ask this session" (Ask AI uses a separate AI agent instead), the annotate agent terminal (unless `PLANNOTATOR_AGENT_TERMINAL_REMOTE=1`), Open in, Update now from a review window, live app annotation, the agent closing a review it opened, and auto-dismiss of an abandoned `--gate --json` session

Every other route stays reachable by anyone who can reach the URL: approving or denying the plan, sending feedback, starting agent review jobs, staging files, posting to the pull request, saving Edit Mode changes, and Ask AI with a separate agent. Bind or forward the port only on networks you trust. Use remote mode only when the browser cannot reach the machine's loopback address; `PLANNOTATOR_PORT` works in local mode too.

### Legacy detection

Plannotator also detects `SSH_TTY` and `SSH_CONNECTION` environment variables for automatic remote mode when `PLANNOTATOR_REMOTE` is unset. Use `PLANNOTATOR_REMOTE=1` / `true` to force remote mode or `PLANNOTATOR_REMOTE=0` / `false` to force local mode.

## WSL2

WSL2 does not need remote mode. Leave `PLANNOTATOR_REMOTE` unset (or set it to `0` if your shell sets `SSH_TTY` or `SSH_CONNECTION`, for example when you SSH into WSL from the same Windows machine; from another computer, local mode would open the browser on the WSL host's Windows desktop). In local mode Plannotator binds `127.0.0.1`, WSL2 forwards that port to Windows (`localhostForwarding`, on by default, or mirrored networking), and, unless `BROWSER` or `PLANNOTATOR_BROWSER` is set, Plannotator opens the URL in your Windows default browser through `cmd.exe` (this needs WSL interop; a set `BROWSER`, such as VS Code Remote-WSL's helper or `wslview`, runs instead). The review opens at `http://localhost:<port>` on Windows, and every local feature, "Ask this session" included, stays on.

Set `PLANNOTATOR_PORT` if you want a fixed port or range, and `PLANNOTATOR_BROWSER` if you want a specific Windows browser (for example `chrome.exe`). You need remote mode only if Windows cannot reach `localhost:<port>` (localhost forwarding turned off), in which case you open the WSL VM's address and the features listed above are off.

## Direct-reach hosts (Tailscale, LAN)

When the machine running Plannotator is directly reachable from your other devices — over a Tailscale tailnet, a VPN, or a trusted LAN — port forwarding is unnecessary, but the advertised URL still says `localhost`, which another device cannot open. Set `PLANNOTATOR_URL_HOST` to the hostname or IP those devices can reach:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_URL_HOST=my-machine.tailnet.ts.net
```

Plannotator then advertises `http://my-machine.tailnet.ts.net:<port>` (the port is chosen at runtime and always appended), so you can open review sessions straight from a phone or another computer. The setting is host-only and strictly display-only — it never changes which interface the server binds; remote mode (`PLANNOTATOR_REMOTE=1`) is what makes the server reachable beyond localhost, and a local session ignores the override entirely (localhost is advertised, with a warning). It can also be set persistently via `~/.plannotator/config.json` (`{ "urlHost": "my-machine.tailnet.ts.net" }`); the env var takes precedence.

Note that the session is served over plain `http`, so some in-app features that require a secure context (such as creating short share links from the UI) are unavailable from other devices unless you put the session behind HTTPS (e.g. `tailscale serve`). The core review, annotate, and approve flows work over plain `http`.

`plannotator review --tailscale` (also `annotate` and `last`) does that for you: it publishes the session over your tailnet with `tailscale serve`, over HTTPS and never publicly. It needs Tailscale Serve and HTTPS certificates turned on for your tailnet, a setting in Tailscale's admin console. If it is off, Plannotator says so and prints Tailscale's link to turn it on: a one-time page where you keep "HTTPS certificates" ticked and press **Enable HTTPS** (Funnel is not needed). The same command without `--tailscale` still works on this computer.

## HTTPS reverse proxies

When a reverse proxy exposes a fixed HTTPS origin and forwards it to Plannotator's local port, advertise the public origin separately:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=19432
export PLANNOTATOR_PUBLIC_URL=https://plannotator.example.com
```

Plannotator then prints and opens `https://plannotator.example.com` while continuing to listen on local port `19432`. `PLANNOTATOR_PUBLIC_URL` changes only the address shown; the reverse proxy must route that origin to the configured local port. The server also answers on the public hostname, so a proxy that forwards the browser's `Host` header works without `PLANNOTATOR_ALLOWED_HOSTS`. A plain `http://` public URL behind a proxy that rewrites `Host` also needs its hostname in `PLANNOTATOR_ALLOWED_HOSTS`, or saving and approving are refused.

The public URL is used only in remote mode, even when the tunnel runs on the same machine (cloudflared, code-server). `PLANNOTATOR_REMOTE=1` makes Plannotator listen on all network interfaces, not only localhost, and turns "Ask this session" off. Live app annotation is unavailable in remote mode, so it does not work through the public URL; use `--static`.

A port range can keep additional sessions available through a directly reachable host while the reverse proxy continues to expose the first port:

```bash
export PLANNOTATOR_PORT=19432-19463
export PLANNOTATOR_PUBLIC_URL=https://plannotator.example.com
export PLANNOTATOR_URL_HOST=my-machine.tailnet.ts.net
```

The session on `19432` advertises the public origin. Sessions on later ports advertise `http://my-machine.tailnet.ts.net:<port>`. The public origin still exposes only the first session; concurrent public sessions require a proxy that routes each session separately.

Only HTTP(S) origins are accepted. Paths are unsupported because Plannotator serves root-relative application and API routes. Protect internet-facing deployments with authentication at the reverse proxy; a Plannotator session exposes reviewed content and can submit approval or feedback.

You can persist the same setting in `~/.plannotator/config.json`:

```json
{
  "publicUrl": "https://plannotator.example.com"
}
```

The `PLANNOTATOR_PUBLIC_URL` environment variable takes precedence.

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

## Proxies and forwarded hostnames

Plannotator answers only the hostnames it expects in the `Host` header: `localhost` and other loopback names everywhere, plus, in remote mode, IP addresses, this machine's hostname (and its `.local` name), `PLANNOTATOR_URL_HOST` and the host of `PLANNOTATOR_PUBLIC_URL`. Port forwarding (SSH, VS Code, `docker -p`) arrives as `localhost` or an IP address and needs nothing; so do GitHub Codespaces and VS Code dev tunnels, whose forwarders present `localhost` to the server. A code-server or Coder port proxy is recognized from the `VSCODE_PROXY_URI` it sets. If another proxy or tunnel forwards its own hostname (a reverse proxy, a Docker service name), Plannotator answers `403` and names the setting to change:

```bash
export PLANNOTATOR_ALLOWED_HOSTS=my-proxy.example.com
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

To open nothing at all, set `PLANNOTATOR_BROWSER=none` (or pass `--browser none`). A remote session then also skips the VS Code tab and the remote host's own opener; the session prints its URL and `Not opening a browser (PLANNOTATOR_BROWSER=none).`, and you open the URL yourself.
