# Plannotator Claude Code Plugin

This directory contains the Claude Code plugin configuration for Plannotator.

## Prerequisites

Install the `plannotator` command so Claude Code can use it:

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

Released binaries ship with SHA256 sidecars and [SLSA build provenance](https://slsa.dev/) attestations from v0.17.2 onwards. See the [installation docs](https://plannotator.ai/docs/getting-started/installation/#verifying-your-install) for version pinning and verification commands.

---

[Plugin Installation](#plugin-installation) · [Manual Installation (Hooks)](#manual-installation-hooks) · [Obsidian Integration](#obsidian-integration)  

---

## Plugin Installation

In Claude Code:

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator
```

**Important:** Restart Claude Code after installing the plugin for the hooks to take effect.

## Manual Installation (Hooks)

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
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

## How It Works

When Claude Code calls `ExitPlanMode`, this hook intercepts and:

1. Opens Plannotator UI in your browser
2. Lets you annotate the plan visually
3. Approve → Claude proceeds with implementation
4. Request changes → Your annotations are sent back to Claude
5. On resubmission → Plan Diff shows what changed since the last version

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` / `true` for remote mode, `0` / `false` for local mode, or leave unset for SSH auto-detection. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_SHARE_URL` | Custom share portal URL for self-hosting. Default: `https://share.plannotator.ai`. |

## Remote / Devcontainer Usage

When running Claude Code in a remote environment (SSH, devcontainer, WSL), set `PLANNOTATOR_REMOTE=1` (or `true`) and these environment variables:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999  # Choose a port you'll forward
```

This tells Plannotator to:
- Use a fixed port instead of a random one (so you can set up port forwarding)
- Use remote-friendly port/browser handling for forwarded environments
- Print the URL to the terminal for you to access

**Port forwarding in VS Code devcontainers:** The port should be automatically forwarded. Check the "Ports" tab.

**SSH port forwarding:** Add to your `~/.ssh/config`:
```
Host your-server
    LocalForward 9999 localhost:9999
```

## Slash Commands

The plugin registers three slash commands:

| Command | Description |
|---------|-------------|
| `/plannotator-review [--git]` | Open code review UI for current changes or a GitHub PR; `--git` forces Git in JJ workspaces |
| `/plannotator-annotate <file.md>` | Annotate any markdown file |
| `/plannotator-last` | Annotate the agent's last message |

## Obsidian Integration

Approved plans can be automatically saved to your Obsidian vault.

**Setup:**
1. Open Settings (gear icon) in Plannotator
2. Enable "Obsidian Integration"
3. Select your vault from the dropdown (auto-detected) or enter the path manually
4. Set folder name (default: `plannotator`)

**What gets saved:**
- Plans saved with human-readable filenames: `Title - Jan 2, 2026 2-30pm.md`
- YAML frontmatter with `created`, `source`, and `tags`
- Tags extracted automatically from the plan title and code languages
- Backlink to `[[Plannotator Plans]]` for graph connectivity

**Example saved file:**
```markdown
---
created: 2026-01-02T14:30:00.000Z
source: plannotator
tags: [plan, authentication, typescript, sql]
---

[[Plannotator Plans]]

# Implementation Plan: User Authentication
...
```

<img width="1190" height="730" alt="image" src="https://github.com/user-attachments/assets/1f0876a0-8ace-4bcf-b0d6-4bbb07613b25" />
