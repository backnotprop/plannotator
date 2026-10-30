---
title: "Configuration"
description: "Environment variables, hooks configuration, and runtime options for Plannotator."
sidebar:
  order: 3
section: "Getting Started"
---

Plannotator is configured through environment variables, hook/plugin configuration files, and an optional `~/.plannotator/config.json` file for persistent settings and feature-specific overrides.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_REMOTE` | auto-detect | Set to `1` or `true` to force remote mode, `0` or `false` to force local mode, or leave unset to auto-detect via `SSH_TTY` / `SSH_CONNECTION`. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. |
| `PLANNOTATOR_PORT` | random (local) / `19432` (remote) | Fixed server port or inclusive range. A range selects the first available port. Useful for forwarding or concurrent remote sessions. |
| `PLANNOTATOR_PUBLIC_URL` | unset | Full HTTP(S) origin advertised in remote mode behind a reverse proxy. The local runtime port is not appended. For a port range, this origin applies only to the first port; later ports use `PLANNOTATOR_URL_HOST` or `localhost`. On the port it fronts, it wins over `PLANNOTATOR_URL_HOST`. Binding is unaffected and local sessions ignore the override. Can also be set via `~/.plannotator/config.json` (`{ "publicUrl": "https://plannotator.example.com" }`). |
| `PLANNOTATOR_URL_HOST` | unset (`localhost`) | Hostname for advertised session URLs. Local sessions accept `localhost` and `*.localhost`, e.g. `plannotator.localhost` to isolate preference cookies. Other hosts (e.g. a Tailscale MagicDNS name) require remote mode, and remote mode ignores `*.localhost` names. Used when `PLANNOTATOR_PUBLIC_URL` is unset or does not apply. The runtime-chosen port is always appended; binding is unaffected. Can also be set via `~/.plannotator/config.json` (`{ "urlHost": "host" }`). |
| `PLANNOTATOR_BROWSER` | system default | Custom browser or script to open the UI. `none` opens no browser. |
| `PLANNOTATOR_AI` | enabled | Set to `disabled` to disable Ask AI, Review Agents, and Guided Review. External agents can still open reviews and submit annotations; the annotate agent terminal is separate. |
| `PLANNOTATOR_SHARE` | enabled | Set to `disabled` to turn off URL sharing entirely. Can also be set via `~/.plannotator/config.json` (`{ "share": "disabled" }`). |
| `PLANNOTATOR_SHARE_URL` | `https://share.plannotator.ai` | Point share links at a self-hosted portal. |
| `PLANNOTATOR_CLAUDE_MOD` | on | Set to `0` to turn off the [Plannotator mod](/docs/guides/claude-code/#the-plannotator-mod) for Claude Code and use the classic hook, where Claude waits for your decision. Can also be set via `~/.plannotator/config.json` (`{ "claudeCodeMod": false }`). |
| `PLANNOTATOR_AGENT_TOOL` | on for Claude Code and Oh My Pi, off on Pi and OpenCode 2 | Set to `1` to give the agent a `plannotator` tool, `0` to keep it out of the tool list (the slash commands are unchanged). Read when a session starts. Can also be set via `~/.plannotator/config.json` (`{ "agentTool": true }`). |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Respected by the install script when placing hooks. |

See the [environment variables reference](/docs/reference/environment-variables/) for full details, port resolution order, and examples.

## Isolate localhost preference cookies

Plannotator keeps your preferences in cookies. A browser sends a cookie set on
`localhost` to every app on `localhost`, whatever its port, so by default your
other local apps receive Plannotator's cookies too. To keep them to Plannotator,
give it a dedicated address, `plannotator.localhost`:

- In Settings → General, turn on **Open Plannotator at plannotator.localhost** (in
  plan review, code review, annotate, or the Inbox). This writes the setting
  below to config.json.
- Or add `"urlHost": "plannotator.localhost"` to `~/.plannotator/config.json`.

It applies from the next start: sessions and the Inbox then open at
`http://plannotator.localhost:<port>`. Servers still listen on `127.0.0.1`, and
remote mode is not needed. Restart an Inbox that is already running.

Prefer config.json (or the switch) over the `PLANNOTATOR_URL_HOST` environment
variable. An agent can start the Inbox in the background without your shell's
environment; it always reads config.json, so it opens at the same address.

**What carries over.** Settings saved in config.json carry over, such as the
theme, diff options and the update switches. Preferences kept only in this
browser start fresh once on the new address. The Inbox asks again for
notification permission, because the browser allows it per address.

**Going back.** Turn the switch off, or remove `urlHost` from config.json, and
restart. Your preferences on `localhost` are still there: nothing is moved or
deleted.

**Removing the old cookies.** The cookies Plannotator already set on
`localhost` stay until you remove them. In your browser's cookie storage for
`localhost`, filter for `plannotator-` and delete only those entries. Do not
clear all `localhost` cookies, which also removes other apps' data.

The switch is locked when config.json already sets `urlHost` to another value
(for example a tailnet name for remote mode, which it never replaces), or when
`PLANNOTATOR_URL_HOST` is set. It is not shown in remote mode or in a
`--tailscale` session. A remote session ignores `plannotator.localhost`
and advertises `localhost` as if nothing were set.

Browsers resolve `*.localhost` to `127.0.0.1` themselves. Tools that are not
browsers, such as `curl`, use the system resolver: on Linux without
`*.localhost` resolution, add `127.0.0.1 plannotator.localhost` to `/etc/hosts`.

Live app annotation (`plannotator annotate http://localhost:...`) still uses
`localhost` for both the editor and the app proxy. They must stay same-site so
the framed app keeps access to its `localhost` cookies, so this setting does not
isolate cookies in that mode.

## Hook configuration (Claude Code)

The hook is defined in `hooks.json` inside the plugin directory. When installed via the marketplace, this is managed automatically. For manual installation, add to `~/.claude/settings.json`:

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

The `matcher` targets the `ExitPlanMode` tool specifically. The `timeout` is in seconds (`345600` = 96 hours) — long reviews can stay open without expiring.

## Plugin configuration (OpenCode)

OpenCode uses `opencode.json` to load the plugin:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/opencode@latest"]
}
```

This uses the default `plan-agent` workflow: `submit_plan` is registered for OpenCode's `plan` agent, while `build` and other primary agents do not see it.

To configure the workflow explicitly:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["plan"]
    }]
  ]
}
```

When Plannotator is used with other OpenCode plugins, the options object must stay attached to the Plannotator plugin entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["plan", "sisyphus"]
    }],
    "oh-my-opencode-slim",
    "openviking-opencode"
  ]
}
```

Use `workflow: "manual"` for commands-only mode, or `workflow: "all-agents"` to restore the legacy behavior where primary agents can call `submit_plan`. In `plan-agent` mode, any names listed in `planningAgents` are added alongside OpenCode's built-in `plan` agent. Slash commands (`/plannotator-review`, `/plannotator-annotate`, `/plannotator-last`) require the CLI to be installed separately via the install script.

If you are upgrading from an older OpenCode install, see the [OpenCode 0.19.1 migration guide](/docs/guides/opencode-migration-0-19-1/).

## Plan saving

Approved and denied plans are saved to `~/.plannotator/plans/` by default. You can change the save directory or disable saving in the Plannotator UI settings (gear icon).

## Config file

Plannotator reads `~/.plannotator/config.json` for persistent settings. This includes display name, diff options, conventional comment labels, and feedback message customization.

The review open-state flags (`plannotator review --base <ref>` / `--diff-type <type>`) seed a single session and never change the saved defaults — Settings → Review remains the only writer. Git reviews open on `diffOptions.defaultDiffType`; Jujutsu reviews open on `reviewDefaults.jj.defaultDiffType` (`jj-current`, `jj-last`, `jj-line`, `jj-evolog` or `jj-all`; unset or invalid means `jj-current`).

To turn off the Claude Code mod (non-blocking plan review, code review and annotate, plus Ask this session), add `"claudeCodeMod": false`. It is on by default, `PLANNOTATOR_CLAUDE_MOD` wins over it, and Claude Code reads it when it starts. See [Claude Code](/docs/guides/claude-code/#turning-the-mod-off).

```json
{ "claudeCodeMod": false }
```

You can customize the messages Plannotator sends to the agent when you approve, deny, or annotate plans and documents. See the [custom feedback guide](/docs/guides/custom-feedback/) for the full config shape, template variables, and runtime-specific overrides.

## Remote mode

When working over SSH, in a devcontainer, or in Docker, set `PLANNOTATOR_REMOTE=1` (or `true`) and `PLANNOTATOR_PORT` to a port you'll forward. Set `PLANNOTATOR_REMOTE=0` / `false` if you need to force local behavior even when SSH env vars are present. See the [remote & devcontainers guide](/docs/guides/remote-and-devcontainers/) for setup instructions.

## Custom browser

`PLANNOTATOR_BROWSER` accepts an app name (macOS), executable path (Linux/Windows), or a custom script. This is useful for opening Plannotator in a specific browser or handling URL opening in unusual environments.

```bash
# macOS
export PLANNOTATOR_BROWSER="Google Chrome"

# Linux
export PLANNOTATOR_BROWSER="/usr/bin/firefox"

# Custom script
export PLANNOTATOR_BROWSER="/path/to/my-open-script.sh"

# Never open a browser
export PLANNOTATOR_BROWSER=none
```

`none` (also `false`, `0`, `off`, `no`, `true`, `1` or `:`, any case) opens no browser at all, in local and remote sessions: no VS Code tab, no Glimpse window, no `BROWSER`, no system opener. Every session prints its URL, so you open it when you want. `BROWSER` is different: hosts set it for their own reasons (Claude Code's agent view sets `BROWSER=true`), so those values on `BROWSER` are ignored and the default browser still opens.

For one-off overrides without changing your shell profile, use the `--browser` flag:

```bash
plannotator review --browser "Safari"
plannotator annotate plan.md --browser "Firefox"
```

## Session discovery

If you accidentally close a Plannotator browser tab, the server is still running — you just need the URL. The `sessions` subcommand lists active sessions and can reopen them:

```bash
plannotator sessions              # list active sessions
plannotator sessions --open       # reopen most recent session
plannotator sessions --open 2     # reopen a specific session
plannotator sessions --clean      # remove stale session files
```

Sessions are tracked automatically. Stale entries from crashed processes are cleaned up on the next listing.

## Disabling sharing

Set `PLANNOTATOR_SHARE=disabled` to remove all sharing UI — the Share tab, copy link action, and import review option are all hidden. Useful for teams working with sensitive plans. To make this persistent without an environment variable, add `"share": "disabled"` to `~/.plannotator/config.json`. The environment variable takes precedence over the config file.

To self-host the share portal instead, see the [self-hosting guide](/docs/guides/self-hosting/).

## Disabling AI

Set `PLANNOTATOR_AI=disabled` to disable Ask AI and the Review Agents / Guided Review execution surfaces, including provider and agent-job endpoints. Persisted guide data is retained and its server APIs remain available, but the in-app history browser is hidden while AI is disabled. External agents can still open reviews and submit annotations. The explicit annotate-mode agent terminal is a separate feature and remains controlled by its own settings.
