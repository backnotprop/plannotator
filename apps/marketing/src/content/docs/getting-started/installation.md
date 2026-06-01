---
title: "Installation"
description: "How to install Plannotator for Claude Code, Codex, OpenCode, Pi, Amp, Droid, and other agent hosts."
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

<details>
<summary><strong>Pin a specific version</strong></summary>

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z
```

```powershell
& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Version vX.Y.Z
```

```cmd
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd --version vX.Y.Z && del install.cmd
```

Version pinning is fully supported from **v0.17.2 onwards**. v0.17.2 is the first release to ship native ARM64 Windows binaries and SLSA build-provenance attestations. Pinning to a pre-v0.17.2 tag may work for default installs on macOS, Linux, and x64 Windows, but ARM64 Windows hosts will get a 404 and provenance verification will be rejected.

</details>

Every release includes SHA256 checksums (verified automatically) and optional [SLSA build provenance](/docs/reference/verifying-your-install/) attestations.

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
            "timeout": 345600
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

Restart OpenCode. By default, `submit_plan` is available to OpenCode's `plan` agent only. Use the [OpenCode guide](/docs/guides/opencode/) if you want commands-only mode or the legacy all-agents behavior.

For slash commands (`/plannotator-review`, `/plannotator-annotate`), also run the install script:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

This also clears any cached plugin versions.

## Kilo Code

Coming soon.

## Codex

Codex plan review is supported through the experimental `Stop` hook.

This is a post-render review flow: when a Codex turn stops, Plannotator reads the current transcript, extracts the latest plan, and opens the same plan review UI used by the other integrations. If you deny the plan, Plannotator returns a `Stop` continuation reason so Codex can revise the plan in the same turn.

On macOS, Linux, and WSL, the installer enables Codex hooks automatically when Codex is installed or `~/.codex` already exists:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Restart Codex Desktop after installing or changing hooks.

For manual setup, enable hooks in `~/.codex/config.toml` or `<repo>/.codex/config.toml`:

```toml
[features]
hooks = true
```

Then add `hooks.json` next to that config layer:

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

- Codex discovers hooks from `~/.codex/hooks.json` and `<repo>/.codex/hooks.json`, and loads all matching files.
- Prefer an absolute `plannotator` command path in `hooks.json` for Codex Desktop, because app-launched processes may not inherit your shell `PATH`.
- Codex hooks are currently experimental.
- The current official Codex hooks docs say hooks are disabled on Windows, so this flow is currently macOS/Linux/WSL only.

You can still use the direct commands at any time:

```bash
!plannotator review
!plannotator annotate file.md
!plannotator last
```

## Pi

Install the Pi extension:

```bash
pi install npm:@plannotator/pi-extension
```

Or try it without installing:

```bash
pi -e npm:@plannotator/pi-extension
```

Start plan mode with `pi --plan`, or toggle mid-session with `/plannotator` or `Ctrl+Alt+P`. The extension provides file-based plan review, code review (`/plannotator-review`), markdown annotation (`/plannotator-annotate`), bash safety gating during planning, and progress tracking during execution.

See [Plannotator Meets Pi](/blog/plannotator-meets-pi) for the full walkthrough.

## Amp

Plannotator's Amp integration is currently commands-only. It adds command-palette actions for code review, file annotation, and annotating Amp's latest assistant message.

Install the CLI first:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then install the Amp plugin:

```bash
mkdir -p ~/.config/amp/plugins
curl -fsSL https://raw.githubusercontent.com/backnotprop/plannotator/main/apps/amp-plugin/plannotator.ts \
  -o ~/.config/amp/plugins/plannotator.ts
```

Restart Amp or run `plugins: reload` from the command palette.

This adds:

```text
Plannotator: Review changes
Plannotator: Review changes or PR
Plannotator: Annotate file
Plannotator: Annotate last answer
```

For `Plannotator: Review changes or PR`, leave the input blank to review local changes, or enter a PR/MR URL.

The plugin uses Amp's thread API for `Annotate last answer`, so it does not read transcript logs.

## Droid

Plannotator's Droid integration is currently commands-only. It does not intercept Droid's planning flow yet.

Install the CLI first:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Then install the Droid plugin:

```bash
droid plugin marketplace add https://github.com/backnotprop/plannotator
droid plugin install plannotator@plannotator
```

Open a fresh Droid session after installing.

This adds the following slash commands:

```text
/plannotator-review
/plannotator-annotate <file|folder|url>
/plannotator-last
/plannotator-archive
```

Those commands open the browser-based Plannotator review UI and send the result back into the Droid session.
