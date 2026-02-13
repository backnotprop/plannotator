---
title: "Configuration"
description: "Environment variables, hooks configuration, and runtime options for Plannotator."
sidebar:
  order: 3
section: "Getting Started"
---

Plannotator is configured through environment variables and hook/plugin configuration files. No config file of its own is required.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_REMOTE` | auto-detect | Set to `1` or `true` to force remote mode. Uses a fixed port and skips browser auto-open. |
| `PLANNOTATOR_PORT` | random (local) / `19432` (remote) | Fixed server port. Useful for port forwarding in remote environments. |
| `PLANNOTATOR_BROWSER` | system default | Custom browser or script to open the UI. |
| `PLANNOTATOR_SHARE` | enabled | Set to `disabled` to turn off URL sharing entirely. |
| `PLANNOTATOR_SHARE_URL` | `https://share.plannotator.ai` | Point share links at a self-hosted portal. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Respected by the install script when placing hooks. |

See the [environment variables reference](/docs/reference/environment-variables/) for full details, port resolution order, and examples.

## Hook configuration (Claude Code)

The hook is defined in `hooks.json` inside the plugin directory. When installed via the marketplace, this is managed automatically. For manual installation, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 1800
          }
        ]
      }
    ]
  }
}
```

The `matcher` targets the `ExitPlanMode` tool specifically. The `timeout` is in seconds (30 minutes) — plan reviews can take a while.

## Plugin configuration (OpenCode)

OpenCode uses `opencode.json` to load the plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/opencode@latest"]
}
```

This registers the `submit_plan` tool. Slash commands (`/plannotator-review`, `/plannotator-annotate`) require the CLI to be installed separately via the install script.

## Plan saving

Approved and denied plans are saved to `~/.plannotator/plans/` by default. You can change the save directory or disable saving in the Plannotator UI settings (gear icon).

## Remote mode

When working over SSH, in a devcontainer, or in Docker, set `PLANNOTATOR_REMOTE=1` and `PLANNOTATOR_PORT` to a port you'll forward. See the [remote & devcontainers guide](/docs/guides/remote-and-devcontainers/) for setup instructions.

## Custom browser

`PLANNOTATOR_BROWSER` accepts an app name (macOS), executable path (Linux/Windows), or a custom script. This is useful for opening Plannotator in a specific browser or handling URL opening in unusual environments.

```bash
# macOS
export PLANNOTATOR_BROWSER="Google Chrome"

# Linux
export PLANNOTATOR_BROWSER="/usr/bin/firefox"

# Custom script
export PLANNOTATOR_BROWSER="/path/to/my-open-script.sh"
```

## Disabling sharing

Set `PLANNOTATOR_SHARE=disabled` to remove all sharing UI — the Share tab, copy link action, and import review option are all hidden. Useful for teams working with sensitive plans.

To self-host the share portal instead, see the [self-hosting guide](/docs/guides/self-hosting/).
