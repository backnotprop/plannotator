# @plannotator/opencode

**Annotate plans. Not in the terminal.**

Interactive Plan Review for OpenCode. Select the exact parts of the plan you want to change—mark for deletion, add a comment, or suggest a replacement. Feedback flows back to your agent automatically.

Obsidian users can auto-save approved plans to Obsidian as well. [See details](#obsidian-integration)

<table>
<tr>
<td align="center">
<strong>Watch Demo</strong><br><br>
<a href="https://youtu.be/_N7uo0EFI-U">
<img src="https://img.youtube.com/vi/_N7uo0EFI-U/maxresdefault.jpg" alt="Watch Demo" width="600" />
</a>
</td>
</tr>
</table>

## Install

### OpenCode 2

Install stable OpenCode 2 with `npm install -g @opencode/cli`, then add Plannotator to the V2 `plugins` field:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugins": [
    {
      "package": "@plannotator/opencode@latest",
      "options": {
        "workflow": "plan-agent",
        "planningAgents": ["plan"]
      }
    }
  ]
}
```

Restart OpenCode 2 and verify that `plannotator` appears in `opencode2 plugin list`.

To update, run the [install script](https://plannotator.ai/docs/getting-started/installation/) again and restart OpenCode 2. The script clears OpenCode 2's cached copy of the plugin, so the restart loads the latest `@plannotator/opencode`.

Plannotator builds against the stable `@opencode/plugin` API and checks its installed package against a real stable OpenCode 2 host in CI. The core `submit_plan` review flow and native slash commands are supported. Capability checks preserve fallbacks for older V2 builds:

- **Slash commands.** Stable OpenCode 2 supports native command execution (anomalyco/opencode issue #2185, PR #44765). Capability is detected from the command draft OpenCode hands the plugin: `ctx.command.transform` exists on both generations, and only the newer draft has `add`. On a host that has it, Plannotator registers `/plannotator-review`, `/plannotator-annotate`, and `/plannotator-last` itself and runs the same machinery OpenCode 1 uses, so your raw arguments reach the CLI unchanged and nothing is routed through the model. On an older host it registers nothing and the commands run from their markdown definitions, which ask the agent to run the `plannotator` CLI and relay its output; that path works but costs a model turn and depends on the agent following the instruction.
- **Command precedence.** OpenCode activates its own config-command loader after package plugins, and the last definition to claim a name wins, so the markdown stubs the installer writes to `~/.config/opencode/commands` would otherwise shadow the native definitions on every normal install. Plannotator re-registers the three names shortly after startup so its own definitions are the ones that run. If that reclaim cannot run, the stubs keep the names and the commands still work through the model-mediated fallback.
- **Agent switching.** `ctx.session.switchAgent` arrived with the same plugin API generation. On a host that exposes it, an agent switch chosen in the review UI is applied to the session. On an older host the plan is still approved and a warning is written to the server log; switch to `build` manually before implementation.
- **Ask this session.** In code review, annotate and `/plannotator-last`, Ask AI is answered by your OpenCode 2 session, and it is the only Ask AI option there. In plan review the session is waiting for your decision, so it gives a quick answer from its context only. Remote sessions and OpenCode 1 use a separate provider you pick.
- **Cancellation.** Stable V2 tool execution exposes an abort signal, but Plannotator's V2 adapter does not yet forward it to the review server or CLI child. Cancelling a turn cannot stop that review immediately.
- **Session URLs.** OpenCode 2 has a TUI plugin entry point, but it is separate from the server plugin Plannotator registers, so there is no toast to show and the plugin's own console output is discarded by the host unless you start it with `OPENCODE_PRINT_LOGS=1`. Instead, on a host whose plugin API exposes `session.synthetic`, Plannotator posts the URL into the session transcript as a `Plannotator session ready: <url>` notice, injected with `resume: false` so it appears without waking a model turn. The notice is for you, not the model: Plannotator removes it from every model request, so after a plan decision the model reads the decision, not the URL line. This covers every way a session opens: the three slash commands and the `submit_plan` plan review, whether the review runs on the embedded runtime or the CLI. That is the link to open for a remote session, which gets no browser opened for it. On an older host without `session.synthetic` the URL only reaches that discarded console output, so run with `OPENCODE_PRINT_LOGS=1` there.

### OpenCode 1

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/opencode@latest"]
}
```

Restart OpenCode. By default, the `submit_plan` tool is available to OpenCode's `plan` agent, not to `build` or other primary agents.

> **OpenCode 1 slash commands:** Run the install script to get `/plannotator-review`, `/plannotator-annotate`, and `/plannotator-last`:
> ```bash
> curl -fsSL https://plannotator.ai/install.sh | bash
> ```
> This also clears cached plugin versions for both OpenCode 1 and OpenCode 2. To update the plugin later, run the install script again and restart OpenCode.

## Workflow Modes

The examples below use the OpenCode 1 config shape. OpenCode 2 places the same option keys under the plugin entry's `options` object shown above. In V2, `manual` registers no `submit_plan`, so it leaves the slash commands and the `plannotator` tool, which every mode registers on OpenCode 2 once you turn it on. The slash commands need a host with native command execution and are inactive on one without it.

- **`plan-agent`** (default): `submit_plan` is available to OpenCode's built-in `plan` agent plus any extra agents listed in `planningAgents`. This keeps Plannotator integrated with OpenCode plan mode without nudging `build` to call it.
- **`manual`**: `submit_plan` is not registered. Use `/plannotator-last`, `/plannotator-annotate`, and `/plannotator-review` when you want Plannotator. On OpenCode 2 the agent can still open a review with the `plannotator` tool.
- **`user-managed`**: `submit_plan` is registered but no prompts or agent permissions are modified. You manage which agents can call `submit_plan` via OpenCode's native agent configuration.
- **`all-agents`**: legacy broad behavior. Primary agents can see and call `submit_plan`.

Default config:

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

Runtime selection is automatic. In Bun-hosted OpenCode, Plannotator uses the embedded server bundled with the plugin. In Node-hosted or wrapped OpenCode environments, the plugin falls back to the installed `plannotator` CLI and sends the result back through OpenCode. You can force the fallback while debugging:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "runtime": "cli"
    }]
  ]
}
```

If you use other OpenCode plugins, keep everything in one `plugin` array and attach Plannotator's options directly to the Plannotator entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["plan", "sisyphus"]
    }],
    "@tarquinen/opencode-dcp@latest",
    "octto",
    "oh-my-opencode-slim"
  ]
}
```

Do not put `{ "workflow": "plan-agent" }` as its own item in the `plugin` array. OpenCode plugin entries must be either a plugin string or a two-item array like `[pluginName, options]`.

Restore the old broad behavior:

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

Use commands only:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "manual"
    }]
  ]
}
```

Register the tool but manage prompts and permissions yourself:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "user-managed"
    }]
  ]
}
```

## How It Works

1. The configured planning agent calls `submit_plan` → Plannotator opens in your browser
2. Select text → annotate (delete, replace, comment)
3. **Approve** → Agent proceeds with implementation
4. **Request changes** → Annotations sent back as structured feedback

## Features

- **Visual annotations**: Select text, choose an action, see feedback in the sidebar
- **Local by default**: Plans, annotations, drafts, history, and configuration stay local. Every app load checks GitHub for updates without sending plan content, and there is currently no opt-out setting; URL annotation, hosted PR review, AI, sharing, and Workspaces use the network when selected.
- **Legacy link sharing**: Small markdown shares use compressed, unencrypted URL fragments. Larger and raw HTML shares can use client-encrypted short links. Workspaces is the primary direction for team sharing.
- **Plan Diff**: See what changed when the agent revises a plan after feedback
- **Annotate last message**: Run `/plannotator-last` to annotate the agent's most recent response
- **Annotate files, folders, and URLs**: Run `/plannotator-annotate` when you want manual review of an artifact
- **The `plannotator` tool (OpenCode 2, off by default)**: ask the agent to "open notes.md in Plannotator" and it opens the review itself, without waiting on it. Your feedback comes back later as a message that names the review's session id (`pn-…`). The agent can also list the reviews it opened in this session and close one it no longer needs; your unsent comments stay saved as a draft. The tool is off by default: turn it on with `PLANNOTATOR_AGENT_TOOL=1` or `{ "agentTool": true }` in `~/.plannotator/config.json` (the environment variable wins in both directions). OpenCode reads it when it starts.
- **Obsidian integration**: Auto-save approved plans to your vault with frontmatter and tags

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` / `true` for remote mode, `0` / `false` for local mode, or leave unset for SSH auto-detection. Uses a fixed port in remote mode; browser-opening behavior depends on the environment. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |
| `PLANNOTATOR_SHARE_URL` | Custom share portal URL for self-hosting. Default: `https://share.plannotator.ai`. |
| `PLANNOTATOR_PASTE_URL` | Custom paste service URL for self-hosting. Default: `https://plannotator-paste.plannotator.workers.dev`. |
| `PLANNOTATOR_PLAN_TIMEOUT_SECONDS` | Timeout for `submit_plan` review wait. Default: `345600` (96h). Set `0` to disable timeout. |
| `PLANNOTATOR_BIN` | Override the CLI path used by the OpenCode plugin's CLI runtime fallback. Default: `plannotator` on `PATH`. |

## Devcontainer / Docker

Works in containerized environments. Set the env vars and forward the port:

```json
{
  "containerEnv": {
    "PLANNOTATOR_REMOTE": "1",
    "PLANNOTATOR_PORT": "9999"
  },
  "forwardPorts": [9999]
}
```

If nothing opens automatically, open `http://localhost:9999` when `submit_plan` is called.

See [devcontainer.md](./devcontainer.md) for full setup details.

## Obsidian Integration

Save approved plans directly to your Obsidian vault.

1. Open Settings in Plannotator UI
2. Enable "Obsidian Integration" and select your vault
3. Approved plans save automatically with:
   - Human-readable filenames: `Title - Jan 2, 2026 2-30pm.md`
   - YAML frontmatter (`created`, `source`, `tags`)
   - Auto-extracted tags from plan title and code languages
   - Backlink to `[[Plannotator Plans]]` for graph view
  
<img width="1190" height="730" alt="image" src="https://github.com/user-attachments/assets/5036a3ea-e5e8-426c-882d-0a1d991c1625" />


## Links

- [Website](https://plannotator.ai)
- [GitHub](https://github.com/backnotprop/plannotator)
- [Claude Code Plugin](https://github.com/backnotprop/plannotator/tree/main/apps/hook)

## License

Copyright 2025 backnotprop Licensed under [MIT](../../LICENSE-MIT) or [Apache-2.0](../../LICENSE-APACHE).
