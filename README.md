<p align="center">
  <img src=".github/assets/banner.webp" alt="Plannotator" width="640" />
</p>



<p align="center">
  <strong>Everything you need to annotate and stay in the loop with your agents</strong><br/>
  <strong>Markdown Review • Code Review • HTML Artifacts</strong><br/>
  <sub>Annotate plans, specs, markdown, and HTML before implementation. Review diffs and PRs. Send feedback to your agent.</sub>
</p>

<p align="center">
  <img src=".github/assets/icons/amp.svg" alt="Amp" title="Amp" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/claude.svg" alt="Claude Code" title="Claude Code" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/codex.png" alt="Codex" title="Codex" height="28" />&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icons/copilot-dark.svg" />
    <img src=".github/assets/icons/copilot-light.svg" alt="Copilot CLI" title="Copilot CLI" height="28" />
  </picture>&nbsp;&nbsp;
  <img src=".github/assets/icons/droid.png" alt="Droid" title="Droid" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/gemini.png" alt="Gemini CLI" title="Gemini CLI" height="28" />&nbsp;&nbsp;
  <img src=".github/assets/icons/kiro.svg" alt="Kiro" title="Kiro" height="28" />&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icons/opencode-dark.svg" />
    <img src=".github/assets/icons/opencode-light.svg" alt="OpenCode" title="OpenCode" height="28" />
  </picture>&nbsp;&nbsp;
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset=".github/assets/icons/pi-dark.svg" />
    <img src=".github/assets/icons/pi-light.svg" alt="Pi" title="Pi" height="28" />
  </picture>
</p>

<p align="center">
  <a href="https://www.youtube.com/watch?v=a_AT7cEN_9I">Watch the og demo</a> · <a href="https://docs.plannotator.ai/open-source/start/installation">Installation guide</a> · <a href="https://plannotator.ai/">Official site</a> · <a href="https://github.com/plannotator/effective-html">Visual HTML Skills</a>
</p>

# Plannotator

Plannotator is a local, browser-based review surface for AI coding agents: Claude Code, Codex, Copilot CLI, Gemini CLI, OpenCode, Kiro, Droid, Amp, and Pi. 

**It plugs directly into your agent** through its hooks and commands. When the agent proposes a plan, html, or finishes writing code, the work opens in your browser and you mark it up, comment, and send feedback directly to the agent for it to act on it.

<table>
<tr>
<td width="40%" valign="middle">

### Review documents, plans, and agent messages

Annotate plans, specs, messages, html, then send the feedback to your agent. 

<p><strong>Demo:</strong> <a href="https://youtu.be/XqFun9XCXPw">Plan review with Pi</a></p>

</td>
<td width="60%">

<img src=".github/assets/annotate.webp" alt="Annotate UI with inline annotations" width="100%" />

</td>
</tr>
<tr>
<td width="40%" valign="middle">

### Code Review

Review local changes or remote PRs. Comment on diffs, suggest code. Your comments go back to the agent. Works with Git, GitButler, Jujutsu (`jj`), Perforce (`p4`), GitHub, and GitLab.

</td>
<td width="60%">

<img src=".github/assets/review.webp" alt="Code review with file tree and side-by-side diff" width="100%" />

</td>
</tr>
</table>

<p align="center">
  <sub><strong>AI built in:</strong> ask AI about anything you're reviewing,<br/>or launch AI reviews that post comments to the diff.</sub>
</p>

## Annotate HTML Artifacts

<p align="center">
  <img src=".github/assets/html.webp" alt="Annotating a rendered HTML artifact" width="720" />
</p>

---

## Commands

<sub>On Codex, swap the slash commands for `!plannotator …` (e.g. `!plannotator review`) or the `$plannotator-*` skills.</sub>

### Annotate

```
/plannotator-annotate README.md                  # Local markdown file
/plannotator-annotate src/                       # Browse and annotate files in a folder
/plannotator-annotate https://docs.rs/…          # Fetch and annotate any URL
/plannotator-annotate report.html --render-html  # Render HTML as-is instead of converting
/plannotator-last                                # Annotate the agent's last message
```

Need a realistic document to try? Copy the [product requirements document template and filled example](https://docs.plannotator.ai/templates/product-requirements-document) as Markdown.

### Code review

```
/plannotator-review                    # Review uncommitted changes
/plannotator-review <github-pr-url>    # Review a GitHub pull request
/plannotator-review <gitlab-mr-url>    # Review a GitLab merge request
plannotator review --gitbutler         # Review an active GitButler workspace
```

GitButler users can review the whole workspace, one stack, or one branch layer. See the [GitButler workflow guide](https://docs.plannotator.ai/open-source/workflows/gitbutler).

### Plan mode

No command needed. Plan mode is wired in through each harness's hooks. Any time your agent creates a plan, the markdown review surface opens for you.

### CLI

```
plannotator sessions                   # List active Plannotator sessions
plannotator sessions --open 1          # Reopen a session in the browser
plannotator archive                    # Browse saved plan decisions read-only
```

---

## Sharing &amp; Multiplayer

<p align="center">
  <a href="https://room.plannotator.ai/">
    <img src=".github/assets/sharing.png" alt="Sharing portal with upload options" width="720" />
  </a>
</p>

<p align="center">
  <sub>Beta: <a href="https://room.plannotator.ai/">room.plannotator.ai</a></sub>
</p>

<p align="center">
  <a href="https://plannotator.ai/workspaces">
    <img src=".github/assets/workspaces-cta.svg" alt="Beta is ending. Sign up for Workspaces." height="44" />
  </a>
</p>

Share a plan with a teammate and they can annotate it themselves. Import their feedback and send it straight back to your agent.

**Small plans** are encoded entirely in the URL hash. No server involved. The data lives in the link itself.

**Large plans** go through a short-link service, encrypted in your browser with AES-256-GCM. The server stores only ciphertext, and the key never leaves the URL fragment. Pastes auto-delete after 7 days.

Same model as [PrivateBin](https://privatebin.info/). The paste service is [self-hostable](https://docs.plannotator.ai/open-source/workflows/sharing).

Sharing can be disabled entirely with `PLANNOTATOR_SHARE=disabled`.

**Coming next:** live collaboration. Teammates and their agents working through the same plan or review together, in real time. It arrives in Workspaces once the room beta wraps. [Sign up here](https://plannotator.ai/workspaces).


---

## Install

One installer covers almost every agent. It installs the `plannotator` binary, auto-detects your installed agents, and configures hooks, skills, and slash commands for each:

```bash
# macOS / Linux / WSL
curl -fsSL https://plannotator.ai/install.sh | bash
```

```powershell
# Windows PowerShell
irm https://plannotator.ai/install.ps1 | iex
```

Want just the binary and nothing else? Pass `--minimal` (or export `PLANNOTATOR_MINIMAL=1`) to install only the `plannotator` binary to `~/.local/bin`, skipping every skill, hook, slash command, and per-agent config:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --minimal
```

Then finish the step for your agent:

| Agent | After the installer | Details |
|---|---|---|
| **Amp** | Copy [`plannotator.ts`](apps/amp-plugin/plannotator.ts) into `~/.config/amp/plugins/`, then `plugins: reload`. Workflows live in the command palette. | [README](apps/amp-plugin/README.md) |
| **Claude Code** | `/plugin marketplace add backnotprop/plannotator`, then `/plugin install plannotator@plannotator`. Restart Claude Code. | [README](apps/hook/README.md) |
| **Codex** | Nothing. Plan review is enabled automatically via Codex's experimental `Stop` hook (macOS/Linux/WSL; Codex hooks are disabled on Windows). `$plannotator-review`, `$plannotator-annotate`, and `$plannotator-last` skills included. | [README](apps/codex/README.md) |
| **Copilot CLI** | `/plugin marketplace add backnotprop/plannotator`, then `/plugin install plannotator-copilot@plannotator`. Restart. Plan review activates in plan mode (`Shift+Tab`). | [README](apps/copilot/README.md) |
| **Droid** | `droid plugin marketplace add https://github.com/backnotprop/plannotator`, then `droid plugin install plannotator@plannotator`. Commands only, no plan interception yet. | [README](apps/droid-plugin/README.md) |
| **Gemini CLI** | Nothing. The hook, policy, and slash commands are configured automatically. Requires Gemini CLI 0.36.0+. | [README](apps/gemini/README.md) |
| **Kiro CLI** | Nothing. Skills and an example agent are installed automatically. Try `kiro-cli chat --agent plannotator`. | [README](apps/kiro-cli/README.md) |
| **OpenCode** | Add `"plugin": ["@plannotator/opencode@latest"]` to `opencode.json`. Restart OpenCode. | [README](apps/opencode-plugin/README.md) |
| **Pi** | Skip the installer. Just `pi install npm:@plannotator/pi-extension`. Start Pi with `--plan`, or toggle with `/plannotator`. | [README](apps/pi-extension/README.md) |

Full walkthroughs live in the [installation docs](https://docs.plannotator.ai/open-source/start/installation).

<details>
<summary>Claude Code: manual hook setup (without the plugin system)</summary>

Add to `~/.claude/settings.json`:

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

</details>

<details>
<summary>Pin a specific version</summary>

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --version vX.Y.Z
```

```powershell
& ([scriptblock]::Create((irm https://plannotator.ai/install.ps1))) -Version vX.Y.Z
```

</details>

### Try it

The fastest way to see what Plannotator does is to invoke it yourself, right now, from your agent:

```
/plannotator-last                   # annotate the agent's last reply
/plannotator-review                 # review your current diff, PR-style
/plannotator-annotate report.html   # annotate any file, folder, or URL
```

(Slash commands in most agents; `$plannotator-*` skills in Codex, command palette in Amp.)

Plan review needs no command at all. The next time your agent proposes a plan, it opens in your browser automatically.

---

## How it works

### Plan review

```
Agent calls ExitPlanMode
  -> PermissionRequest hook fires
  -> Local server reads plan from hook input
  -> Browser opens with review UI
  -> You annotate and approve/deny
  -> Approve: agent proceeds
  -> Deny: structured feedback sent to agent
  -> Agent revises, plan diff shows what changed
```

### Code review

```
You run /plannotator-review
  -> git diff captures changes (or PR fetched by URL)
  -> Browser opens with diff viewer
  -> Annotate lines, stage/unstage files
  -> Send feedback: returned to agent session
  -> Approve: "LGTM" sent
```

---

## Integrations

**VS Code**: Open plans in editor tabs, view diffs inline, add annotations from the editor gutter. Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=backnotprop.plannotator-webview).

**Obsidian**: Auto-save approved plans to a vault with YAML frontmatter, tags from the plan title, and backlinks for graph connectivity. Configure in Plannotator's Settings panel.

**Bear**: Save plans as Bear notes with nested tags and project metadata.

**GitHub / GitLab**: Pass any PR or MR URL to `/plannotator-review` and review it with the full diff viewer, annotations, and file tree.

---

## Remote / SSH / devcontainer

Plannotator auto-detects SSH sessions and switches to a fixed port. For explicit control:

```bash
export PLANNOTATOR_REMOTE=1
export PLANNOTATOR_PORT=9999  # forward this port
```

VS Code devcontainers forward the port automatically (check the Ports tab). For raw SSH, add to `~/.ssh/config`:

```
Host your-server
    LocalForward 9999 localhost:9999
```

---

## Security

Every released binary ships with a SHA256 sidecar. [SLSA provenance](https://slsa.dev/) attestations are available from v0.17.2.

To verify on install:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash -s -- --verify-attestation
```

Requires `gh` installed and authenticated. Can also be set persistently in `~/.plannotator/config.json`:

```json
{ "verifyAttestation": true }
```

See the [verification docs](https://docs.plannotator.ai/open-source/start/installation#pin-or-verify-a-release) for details.

---

## Configuration

Settings are saved in cookies (not localStorage) because each hook invocation runs on a random port. You can also set options through environment variables or `~/.plannotator/config.json`.

### Optional Vim controls

Plan and annotate views offer a default-off **Vim controls** profile under
**Settings → Vim**. Once enabled, focus the document and use `j` / `k`
to move one rendered block at a time. After `l` refines into a semantic level,
`j` / `k` move among sibling rows, cells, or inline targets; `h` moves back to
the containing target. Refining past the deepest target enters text. `v`
starts characterwise Visual selection and
`V` selects whole blocks. `Space` opens the normal annotation toolbar; `c`,
`d`, `m`, and `t` select comment, redline, markup, and label actions. The same
semantic target graph drives pointer Pinpoint and keyboard navigation. Press
`?` in the document for the contextual key reference. Inputs, dialogs,
editors, `Tab`, and all pointer interactions retain their native behavior.
The document takes focus automatically when the page is otherwise neutral;
press `Escape` from app chrome to return to it without clicking.
An additional default-off **Vim HUD** toggle appears beneath Vim controls. It
uses the product-demo styling for the live target reticle and navigation
context. Its bottom-right **Key panel** is independently hideable while the
reticle remains active; `?` still opens the complete key map on demand. The
panel shows recent handled keys, the current block/line/word/Visual phase, and
the command meaning without capturing text typed into comments or other
controls.
See [Vim controls](docs/vim-controls.md) for the interaction contract and
implementation architecture.

| Variable | Description |
|---|---|
| `PLANNOTATOR_REMOTE` | `1`/`true` for remote mode, `0`/`false` for local, unset for SSH auto-detection |
| `PLANNOTATOR_PORT` | Fixed port (default: random locally, `19432` remote) |
| `PLANNOTATOR_BROWSER` | Custom browser to open plans in |
| `PLANNOTATOR_PRESENTER` | Executable implementing the one-request JSON presenter protocol; overrides `config.json` and may run outside Herdr |
| `PLANNOTATOR_AI` | `disabled` to disable Ask AI, Review Agents, and Guided Review; the annotate agent terminal is separate |
| `PLANNOTATOR_SHARE` | `disabled` to turn off URL sharing |
| `PLANNOTATOR_SHARE_URL` | Custom base URL for share links (self-hosted portal) |
| `PLANNOTATOR_PASTE_URL` | Base URL of the paste service API |
| `PLANNOTATOR_ORIGIN` | Override agent detection: `claude-code`, `amp`, `droid`, `opencode`, `codex`, `copilot-cli`, `gemini-cli`, `kiro-cli`, `pi` |
| `PLANNOTATOR_JINA` | `0`/`false` to disable Jina Reader for URL annotation |
| `JINA_API_KEY` | Jina Reader API key for higher rate limits |
| `PLANNOTATOR_DATA_DIR` | Base directory for all Plannotator data (plans, history, drafts, `config.json`). Default: `~/.plannotator`; if that directory doesn't exist and `$XDG_DATA_HOME` is set to an absolute path, `$XDG_DATA_HOME/plannotator` is used instead |

All Plannotator data lives in a single directory — `~/.plannotator` by default. To relocate it (e.g. for an XDG-clean home):

```bash
export PLANNOTATOR_DATA_DIR=~/.local/share/plannotator
```

Host integrations can persist an external presenter in
`~/.plannotator/config.json`:

```json
{
  "presenter": {
    "command": "/absolute/path/to/presenter",
    "when": "herdr"
  }
}
```

The command is executed directly without a shell. `when` defaults to
`"herdr"`, so the presenter is selected only when `HERDR_ENV=1`; use
`"always"` to enable it everywhere. An explicitly set
`PLANNOTATOR_PRESENTER` takes priority, and an empty value disables the
configured presenter for that invocation.

---

## Development

```bash
bun install

bun run dev:hook       # Plan review server
bun run dev:review     # Code review editor
bun run dev:marketing  # Marketing site (plannotator.ai)
bun run dev:vscode     # VS Code extension (watch mode)
```

### Build

```bash
bun run build          # Main targets (hook + opencode)
bun run build:hook     # Single-file HTML for the hook server
bun run build:review   # Code review editor
bun run build:opencode # OpenCode plugin
bun run build:vscode   # VS Code extension
```

Build order matters. The hook build copies pre-built HTML from `apps/review/dist/`. If you change UI code in `packages/ui/`, `packages/editor/`, or `packages/review-editor/`, rebuild the review app first:

```bash
bun run --cwd apps/review build && bun run build:hook
```

Test the plugin locally:

```bash
claude --plugin-dir ./apps/hook
```

Full binary build:

```bash
bun run --cwd apps/review build && bun run build:hook && \
  bun build apps/hook/server/index.ts --compile --outfile ~/.local/bin/plannotator
```


---

## License

Copyright 2025-2026 backnotprop

Dual-licensed under [Apache 2.0](LICENSE-APACHE) or [MIT](LICENSE-MIT) at your option.

Contributions are dual-licensed under the same terms unless you explicitly state otherwise.
