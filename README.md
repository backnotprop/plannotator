<p align="center">
  <img src="apps/marketing/public/og-image.webp" alt="Plannotator" width="80%" />
</p>

# Plannotator

Interactive Plan Review for AI Coding Agents. Mark up and refine your plans using a visual UI, share for team collaboration, and seamlessly integrate with **Claude Code**, **OpenCode**, and **Pi**.

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


### Features

<table>
<tr><td nowrap><strong>Visual Plan Review</strong></td><td nowrap>Built-in hook</td><td>Approve or deny agent plans with inline annotations</td></tr>
<tr><td nowrap><strong>Code Review</strong></td><td nowrap><code>/plannotator-review</code></td><td>Review git diffs with line-level annotations</td></tr>
<tr><td nowrap><strong>Annotate Any File</strong></td><td nowrap><code>/plannotator-annotate &lt;file&gt;</code></td><td>Annotate any markdown file and send feedback to your agent</td></tr>
</table>

## Install

- [Claude Code](#install-for-claude-code)
- [OpenCode](#install-for-opencode)
- [Pi](#install-for-pi)

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
  "plugin": ["@plannotator/opencode@latest"]
}
```

**Run the install script** to get `/plannotator-review`:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

**Windows:**
```powershell
irm https://plannotator.ai/install.ps1 | iex
```

This also clears any cached plugin versions. Then restart OpenCode.

---

## Install for Pi

```bash
pi install npm:@plannotator/pi-extension
```

Then start Pi with `--plan` to enter plan mode, or toggle it during a session with `/plannotator`.

See [apps/pi-extension/README.md](apps/pi-extension/README.md) for full usage details, commands, and flags.

---

## How It Works

When your AI agent finishes planning, Plannotator:

1. Opens the Plannotator UI in your browser
2. Lets you annotate the plan visually (delete, insert, replace, comment)
3. **Approve** → Agent proceeds with implementation
4. **Request changes** → Your annotations are sent back as structured feedback

---

## License

Copyright 2025 backnotprop

This project is licensed under either of

- [Apache License, Version 2.0](LICENSE-APACHE) ([http://www.apache.org/licenses/LICENSE-2.0](http://www.apache.org/licenses/LICENSE-2.0))
- [MIT license](LICENSE-MIT) ([http://opensource.org/licenses/MIT](http://opensource.org/licenses/MIT))

at your option.

### Contribution

Unless you explicitly state otherwise, any contribution intentionally submitted
for inclusion in this project by you, as defined in the Apache-2.0 license,
shall be dual licensed as above, without any additional terms or conditions.
