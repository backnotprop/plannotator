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

Restart OpenCode. The `submit_plan` tool is now available.

> **Existing users:** If you're stuck on an old version, clear both caches and restart:
> ```bash
> rm -rf ~/.cache/opencode/node_modules/@plannotator ~/.bun/install/cache/@plannotator
> ```

## How It Works

1. Agent calls `submit_plan` → Plannotator opens in your browser
2. Select text → annotate (delete, replace, comment)
3. **Approve** → Agent proceeds with implementation
4. **Request changes** → Annotations sent back as structured feedback

## Features

- **Visual annotations**: Select text, choose an action, see feedback in the sidebar
- **Runs locally**: No network requests. Plans never leave your machine.
- **Private sharing**: Plans and annotations compress into the URL itself—share a link, no accounts or backend required
- **Obsidian integration**: Auto-save approved plans to your vault with frontmatter and tags

## Environment Variables

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_REMOTE` | Set to `1` for remote mode (devcontainer, SSH). Uses fixed port and skips browser open. |
| `PLANNOTATOR_PORT` | Fixed port to use. Default: random locally, `19432` for remote sessions. |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in. macOS: app name or path. Linux/Windows: executable path. |

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

Then open `http://localhost:9999` when `submit_plan` is called.

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

Copyright (c) 2025 backnotprop. Licensed under [BSL-1.1](https://github.com/backnotprop/plannotator/blob/main/LICENSE).
