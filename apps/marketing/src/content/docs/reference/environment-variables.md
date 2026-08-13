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
| `PLANNOTATOR_PORT` | random (local) / `19432` (remote) | Fixed server port or inclusive range such as `19432-19463`. A range uses the first available port. When not set, local sessions use a random port; remote sessions default to `19432`. |
| `PLANNOTATOR_PUBLIC_URL` | unset | Full HTTP(S) origin advertised for a remote session behind a reverse proxy, for example `https://plannotator.example.com`. Plannotator uses it as-is instead of appending the local runtime port. For a configured port range, it applies only to the first port; sessions on later ports fall back to `PLANNOTATOR_URL_HOST` or `localhost` with the runtime port appended. Origin only: credentials, paths, query strings, fragments, and non-HTTP(S) schemes warn once on stderr and fall back to `PLANNOTATOR_URL_HOST` or `localhost`. Strictly display-only and remote-only: it never changes the bind interface or same-machine agent API URL. Can also be set via `~/.plannotator/config.json` (`{ "publicUrl": "https://plannotator.example.com" }`); the env var takes precedence, and setting it to an empty value suppresses the config key. |
| `PLANNOTATOR_URL_HOST` | unset (`localhost`) | Display-only hostname for advertised session URLs, e.g. a Tailscale MagicDNS name or tailnet IP, so remote-mode links are reachable from another device instead of `http://localhost:<port>`. Host only: bare hostname, IPv4, or bracketed IPv6 such as `[fd7a::1]` — the runtime-chosen port is always appended, and a value carrying a scheme, port, path, or whitespace warns on stderr and falls back to `localhost`. Used when `PLANNOTATOR_PUBLIC_URL` is unset or a configured port range selects a later port. Strictly display-only and remote-only: it never changes which interface the server binds (that stays governed by `PLANNOTATOR_REMOTE`), and a local session ignores the override — the advertised URL stays `localhost`, with a stderr warning to set `PLANNOTATOR_REMOTE=1`. Can also be set via `~/.plannotator/config.json` (`{ "urlHost": "host" }`); the env var takes precedence, and setting it to an empty value suppresses a config-file `urlHost`. |
| `PLANNOTATOR_BROWSER` | system default | Custom browser to open the UI in. macOS: app name or path. Linux/Windows: executable path. Can also be a script. Takes priority over `BROWSER`. Also settable per-invocation with `--browser`. |
| `BROWSER` | (none) | Standard env var for specifying a browser. VS Code sets this automatically in devcontainers. Used as fallback when `PLANNOTATOR_BROWSER` is not set. |
| `PLANNOTATOR_ORIGIN` | auto-detect | Explicit agent-origin override. Valid values: `claude-code`, `amp`, `droid`, `opencode`, `codex`, `copilot-cli`, `pi`, `gemini-cli`, `kiro-cli`. Invalid values silently fall through to env-based detection. |
| `PLANNOTATOR_READY_FILE` | (none) | Internal host-plugin side channel. When set, Plannotator appends server-ready JSON lines containing the local UI URL. |
| `PLANNOTATOR_SKIP_BROWSER_OPEN` | unset | Internal host-plugin flag. Set to `1` to prevent Plannotator from opening the browser itself when the host will open the URL. |
| `PLANNOTATOR_AI` | enabled | Set to `disabled` to disable Ask AI and the Review Agents / Guided Review execution surfaces, including provider and agent-job endpoints. Persisted guide data is retained and its server APIs remain available, but the in-app history browser is hidden while AI is disabled. External agents can still open reviews and submit annotations; the annotate agent terminal is separate. |
| `PLANNOTATOR_SHARE` | enabled | Set to `disabled` to turn off sharing. Hides share UI and import options. Can also be set via `~/.plannotator/config.json` (`{ "share": "disabled" }`); the env var takes precedence. |
| `PLANNOTATOR_SHARE_URL` | `https://share.plannotator.ai` | Base URL for share links. Set this when self-hosting the share portal. |
| `PLANNOTATOR_DATA_DIR` | `~/.plannotator` | Override the base directory for Plannotator-managed files (plans, history, drafts, config, hooks, sessions).* Some UI preferences remain in functional browser cookies. When unset, an existing `~/.plannotator` is always used; if it doesn't exist and `$XDG_DATA_HOME` is set to an absolute path, `$XDG_DATA_HOME/plannotator` is used; otherwise `~/.plannotator`. (The XDG spec's implicit `~/.local/share` default is deliberately not applied — only an explicitly-set `$XDG_DATA_HOME` moves the directory.) |
| `PLANNOTATOR_PLAN_TIMEOUT_SECONDS` | `345600` | OpenCode only. `submit_plan` wait timeout in seconds. Set `0` to disable timeout. |
| `PLANNOTATOR_TODO_PROVIDER` | auto | Pi/oh-my-pi only. Set to `off` (or `0` / `false` / `disabled`) to stop mirroring the approved plan checklist into an editable todo provider during execution. When enabled, Plannotator syncs the checklist only if a provider is detected — currently [pi-todos](https://github.com/mitsuhiko/agent-stuff), detected by its todo directory existing (`.pi/todos` by default, or wherever `PI_TODO_PATH` redirects it when set). The mirror is additive: the progress widget behaves the same either way, and sync is one-way, so edits made in `/todos` never feed back into plan execution. Can also be set via `~/.plannotator/config.json` (`{ "todoProvider": "off" }`); the env var takes precedence. |

\* If you use the VS Code extension, make sure `PLANNOTATOR_DATA_DIR` is visible to both your terminal and VS Code. On macOS, apps launched from the Dock don't inherit shell env vars — launch VS Code from the terminal (`code .`) or set the variable via `launchctl setenv`.

## Glimpse (native window)

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_GLIMPSE` | enabled | Set to `0` or `false` to disable the Glimpse native window even when `glimpseui` is installed. Set to `1` or `true` to enable (this is the default). Can also be set via `~/.plannotator/config.json` (`{ "glimpse": false }`). |
| `PLANNOTATOR_GLIMPSE_WIDTH` | `1280` | Width in pixels for the Glimpse native window. |
| `PLANNOTATOR_GLIMPSE_HEIGHT` | `900` | Height in pixels for the Glimpse native window. |

## Annotation variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_JINA` | enabled | Set to `0` or `false` to disable Jina Reader for URL annotation. Set to `1` or `true` to enable (this is the default). Can also be set via `~/.plannotator/config.json` (`{ "jina": false }`) or per-invocation via `--no-jina`. |
| `JINA_API_KEY` | (none) | Optional Jina Reader API key for higher rate limits. Without it: 20 req/min. With it: 500 req/min. Free keys available from [Jina](https://jina.ai/reader/) and include 10M tokens. |

## Code review variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_CURSOR_SANDBOX` | enabled | Set to `0`, `false`, or `disabled` to stop passing `--sandbox enabled` when launching Cursor's `agent` CLI for review jobs. The flag pair is omitted entirely (never `--sandbox disabled`), so your own Cursor Agent sandbox configuration governs — for systems where Cursor's sandbox cannot start (e.g. NixOS or AppArmor-restricted Linux). Set to `1` or `true` to keep it enabled (this is the default). Can also be set via `~/.plannotator/config.json` (`{ "cursorSandbox": false }`); the env var takes precedence. Note: opting out means the review job's write protection relies on `--mode ask` plus your own Cursor configuration. |

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
| `PASTE_MAX_SIZE` | `5242880` | Max encrypted payload size in bytes (5 MB) |
| `PASTE_ALLOWED_ORIGINS` | `https://share.plannotator.ai,http://localhost:3001` | CORS allowed origins (comma-separated) |

## Install script variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_VERIFY_ATTESTATION` | off | Set to `1` or `true` to have the install script run `gh attestation verify` on the downloaded binary. Requires the `gh` CLI but no login: the attestation bundle is fetched from GitHub's public attestations API and verified with `--bundle` (extraction needs node, python3, or jq on macOS/Linux); gh's authenticated fetch is the fallback. Can also be set via `~/.plannotator/config.json` (`{ "verifyAttestation": true }`) or per-invocation via `--verify-attestation`. |
| `PLANNOTATOR_MINIMAL` | off | Set to `1` / `true` / `yes` to install **only** the `plannotator` binary — no sem sidecar, CallDiff runtime, agent-terminal runtime, skills, hooks, slash commands, or per-agent config. Equivalent to passing `--minimal` (aliased `--binary-only`); pass `--no-minimal` to override. Read by the install scripts only, not the runtime binary. |
| `PLANNOTATOR_SKIP_SEM_INSTALL` | off | Set to `1` / `true` to skip installing the optional `sem` semantic-diff sidecar used by code review. Read by the install scripts only. |
| `PLANNOTATOR_INSTALL_CALLDIFF` | off | Set to `1` / `true` / `yes` to install the optional pinned, pruned CallDiff core (about 5 MB on macOS arm64, Node.js 22+). It is not installed by default; normally, enabling Call flow in-app consents to a background install of core and only the language packs required by each review. Equivalent to `--with-call-flow` (PowerShell: `-WithCallFlow`) or `{ "installCallFlow": true }`; flag > env var > config. Read by the install scripts only. |
| `PLANNOTATOR_CALLDIFF_PATH` | unset | Development override pointing at a built CallDiff `0.4.1` root with `dist/run.js`; optional grammars must already exist under its `node_modules`. Managed pack installation is disabled for overrides. |
| `PLANNOTATOR_SKIP_CODEX_INSTALL` | off | Set to `1` / `true` to skip writing the Codex integration (`hooks.json` / `config.toml` under `CODEX_HOME`) even when Codex is detected. The installer reports "detected, skipped" honestly and never removes an existing integration. Also via `~/.plannotator/config.json` (`{ "skipInstall": { "codex": true } }`) or the `--skip-codex` flag (flag wins over env var, which wins over config). Read by the install scripts only. |
| `PLANNOTATOR_SKIP_GEMINI_INSTALL` | off | Same opt-out for the Gemini CLI integration (`~/.gemini` policy, settings hook, commands). Config key `skipInstall.gemini`; flag `--skip-gemini`. Read by the install scripts only. |
| `PLANNOTATOR_SKIP_KIRO_INSTALL` | off | Same opt-out for the Kiro CLI integration (`~/.kiro` skills and agent). Config key `skipInstall.kiro`; flag `--skip-kiro`. Read by the install scripts only. |
| `PLANNOTATOR_SKIP_OPENCODE_INSTALL` | off | Do-not-write switch for the OpenCode integration (command stubs, plugin cache clear). Config key `skipInstall.opencode`; flag `--skip-opencode`. Read by the install scripts only. |
| `PLANNOTATOR_SKIP_SKILLS_INSTALL` | off | Set to `1` / `true` to skip the skills and slash-command checkout entirely: no `git clone` of the release tag, so nothing is written to `~/.claude/skills`, `~/.agents/skills`, the OpenCode or Gemini command directories, or `~/.kiro`, and the skill-scope cleanup sweeps stay suspended. The binary, hooks, and per-agent config still install, and git stops being a hard requirement. Unlike the per-agent opt-outs above, this covers every scope the checkout writes. Config key `skipInstall.skills`; flags `--skip-skills` (bash/cmd) and `-SkipSkills` (PowerShell). Read by the install scripts only. |
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

1. `PLANNOTATOR_PORT` environment variable: one integer from `0` to `65535` (`0` means random), or an inclusive range such as `19432-19463`
2. `19432` if in remote mode
3. `0` (random) if in local mode

For a range, Plannotator tries each port from lowest to highest and binds the first available one.

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
