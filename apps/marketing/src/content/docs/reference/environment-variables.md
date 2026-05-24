---
title: "Environment Variables"
description: "Complete reference for all Plannotator environment variables."
sidebar:
  order: 30
section: "Reference"
---

All Plannotator environment variables and their defaults.

## Core variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_REMOTE` | auto-detect | Set to `1` or `true` to force remote mode, `0` or `false` to force local mode, or leave unset to auto-detect via `SSH_TTY` / `SSH_CONNECTION`. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. |
| `PLANNOTATOR_PORT` | random (local) / `19432` (remote) | Fixed server port. When not set, local sessions use a random port; remote sessions default to `19432`. |
| `PLANNOTATOR_BROWSER` | system default | Custom browser to open the UI in. macOS: app name or path. Linux/Windows: executable path. Can also be a script. Takes priority over `BROWSER`. Also settable per-invocation with `--browser`. |
| `BROWSER` | (none) | Standard env var for specifying a browser. VS Code sets this automatically in devcontainers. Used as fallback when `PLANNOTATOR_BROWSER` is not set. |
| `PLANNOTATOR_ORIGIN` | auto-detect | Explicit agent-origin override. Valid values: `claude-code`, `opencode`, `codex`, `copilot-cli`, `gemini-cli`. Invalid values silently fall through to env-based detection. |
| `PLANNOTATOR_SHARE` | enabled | Set to `disabled` to turn off sharing. Hides share UI and import options. |
| `PLANNOTATOR_SHARE_URL` | `https://share.plannotator.ai` | Base URL for share links. Set this when self-hosting the share portal. |
| `PLANNOTATOR_PLAN_TIMEOUT_SECONDS` | `345600` | OpenCode only. `submit_plan` wait timeout in seconds. Set `0` to disable timeout. |

## Annotation variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_JINA` | enabled | Set to `0` or `false` to disable Jina Reader for URL annotation. Set to `1` or `true` to enable (this is the default). Can also be set via `~/.plannotator/config.json` (`{ "jina": false }`) or per-invocation via `--no-jina`. |
| `JINA_API_KEY` | (none) | Optional Jina Reader API key for higher rate limits. Without it: 20 req/min. With it: 500 req/min. Free keys available from [Jina](https://jina.ai/reader/) and include 10M tokens. |

## Paste service variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_PASTE_URL` | `https://plannotator-paste.plannotator.workers.dev` | Base URL of the paste service API. Set this when self-hosting the paste service. |

### Self-hosted paste service

When running your own paste service binary, these variables configure it:

| Variable | Default | Description |
|----------|---------|-------------|
| `PASTE_PORT` | `19433` | Server port |
| `PASTE_DATA_DIR` | `~/.plannotator/pastes` | Filesystem storage directory |
| `PASTE_TTL_DAYS` | `7` | Paste expiration in days |
| `PASTE_MAX_SIZE` | `524288` | Max payload size in bytes (512KB) |
| `PASTE_ALLOWED_ORIGINS` | `https://share.plannotator.ai,http://localhost:3001` | CORS allowed origins (comma-separated) |

## Install script variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_VERIFY_ATTESTATION` | off | Set to `1` or `true` to have the install script run `gh attestation verify` on the downloaded binary. Requires `gh` CLI installed and authenticated. Can also be set via `~/.plannotator/config.json` (`{ "verifyAttestation": true }`) or per-invocation via `--verify-attestation`. |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Custom Claude Code config directory. The install script places hooks here instead of the default location. |

## Remote mode behavior

When remote mode is forced with `PLANNOTATOR_REMOTE=1` / `true`, or SSH is detected while `PLANNOTATOR_REMOTE` is unset:

- Server binds to `PLANNOTATOR_PORT` (default `19432`) instead of a random port
- Browser-opening behavior depends on the environment and configured browser handler
- In headless setups, you may need to open the forwarded URL manually

### Legacy SSH detection

These environment variables are still detected for backwards compatibility:

| Variable | Description |
|----------|-------------|
| `SSH_TTY` | Set by SSH when a TTY is allocated |
| `SSH_CONNECTION` | Set by SSH with connection details |

If either is present, Plannotator enables remote mode automatically when `PLANNOTATOR_REMOTE` is unset. Set `PLANNOTATOR_REMOTE=1` / `true` to force remote mode or `0` / `false` to force local mode.

## Port resolution order

1. `PLANNOTATOR_PORT` environment variable (if valid integer 0-65535; `0` means random)
2. `19432` if in remote mode
3. `0` (random) if in local mode

## Custom browser examples

```bash
# macOS: open in Chrome
export PLANNOTATOR_BROWSER="Google Chrome"

# macOS: open in specific app
export PLANNOTATOR_BROWSER="/Applications/Firefox.app"

# Linux: open in Firefox
export PLANNOTATOR_BROWSER="/usr/bin/firefox"

# Custom script for remote URL handling
export PLANNOTATOR_BROWSER="/path/to/my-open-script.sh"
```
