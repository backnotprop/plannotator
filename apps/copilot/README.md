# Plannotator for Copilot CLI

Interactive plan review, code review, and markdown annotation for GitHub Copilot CLI.

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

**Then in Copilot CLI:**

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator-copilot@plannotator
```

Restart Copilot CLI after plugin install. Plan review activates automatically when you use plan mode (`Shift+Tab` to enter plan mode).

## How It Works

### Plan Mode Integration

When you use plan mode in Copilot CLI:

1. The agent writes `plan.md` to the session state directory
2. The agent calls `exit_plan_mode` to present the plan
3. The `preToolUse` hook intercepts this and opens the Plannotator review UI in your browser
4. You review the plan, optionally add annotations
5. **Approve** → the plan is accepted and the agent proceeds
6. **Deny** → the agent receives your feedback and revises the plan

### Available Commands

| Command | Description |
|---------|-------------|
| `/plannotator-review` | Open interactive code review for current changes or a PR URL |
| `/plannotator-annotate <file>` | Open interactive annotation UI for a markdown file |
| `/plannotator-last` | Annotate the last rendered assistant message |

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` for remote mode (devcontainer, SSH). Uses fixed port and skips browser open. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_SHARE` | Set to `disabled` to turn off URL sharing. |

## Limitations

- **Plan mode** requires the `plannotator` CLI to be installed and on PATH
- **`/plannotator-last`** parses `events.jsonl` from the Copilot CLI session state directory — format may change between Copilot CLI versions

## Links

- [Website](https://plannotator.ai)
- [GitHub](https://github.com/backnotprop/plannotator)
- [Docs](https://plannotator.ai/docs/getting-started/installation/)
