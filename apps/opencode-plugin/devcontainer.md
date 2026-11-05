# Devcontainer / Docker Setup

Plannotator works in devcontainers and Docker environments with minimal configuration.

## Environment Variables

A VS Code development container usually opens the browser by itself. If it does not, or in any other development container, add the fixed port and remote mode to `devcontainer.json`:

```json
{
  "containerEnv": {
    "PLANNOTATOR_REMOTE": "1",
    "PLANNOTATOR_PORT": "9999"
  },
  "forwardPorts": [9999]
}
```

| Variable | Purpose |
|----------|---------|
| `PLANNOTATOR_REMOTE=1` | Forces remote mode, which binds to `0.0.0.0` and uses port `19432` unless `PLANNOTATOR_PORT` is set |
| `PLANNOTATOR_PORT=9999` | Optional. Uses another port instead of `19432`. `forwardPorts` must list the same port |

Setting `PLANNOTATOR_PORT` without `PLANNOTATOR_REMOTE=1` is not enough for a published Docker port, because local mode binds to `127.0.0.1` inside the container. A VS Code forwarded port can still reach that address.

For Docker without a development container, set remote mode and publish the port to your own computer only: `docker run -e PLANNOTATOR_REMOTE=1 -p 127.0.0.1:19432:19432 your-image`. Keep a forwarded port's visibility private.

## Port Forwarding

If you added the sample, make sure port 9999 (or your chosen port) is forwarded to your host. In VS Code devcontainers, `forwardPorts` in the sample does this.

## Usage

1. Run OpenCode in your container (`opencode` or `opencode web`)
2. Ask the agent to create a plan
3. When `submit_plan` is called, Plannotator starts. With the sample, it uses port 9999
4. If the browser does not open, open `http://localhost:9999` in your host browser, or the port you set
5. Approve or deny the plan

**Note:** Browser opening depends on your container/browser setup. If nothing opens automatically, navigate to the forwarded URL manually when you see the agent call `submit_plan`.

## OpenCode Web

`opencode web` works in devcontainers. Forward port 4096 (default) for the OpenCode UI. If you added the sample, also forward port 9999 for Plannotator:

```json
{
  "forwardPorts": [4096, 9999]
}
```

## Legacy Support

If your environment already has `SSH_TTY` or `SSH_CONNECTION` set (common in SSH sessions), Plannotator will detect remote mode automatically when `PLANNOTATOR_REMOTE` is unset. You can also force local mode with `PLANNOTATOR_REMOTE=false` or `0`.

## Troubleshooting

**Plugin not updating?**
```bash
rm -rf ~/.bun/install/cache/@plannotator
```

**OpenCode crashes on startup?**
```bash
rm -rf ~/.cache/opencode ~/.bun/install/cache/@opencode-ai
```

**Port not accessible?**
Check your devcontainer's port forwarding. In VS Code, check the "Ports" tab.
