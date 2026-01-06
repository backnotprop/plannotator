# Devcontainer / Docker Setup

Plannotator works in devcontainers and Docker environments with minimal configuration.

## Required Environment Variables

Add these to your `devcontainer.json`:

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
| `PLANNOTATOR_REMOTE=1` | Tells Plannotator not to open a browser (required in containers) |
| `PLANNOTATOR_PORT=9999` | Fixed port for the UI (required for port forwarding) |

Both are required. Just setting the port isn't enough.

## Port Forwarding

Ensure port 9999 (or your chosen port) is forwarded to your host. In VS Code devcontainers, add it to `forwardPorts` as shown above.

## Usage

1. Run OpenCode in your container (`opencode` or `opencode web`)
2. Ask the agent to create a plan
3. When `submit_plan` is called, Plannotator starts on port 9999
4. Open `http://localhost:9999` in your host browser
5. Approve or deny the plan

**Note:** There's no browser auto-open or notification in remote mode. You'll need to manually navigate to the URL when you see the agent call `submit_plan`.

## OpenCode Web

`opencode web` works in devcontainers. Forward port 4096 (default) for the OpenCode UI, and port 9999 for Plannotator:

```json
{
  "forwardPorts": [4096, 9999]
}
```

## Legacy Support

If your environment already has `SSH_TTY` or `SSH_CONNECTION` set (common in SSH sessions), Plannotator will detect remote mode automatically. The `PLANNOTATOR_REMOTE` env var is preferred for Docker/devcontainer setups where those aren't present.

## Troubleshooting

**Plugin not updating?**
```bash
rm -rf ~/.cache/opencode/node_modules/@plannotator
```

**OpenCode crashes on startup?**
```bash
rm -rf ~/.cache/opencode
```

**Port not accessible?**
Check your devcontainer's port forwarding. In VS Code, check the "Ports" tab.
