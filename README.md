<p align="center">
  <img src="apps/marketing/public/og-image.webp" alt="Plannotator" width="80%" />
</p>

# Plannotator

Interactive Plan Review for AI Coding Agents. Mark up and refine your plans using a visual UI, share for team collaboration, and seamlessly integrate with **Claude Code** and **OpenCode**.

<table>
<tr>
<td align="center" width="50%">
<h3>Claude Code</h3>
<a href="https://www.youtube.com/watch?v=a_AT7cEN_9I">
<img src="apps/marketing/public/youtube.png" alt="Claude Code Demo" width="100%" />
</a>
<p><a href="https://www.youtube.com/watch?v=a_AT7cEN_9I">Watch Demo</a></p>
</td>
<td align="center" width="50%">
<h3>OpenCode</h3>
<a href="https://youtu.be/_N7uo0EFI-U">
<img src="apps/marketing/public/youtube-opencode.png" alt="OpenCode Demo" width="100%" />
</a>
<p><a href="https://youtu.be/_N7uo0EFI-U">Watch Demo</a></p>
</td>
</tr>
</table>


**New:** 

 - We now support auto-saving approved plans to [Obsidian](https://obsidian.md/).

## Install for Claude Code

**Install the `plannotator` command:**

**macOS / Linux / WSL:**

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows PowerShell:**

```powershell
irm https://plannotator.ai/install.ps1 | iex
```

**Then in Claude Code:**

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator

# IMPORTANT: Restart Claude Code after plugin install
```

See [apps/hook/README.md](apps/hook/README.md) for detailed installation instructions including a `manual hook` approach.

---

## Install for OpenCode

Add to your `opencode.json`:

```json
{
  "plugin": ["@plannotator/opencode"]
}
```

That's it! Restart OpenCode and the `submit_plan` tool will be available.

---

## How It Works

When your AI agent finishes planning, Plannotator:

1. Opens the Plannotator UI in your browser
2. Lets you annotate the plan visually (delete, insert, replace, comment)
3. **Approve** → Agent proceeds with implementation
4. **Request changes** → Your annotations are sent back as structured feedback

---

## License

**Copyright (c) 2025 backnotprop.**

This project is licensed under the **Business Source License 1.1 (BSL)**.
