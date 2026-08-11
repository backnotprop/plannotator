---
title: "Installation"
description: "How to install Plannotator for Claude Code, Codex, OpenCode, Kiro CLI, Pi, Amp, Droid, and other agent hosts."
sidebar:
  order: 1
section: "Getting Started"
---

Plannotator runs as a plugin for your coding agent. Install the CLI first, then configure your agent.

## Prerequisites

Install the `plannotator` command so your agent can use it. The installer
requires `git` (it fetches the skills and command files from a sparse checkout
of the release tag) and fails with a clear message if git is missing.

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

### Guided install

When run in a terminal for the first time, the installer asks two questions:

1. **Install the extra skills?** (compound planning, setup-goal, visual explainer) — answering yes launches `npx skills add` so you pick which agents get them in its UI. Skipped automatically if the extras are already installed.
2. **Make any skills callable by the model?** — answering yes opens a picker (space toggles on macOS/Linux/PowerShell; numbered toggles in the cmd installer). Chosen skills have `disable-model-invocation` removed from their *installed* copies (and the Codex sidecar flipped to match); everything else stays user-invoked only.

Answers are saved to `<data dir>/install-prefs` and reused silently on re-runs — pass `--reconfigure` to change them. **Automated installs are unaffected**: runs without a terminal (CI, scripts) never prompt and keep the defaults (no extras, nothing model-invocable). Automation can opt in explicitly with `--extras` / `--no-extras` / `--model-invocable <list>` / `--non-interactive`.

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

<details>
<summary><strong>Optional Call flow runtime (not installed by default)</strong></summary>

Code review's **Call flow** layer uses a pinned, pruned CallDiff runtime and needs Node.js 22 or newer, so it is never installed by default. The normal path is in-app: enable Call flow and the panel detects the changed languages, then one click installs the core (about 5 MB on macOS arm64) plus only the needed grammar packs. The panel names the languages and estimated total before starting. If a later review introduces another language, installed languages are still analyzed and a quiet skipped-files notice offers that pack. The panel's **Languages** list also supports installing a pack ahead of need.

For scripted or headless installs, `--with-call-flow` (PowerShell: `-WithCallFlow`), `PLANNOTATOR_INSTALL_CALLDIFF=1`, `{ "installCallFlow": true }`, and `plannotator install-runtime call-flow` install the core; review-specific packs remain selectable in the UI. `--minimal` always excludes it.

</details>

<details>
<summary><strong>Binary-only install (nothing but the CLI)</strong></summary>

Pass `--minimal` (aliased `--binary-only`) to install **only** the `plannotator` binary — no sem semantic-diff sidecar, no CallDiff runtime, no agent-terminal runtime, and none of the per-agent skills, hooks, slash commands, or config for Claude, Codex, OpenCode, Gemini, or Kiro. The only thing installed is the binary (the Windows PowerShell installer also adds the install directory to your user `PATH`), and because it skips the sparse checkout, **minimal mode does not require `git`**.

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

```powershell
& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Minimal
```

```cmd
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd --minimal && del install.cmd
```

For `curl … | bash` pipelines you can set `PLANNOTATOR_MINIMAL=1` in the environment instead of passing the flag; pass `--no-minimal` to force a full install even when that variable is set.

</details>

<details>
<summary><strong>Skipping individual agent integrations</strong></summary>

Want the full install but not every agent integration? Each one has its own opt-out. `--skip-codex` keeps the installer from writing `hooks.json` / `config.toml` under your Codex home even when Codex is detected; `--skip-gemini` and `--skip-kiro` do the same for `~/.gemini` and `~/.kiro`; `--skip-opencode` skips the OpenCode command stubs and cache clear. Skipping never removes an integration a previous install already wired, and the installer reports the state honestly (for example `Codex: detected, skipped (--skip-codex)`, never a false "not detected").

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-codex
```

PowerShell: `-SkipCodex` / `-SkipGemini` / `-SkipKiro` / `-SkipOpencode`. Windows CMD: same `--skip-*` flags as bash.

For unattended updates, set the environment variables `PLANNOTATOR_SKIP_CODEX_INSTALL=1` (likewise `_GEMINI_`, `_KIRO_`, `_OPENCODE_`) or persist the choice in `~/.plannotator/config.json`:

```json
{ "skipInstall": { "codex": true } }
```

Precedence: flag over environment variable over config file.

</details>

<details>
<summary><strong>Skipping the skills and slash commands</strong></summary>

The `/plannotator-*` skills and slash commands are fetched with a sparse `git clone` of the release tag. `--skip-skills` turns that fetch into a no-op: nothing is written to `~/.claude/skills`, `~/.agents/skills`, the OpenCode or Gemini command directories, or `~/.kiro`, the extras are not offered, and the skill-scope cleanup sweeps stay suspended. The binary, hooks, and per-agent config still install, and git stops being a hard requirement. Use it where the tag being installed cannot be fetched from GitHub, or where you manage the skills yourself.

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --skip-skills
```

PowerShell: `-SkipSkills`. Windows CMD: `--skip-skills`. For unattended runs set `PLANNOTATOR_SKIP_SKILLS_INSTALL=1`, or persist it:

```json
{ "skipInstall": { "skills": true } }
```

Same precedence: flag over environment variable over config file. The installer reports `Skills: skipped (...)` and stops claiming the `/plannotator-*` commands are ready, so a skipped run is never mistaken for a complete one.

</details>

## Uninstall

`plannotator uninstall` removes recognized installed components while
preserving local Plannotator data by default:

```bash
plannotator uninstall
```

This removes the conventional binary, the managed `sem` and agent-terminal
runtimes, installer-provided skills and commands, managed hook/config entries,
recognizable global integrations, and detected host plugins. Shared settings
are changed only when their Plannotator entries can be identified safely;
custom files and separately installed optional skills are preserved.

To remove known local plans, history, drafts, guides, settings, and other
Plannotator data too, use:

```bash
plannotator uninstall --purge
```

Purge requires typing `purge` at the prompt. The CLI warns that this data is
local-only: it is not stored on a Plannotator server and cannot be recovered
after purge. `--yes` (or `-y`) skips confirmation for automation, and is
required when no interactive terminal is available. `--dry-run` previews the
recognized removal set without changing anything.
Host integrations are always part of uninstall. If a broken or unavailable
host prevents safe cleanup, the command names the blocking plugin manager or
configuration, gives exact manual cleanup instructions, and stops before
deleting the binary. Complete that cleanup and rerun uninstall.

The purge removes only known Plannotator entries from the configured data
directory. Unknown top-level files are preserved rather than guessed at, and
custom external plan-save paths or project-local integrations are never
deleted. Malformed host config is treated as a fail-safe error. If a host
plugin manager is unavailable or a shared config cannot be edited safely, the
command reports the exact manual follow-up and preserves
the CLI and its Windows PATH entry so you can fix the problem and retry. If
Windows PATH restoration itself fails, the CLI remains on disk and the output
gives its full path for retry and manual PATH repair.
Purge also refuses broad targets (filesystem roots, the home directory, or the
shared temporary directory), symlinked data directories, and non-directory
paths. Existing targets are compared by filesystem identity, so case aliases,
symlinks, hardlinks, and bind mounts cannot bypass the root/home/ancestor
checks. The identity and containment guards are revalidated after awaited host
commands, immediately before data removal, so a swapped directory is refused.
For a symlinked dedicated directory, set `PLANNOTATOR_DATA_DIR` to its
resolved target and retry.

Pi-only installations that do not include the `plannotator` CLI should use:

```bash
pi remove npm:@plannotator/pi-extension
```

<details>
<summary><strong>Installing behind a rate-limited IP</strong></summary>

The installer queries the GitHub API (`api.github.com`) to resolve the latest release tag. Unauthenticated API requests are capped at **60 per hour per source IP**, so installs can fail on shared egress IPs (corporate proxies, NAT/CGNAT, CI runners) or when retrying/debugging within the same hour, with an opaque `Failed to fetch latest version` error.

If you hit this, export a token before running the installer - it reads `GITHUB_TOKEN`, then `GH_TOKEN`, and falls back to `gh auth token` (github.com credentials only) when the `gh` CLI is authenticated. A personal access token raises the limit to 5,000/hour; the built-in `GITHUB_TOKEN` in GitHub Actions gets 1,000/hour per repository. The repository is public, so a token with no scopes is sufficient - prefer a fine-grained or zero-scope token over a broad classic PAT:

```bash
export GITHUB_TOKEN=ghp_xxx
curl -fsSL https://plannotator.ai/install.sh | bash
```

Or authenticate once with `gh auth login` - no env var needed, the installer picks the token up automatically. Only the version-resolution API call is authenticated; release downloads and `git clone` are unaffected. See [Troubleshooting](/docs/guides/troubleshooting/) for details.

</details>

Every release includes SHA256 checksums (verified automatically) and optional [SLSA build provenance](/docs/reference/verifying-your-install/) attestations.

## Claude Code

### Plugin marketplace (recommended)

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator
```

Restart Claude Code after installing for hooks to take effect.

The plugin provides the plan-review hook only. To also get the `/plannotator-*` slash commands you must run the [install script](#prerequisites) — it installs them as Claude Code skills in `~/.claude/skills` (see [Slash commands](#slash-commands) below).

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

### Slash commands

Plannotator's slash commands (`/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`) are installed as Claude Code skills in `~/.claude/skills` by the install script — Claude Code skills are user-invocable by directory name, so the command names are unchanged. There is no separate `~/.claude/commands` step.

Upgrading from an older version? The installer removes the legacy `~/.claude/commands/plannotator-*.md` files automatically, but the marketplace plugin's old namespaced `plannotator:*` command entries are managed by Claude Code — run `/plugin marketplace update` once so they disappear from the `/` menu.

Optional extra skills (compound planning, setup-goal, visual explainer) are not installed by default. Add them with:

```bash
npx skills add backnotprop/plannotator/apps/skills/extra --global
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

## Kiro CLI

Kiro is auto-detected — no extra flag or step. If `~/.kiro` exists (or `kiro-cli` is on your PATH) when you run the installer, Plannotator's Kiro skills install automatically, the same way Codex and Gemini are handled. This works on every platform; use the installer for your OS:

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

On Windows the installer checks for `%USERPROFILE%\.kiro` (or `kiro-cli` on your PATH). This installs the Kiro skills to `~/.kiro/skills` and the Plannotator agent to `~/.kiro/agents/plannotator.json` (an existing agent file is never overwritten). If you install Kiro *after* Plannotator, just re-run the installer.

See the [Kiro guide](/docs/guides/kiro-cli/) for the skill list and the Plannotator agent.

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

The installer also copies Plannotator's core skills (`plannotator-review`, `plannotator-annotate`, `plannotator-last`) into `~/.agents/skills` — the official OpenAI agent skills path. Optional extra skills (compound planning, setup-goal, visual explainer) are not installed by default; add them with:

```bash
npx skills add backnotprop/plannotator/apps/skills/extra --global
```

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

Start plan mode with `pi --plan`, or toggle mid-session with `/plannotator-plan-mode` or `Ctrl+Alt+P`. The extension provides file-based plan review, code review (`/plannotator-review`), markdown annotation (`/plannotator-annotate`), bash safety gating during planning, and progress tracking during execution.

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
```

Those commands open the browser-based Plannotator review UI and send the result back into the Droid session.
