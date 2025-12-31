# @plannotator/opencode

**Annotate plans. Not in the terminal.**

Interactive Plan Review for OpenCode. Select the exact parts of the plan you want to change—mark for deletion, add a comment, or suggest a replacement. Feedback flows back to your agent automatically.

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
  "plugin": ["@plannotator/opencode"]
}
```

Restart OpenCode. The `submit_plan` tool is now available.

## How It Works

1. Agent calls `submit_plan` → Plannotator opens in your browser
2. Select text → annotate (delete, replace, comment)
3. **Approve** → Agent proceeds with implementation
4. **Request changes** → Annotations sent back as structured feedback

## Features

- **Visual annotations**: Select text, choose an action, see feedback in the sidebar
- **Runs locally**: No network requests. Plans never leave your machine.
- **Private sharing**: Plans and annotations compress into the URL itself—share a link, no accounts or backend required

## Links

- [Website](https://plannotator.ai)
- [GitHub](https://github.com/backnotprop/plannotator)
- [Claude Code Plugin](https://github.com/backnotprop/plannotator/tree/main/apps/hook)

## License

Copyright (c) 2025 backnotprop. Licensed under [BSL-1.1](https://github.com/backnotprop/plannotator/blob/main/LICENSE).
