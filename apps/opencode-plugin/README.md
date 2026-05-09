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

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/opencode@latest"]
}
```

Restart OpenCode. By default, the `submit_plan` tool is available to OpenCode's `plan` agent, not to `build` or other primary agents.

> **Slash commands:** Run the install script to get `/plannotator-review`, `/plannotator-annotate`, and `/plannotator-last`:
> ```bash
> curl -fsSL https://plannotator.ai/install.sh | bash
> ```
> This also clears any cached plugin versions.

## Workflow Modes

Plannotator supports four OpenCode workflows:

- **`plan-agent`** (default): `submit_plan` is available to OpenCode's built-in `plan` agent plus any extra agents listed in `planningAgents`. This keeps Plannotator integrated with OpenCode plan mode without nudging `build` to call it.
- **`manual`**: `submit_plan` is not registered. Use `/plannotator-last`, `/plannotator-annotate`, `/plannotator-review`, and `/plannotator-archive` when you want Plannotator.
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
- **Runs locally**: No network requests. Plans never leave your machine.
- **Private sharing**: Plans and annotations compress into the URL itself—share a link, no accounts or backend required
- **Plan Diff**: See what changed when the agent revises a plan after feedback
- **Annotate last message**: Run `/plannotator-last` to annotate the agent's most recent response
- **Annotate files, folders, and URLs**: Run `/plannotator-annotate` when you want manual review of an artifact
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
