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
            "timeout": 1800
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

