# Plannotator for Codex

Code review, markdown annotation, and plan review are supported in Codex.

Plan review uses Codex's experimental `Stop` hook. This is a post-render review flow: when a turn stops, Plannotator reads the current rollout transcript, extracts the latest plan, and opens the normal plan review UI. If you deny the plan, Plannotator returns continuation feedback so Codex revises the plan in the same turn.

## Install

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

The installer adds the `plannotator` binary and, when Codex is installed or `~/.codex` already exists, enables Codex
Stop hooks automatically.

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

Codex hooks are currently disabled on Windows in the official Codex docs. The Windows installer does not enable them
automatically; it only prints manual guidance for future/manual experimentation.

## Enable Codex hooks

The installer handles this automatically on macOS, Linux, and WSL. If you are setting it up manually, Codex hooks
require a feature flag.

Add this to `~/.codex/config.toml` or `<repo>/.codex/config.toml`:

```toml
[features]
codex_hooks = true
```

Then create `~/.codex/hooks.json` or `<repo>/.codex/hooks.json`:

```json
{
  "hooks": {
    "Stop": [
      {
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

Notes:

- Codex loads `hooks.json` next to active config layers, so either the global `~/.codex` or repo-local `.codex` location works.
- Prefer an absolute `plannotator` command path in `hooks.json` for Codex Desktop, because app-launched processes may not inherit your shell `PATH`.
- This currently depends on Codex hooks, which are experimental and disabled on Windows in the current official docs.
- Because this uses `Stop`, the review happens after Codex renders the plan turn, not at a dedicated `ExitPlanMode` interception point.
- Restart Codex Desktop after installing or changing hooks.

## Usage

### Plan Review

Once hooks are enabled, plan review opens automatically whenever a Codex turn ends with a plan. Approving keeps the turn completed. Sending feedback returns a `Stop` continuation reason so Codex revises the plan and Plannotator shows version history and diffs across revisions.

### Local End-to-End Harness

From the repo root, you can run a disposable local E2E flow against a real Codex session:

```bash
./tests/manual/local/test-codex-plan-review-e2e.sh --keep
```

This uses a temporary `HOME`, sample git repo, repo-local Codex CLI, and repo-local `plannotator` wrapper so it
doesn't modify your installed Codex or Plannotator state. If you want to automate the opened review UI with Playwright,
set `PLANNOTATOR_BROWSER=/usr/bin/true` before running the script.

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

### Annotate Last Message

Run `!plannotator last` to annotate the agent's most recent response:

```
!plannotator last
```

The message opens in the annotation UI where you can highlight text, add comments, and send structured feedback back to the agent.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` / `true` for remote mode, `0` / `false` for local mode, or leave unset for SSH auto-detection. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open. macOS: app name or path. Linux/Windows: executable path. |

## Links

- [Website](https://plannotator.ai)
- [GitHub](https://github.com/backnotprop/plannotator)
- [Docs](https://plannotator.ai/docs/getting-started/installation/)
