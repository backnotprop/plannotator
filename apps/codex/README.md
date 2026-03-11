# Plannotator for Codex

Code review and markdown annotation are supported today. Plan mode is not yet supported — it requires hooks to intercept the agent's plan submission, which Codex does not currently expose.

## Install

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

## Usage

### Code Review

Run `!plannotator review` to open the code review UI for your current changes:

```
!plannotator review
```

This captures your git diff, opens a browser with the review UI, and waits for your feedback. When you submit annotations, the feedback is printed to stdout.

### Annotate Markdown

Run `!plannotator annotate` to annotate any markdown file:

```
!plannotator annotate path/to/file.md
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` for remote mode (devcontainer, SSH). Uses fixed port and skips browser open. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open. macOS: app name or path. Linux/Windows: executable path. |

## Links

- [Website](https://plannotator.ai)
- [GitHub](https://github.com/backnotprop/plannotator)
- [Docs](https://plannotator.ai/docs/getting-started/installation/)
