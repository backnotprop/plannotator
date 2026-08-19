# Plannotator for Gemini CLI

Interactive plan review, code review, and markdown annotation for Google Gemini CLI.

## Install

**Install the `plannotator` command:**

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

The installer auto-detects Gemini CLI (checks for `~/.gemini`) and configures:

- **Policy file** at `~/.gemini/policies/plannotator.toml` — allows `exit_plan_mode` without the TUI confirmation dialog
- **Hook** in `~/.gemini/settings.json` — intercepts `exit_plan_mode` and opens the browser review UI
- **Slash commands** at `~/.gemini/commands/` — `/plannotator-review` and `/plannotator-annotate`

## How It Works

### Plan Mode Integration

When you use `/plan` in Gemini CLI:

1. The agent creates a plan and calls `exit_plan_mode`
2. The user policy auto-allows `exit_plan_mode` (skipping the TUI dialog)
3. The `BeforeTool` hook intercepts the call, reads the plan from disk, and opens the Plannotator review UI in your browser
4. You review the plan, optionally add annotations
5. **Approve** → the plan is accepted and the agent proceeds
6. **Deny** → the agent receives your feedback and revises the plan

### Available Commands

| Command | Description |
|---------|-------------|
| `/plannotator-review` | Open interactive code review for current changes or a PR URL |
| `/plannotator-review <pr-url>` | Review a GitHub pull request |
| `/plannotator-annotate <file>` | Open interactive annotation UI for a markdown file |

## Manual Setup

If the installer didn't auto-configure your settings (e.g. `~/.gemini/settings.json` already existed), add the hook manually:

```json
{
  "hooks": {
    "BeforeTool": [
      {
        "matcher": "exit_plan_mode",
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

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` for remote mode (devcontainer, SSH). Uses fixed port and skips browser open. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_AI` | Set to `disabled` to disable Ask AI, Review Agents, and Guided Review. |
| `PLANNOTATOR_SHARE` | Set to `disabled` to turn off URL sharing. |

## Requirements

- Gemini CLI 0.36.0 or later
- `plannotator` binary on PATH

## Links

- [Website](https://plannotator.ai)
- [GitHub](https://github.com/backnotprop/plannotator)
- [Docs](https://plannotator.ai/docs/getting-started/installation/)
