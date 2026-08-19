---
title: "Troubleshooting"
description: "Common issues and how to resolve them."
sidebar:
  order: 24
section: "Guides"
---

## Installer fails with "Failed to fetch latest version"

The installer queries the GitHub API (`api.github.com`) to resolve the latest release tag. Unauthenticated API requests are capped at **60 per hour per source IP** - not per user - so the install fails (with `Failed to fetch latest version` on macOS/Linux/WSL, `Failed to get latest version` on Windows) on shared egress IPs (corporate proxies, NAT/CGNAT, CI runners) or when retrying within the same hour.

Provide a token and the installer attaches it to that API call automatically. A personal access token raises the limit to 5,000/hour; the built-in `GITHUB_TOKEN` in GitHub Actions gets 1,000/hour per repository. The repository is public, so a token with no scopes is sufficient - prefer a fine-grained or zero-scope token over a broad classic PAT. The installer reads, in order:

1. `GITHUB_TOKEN` env var
2. `GH_TOKEN` env var
3. `gh auth token` for github.com (when the `gh` CLI is installed and authenticated; a GitHub Enterprise default host is never used for this call)

```bash
export GITHUB_TOKEN=ghp_xxx
curl -fsSL https://plannotator.ai/install.sh | bash
```

Or run `gh auth login` once - no env var needed. To pin a specific version instead (which skips the API call entirely), pass `--version vX.Y.Z` on macOS/Linux (`curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z`) or `-Version vX.Y.Z` with the PowerShell installer. Only the version-resolution call is authenticated; release downloads and `git clone` are unaffected. See [issue #1156](https://github.com/backnotprop/plannotator/issues/1156).

## Lost a Plannotator tab?

If you accidentally close a Plannotator browser tab, the server is still running in the background. You can find and reopen it:

```bash
plannotator sessions
```

This lists all active sessions with their mode, project, URL, and how long they've been running:

```
Active Plannotator sessions:

  #1  review    my-project           http://localhost:54321    3m ago
  #2  plan      my-project           http://localhost:12345    15m ago

Reopen with: plannotator sessions --open [N]
```

To reopen one:

```bash
plannotator sessions --open       # reopens the most recent
plannotator sessions --open 2     # reopens session #2
```

Stale sessions from crashed processes are cleaned up automatically. You can also force cleanup with `plannotator sessions --clean`.

## Where does Plannotator store data?

Plannotator-managed files live under `~/.plannotator/` by default:

| Directory | What's in it |
|-----------|-------------|
| `plans/` | Snapshots of approved and denied plans. Controlled by the "Save plans" toggle in Settings. |
| `history/` | Automatic version history for every plan, organized by project and heading. Powers the plan diff and version browser. |
| `drafts/` | Auto-saved annotation drafts. If a server crashes mid-review, your in-progress annotations are recovered on the next session. |
| `sessions/` | Temporary session files for active servers. Cleaned up automatically when a server exits. |

Plan saving is enabled by default. You can change the save directory or disable it entirely in the Plannotator UI settings (gear icon). Functional browser cookies store some UI preferences separately from this directory.

## Browser doesn't open

If the UI doesn't open automatically, check:

- **Remote/SSH session?** Set `PLANNOTATOR_REMOTE=1` and `PLANNOTATOR_PORT` to a port you'll forward. See the [remote guide](/docs/guides/remote-and-devcontainers/).
- **Wrong browser?** Set `PLANNOTATOR_BROWSER` to the app name or path, or use `--browser` for a one-off override.
- **URL still works** — even if the browser didn't open, the server is running. Check `plannotator sessions` for the URL and open it manually.

## Hook doesn't fire

If `ExitPlanMode` doesn't trigger Plannotator:

1. Make sure the plugin is installed: `/plugin install plannotator@plannotator`
2. Restart Claude Code after installing (hooks load on startup)
3. Verify `plannotator` is on your PATH: `which plannotator`
4. Check that plan mode is enabled in your Claude Code session

## Codex plan review doesn't open

Codex plan review uses the experimental `Stop` hook, which the macOS, Linux, and WSL installer configures automatically when Codex is installed or `~/.codex` already exists.

If a Codex plan turn completes without opening Plannotator:

1. Rerun the installer: `curl -fsSL https://plannotator.ai/install.sh | bash`
2. Restart Codex Desktop or CLI so hooks are reloaded
3. Check `~/.codex/config.toml` contains `hooks = true` under `[features]`
4. Check `~/.codex/hooks.json` has a `Stop` hook whose command points to `plannotator`
5. Run `plannotator sessions` in case the browser failed to open but the session is running

Codex hooks are currently disabled on Windows in the official Codex docs, so the Windows installer prints manual guidance instead of changing Codex config automatically.

## OpenCode build agent cannot call `submit_plan`

This is expected with the default OpenCode workflow. Plannotator now defaults to `plan-agent`, which keeps `submit_plan` available to OpenCode's `plan` agent and hides or denies it for `build` and other non-planning primary agents.

If you want the old broad behavior, opt in from `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "all-agents"
    }]
  ]
}
```

If you do not want automatic plan review at all, use `workflow: "manual"` and run `/plannotator-last` or `/plannotator-annotate` when you want Plannotator.
