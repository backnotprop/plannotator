---
title: "Installation"
description: "How to install Plannotator for Claude Code, OpenCode, and other agent hosts."
sidebar:
  order: 1
section: "Getting Started"
---

Plannotator runs as a plugin for your coding agent. Install the CLI first, then configure your agent.

## Prerequisites

Install the `plannotator` command so your agent can use it.

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

**Windows CMD:**

```cmd
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd && del install.cmd
```

The install script respects `CLAUDE_CONFIG_DIR` if set, placing hooks in your custom config directory instead of `~/.claude`.

## Claude Code

### Plugin marketplace (recommended)

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator
```

Restart Claude Code after installing for hooks to take effect.

### Manual installation

If you prefer not to use the plugin system, add this to your `~/.claude/settings.json`:

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

### Local development

To test a local checkout of Plannotator:

```bash
claude --plugin-dir ./apps/hook
```

## OpenCode

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/opencode@latest"]
}
```

Restart OpenCode. The `submit_plan` tool is now available.

For slash commands (`/plannotator-review`, `/plannotator-annotate`), also run the install script:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

This also clears any cached plugin versions.

## Kilo Code

Coming soon.

## Codex

Coming soon.
