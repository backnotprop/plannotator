---
title: "Installation"
description: "How to install Plannotator for Claude Code, OpenCode, Pi, and other agent hosts."
sidebar:
  order: 1
section: "Getting Started"
---

Plannotator runs as a plugin for your coding agent. Install the CLI first, then configure your agent.

## Prerequisites

Install the `plannotator` command so your agent can use it.

**macOS / Linux / WSL:**

```bash
# Latest release
curl -fsSL https://plannotator.ai/install.sh | bash

# Pin to a specific reviewed version
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z
```

**Windows PowerShell:**

```powershell
# Latest release
irm https://plannotator.ai/install.ps1 | iex

# Pin to a specific reviewed version
& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Version vX.Y.Z
```

**Windows CMD:**

```cmd
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd && del install.cmd

REM Pin to a specific reviewed version
curl -fsSL https://plannotator.ai/install.cmd -o install.cmd && install.cmd --version vX.Y.Z && del install.cmd
```

The install script respects `CLAUDE_CONFIG_DIR` if set, placing hooks in your custom config directory instead of `~/.claude`.

**Supported versions:** version pinning is fully supported from **v0.17.2 onwards**. v0.17.2 is the first release to ship native ARM64 Windows binaries and SLSA build-provenance attestations; earlier tags were published before either existed. Pinning to a pre-v0.17.2 tag may work for default installs on macOS, Linux, and x64 Windows, but:

- ARM64 Windows hosts will get a 404 (no native ARM64 binary exists in older releases).
- Provenance verification (`--verify-attestation` and friends) will be rejected by the installer's pre-flight floor.

If you need a specific pre-v0.17.2 version, install without `--version` and `--verify-attestation` flags; otherwise, pin to v0.17.2 or later.

### Verifying your install

Every released binary is accompanied by a SHA256 sidecar (verified automatically on every install) and a [SLSA build provenance](https://slsa.dev/) attestation signed via Sigstore and recorded in the public transparency log. The SHA256 check is mandatory and always runs. Provenance verification is **optional** — it's only needed if you want a cryptographic link from the binary back to the exact commit and workflow run that built it.

**Manual verification (recommended for one-off audits):**

This requires the [GitHub CLI](https://cli.github.com) to be installed and authenticated (`gh auth login`). Replace `vX.Y.Z` with the tag of the version you installed — pinning the source ref and signer workflow is what gives you the "exact commit and workflow run" guarantee described above; `--repo` alone only proves the artifact was built by _some_ workflow in our repository.

```bash
# macOS / Linux
gh attestation verify ~/.local/bin/plannotator \
  --repo backnotprop/plannotator \
  --source-ref refs/tags/vX.Y.Z \
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml

# Windows (PowerShell installer)
gh attestation verify "$env:LOCALAPPDATA\plannotator\plannotator.exe" `
  --repo backnotprop/plannotator `
  --source-ref refs/tags/vX.Y.Z `
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml

# Windows (cmd installer)
gh attestation verify "%USERPROFILE%\.local\bin\plannotator.exe" ^
  --repo backnotprop/plannotator ^
  --source-ref refs/tags/vX.Y.Z ^
  --signer-workflow backnotprop/plannotator/.github/workflows/release.yml
```

For air-gapped or no-auth environments, see GitHub's docs on [verifying attestations offline](https://docs.github.com/en/actions/security-for-github-actions/using-artifact-attestations/verifying-attestations-offline) (uses `gh attestation download` to fetch the bundle once, then verifies offline against it).

**Automatic verification during install/upgrade (opt-in):**

Provenance verification is **off by default** in the installer — the same default every major `curl | bash` installer uses (rustup, brew, bun, deno, helm). SHA256 verification always runs. To have the installer additionally run `gh attestation verify` on every upgrade, enable it via any of the three mechanisms below. Precedence is CLI flag > env var > config file > default.

1. **Per-install flag** (one-shot, explicit):
   ```bash
   curl -fsSL https://plannotator.ai/install.sh | bash -s -- --verify-attestation
   ```
   PowerShell: `... -VerifyAttestation`. Windows cmd: `install.cmd --verify-attestation`.

2. **Environment variable** (persist in your shell RC):
   ```bash
   export PLANNOTATOR_VERIFY_ATTESTATION=1
   ```
   Scoped to whichever shell sessions export it. Follows the same `PLANNOTATOR_*` convention as `PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT`, etc.

3. **Config file** (persist shell-agnostic):
   ```bash
   mkdir -p ~/.plannotator
   echo '{ "verifyAttestation": true }' > ~/.plannotator/config.json
   ```
   Or merge into an existing `~/.plannotator/config.json`. This applies regardless of which shell launches the installer — useful for GUI-launched terminals on macOS or `install.cmd` run from Explorer on Windows. Managed easily by dotfiles / Ansible / other provisioning tools.

When enabled, the installer requires `gh` CLI installed and authenticated (`gh auth login`). If `gh` is missing or the check fails, the install hard-fails so you don't silently skip verification you asked for. To force-skip for a single install, pass `--skip-attestation` (bash/cmd) or `-SkipAttestation` (PowerShell).

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

Restart OpenCode. The `submit_plan` tool is now available.

For slash commands (`/plannotator-review`, `/plannotator-annotate`), also run the install script:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

This also clears any cached plugin versions.

## Kilo Code

Coming soon.

## Codex

Plan mode is not yet supported.

Install the binary, then use it directly:

```
!plannotator review           # Code review for current changes
!plannotator annotate file.md # Annotate a markdown file
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
