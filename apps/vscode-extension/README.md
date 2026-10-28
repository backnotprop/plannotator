<p align="center">
  <img src="https://d17ygohy796f9l.cloudfront.net/vscode/icon.png" alt="Plannotator for VS Code" width="128" />
</p>

<h1 align="center">Plannotator</h1>

<p align="center">
  Interactive plan review and code review for AI coding agents — inside VS Code.
</p>

<p align="center">
  <a href="https://marketplace.visualstudio.com/items?itemName=backnotprop.plannotator-webview"><img src="https://img.shields.io/visual-studio-marketplace/v/backnotprop.plannotator-webview?label=Marketplace&logo=visualstudiocode" alt="VS Code Marketplace" /></a>
  <a href="https://code.visualstudio.com/"><img src="https://img.shields.io/badge/VS%20Code-^1.85.0-blue?logo=visualstudiocode" alt="VS Code" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-yellow.svg" alt="License: MIT" /></a>
</p>

Opens [Plannotator](https://plannotator.ai) plan reviews and code reviews inside VS Code tabs instead of an external browser. Works with Claude Code, OpenCode, and other AI agents running in the integrated terminal.

![Plannotator in VS Code](https://d17ygohy796f9l.cloudfront.net/vscode/plannotator-vscode.gif)

## Plan Review

Review, annotate, and approve AI-generated plans without leaving your editor. Add comments, mark deletions, compare versions with plan diffs, and send structured feedback back to the agent.

![Plan Review](https://d17ygohy796f9l.cloudfront.net/vscode/plan-review.jpeg)

![Plan Diffs](https://d17ygohy796f9l.cloudfront.net/vscode/plan-diffs.jpeg)

## Code Review

Review code changes with a full diff viewer, file tree, inline annotations, and AI-assisted review — all in a VS Code tab.

![Code Review](https://d17ygohy796f9l.cloudfront.net/vscode/code-review.jpeg)

## Guided Reviews

The **Guided Reviews** view (its own icon in the activity bar) turns a change into a guided review: a title, an intent, an overview with a diagram, and a few chapters in reading order, each with the files it covers. Pick this branch's pull request, another open PR, or your local changes, then the agent that writes the guide, with your own setup and sign-in, and watch it build. Then read it chapter by chapter in VS Code's own diff editor, with go to definition on the real files and ticks per chapter and file.

Clicking the view in the activity bar opens the **Guided Reviews** dashboard (also the home button in the view's title bar). It works with no folder open too: pull requests waiting on your review in every repository, your recent guided reviews from every repository, **Open a repository** and **Guide a pull request by link**. Clicking a pull request opens its guided review when there is one for the PR's current head, and otherwise starts one; **Open on GitHub** is the small button beside it. A pull request of a repository you don't have open is guided from a clone Guided Reviews keeps in its own storage (blobless, nothing checked out of yours).

The agent runs over the [Agent Client Protocol](https://agentclientprotocol.com). Guided Reviews looks for each agent in your settings first, then on your PATH.

**Claude Code, Codex and Pi** speak ACP through a separate npm adapter. When the adapter is not in your settings or on your PATH, Guided Reviews installs it for you the first time you pick the agent ("Installing Claude Code's ACP adapter…"): the exact version below, into the extension's own storage, with `npm install --ignore-scripts --before=<pin date>`, so its dependencies are also ones published at least 7 days before it was pinned. Nothing is installed globally and nothing needs `sudo`; the copy is reused next time, and **Guided Reviews: Update Agent Adapters** installs it again. This needs npm. When npm is missing or the install fails, you see why, the command to run yourself, and **Retry**. Turn it off with `plannotator.guides.installAdapters`.

**The Claude Code and Codex adapters run your own `claude` and `codex`.** Each adapter brings its own copy of the agent, and runs it unless told otherwise. Guided Reviews sets `CLAUDE_CODE_EXECUTABLE` (Claude Code) or `CODEX_PATH` (Codex) to the CLI on your PATH, so a guide runs the version you installed. A value you set yourself is kept. The adapter runs its own copy, as before, in three cases: the CLI is not on your PATH, `plannotator.guides.useInstalledCli` is off, or you are on Windows and the CLI is not an `.exe` (an npm-installed `claude.cmd` cannot be started by the adapter). The Plannotator output channel says which copy runs on each launch. If a guide fails to start with your CLI, the error says so: update the CLI, or turn off `plannotator.guides.useInstalledCli`.

**The other agents are their own program**, and Guided Reviews never installs them: **Install &lt;agent&gt;** opens a terminal with the official install command typed in, for you to run.

| Agent | Started as | Installed by |
|---|---|---|
| Claude Code | `claude-agent-acp` | Guided Reviews (`@agentclientprotocol/claude-agent-acp@0.91.0`), or `npm install -g @agentclientprotocol/claude-agent-acp@0.91.0` |
| Codex | `codex-acp` | Guided Reviews (`@agentclientprotocol/codex-acp@2.2.2`, which brings the Codex CLI), or `npm install -g @agentclientprotocol/codex-acp@2.2.2` |
| Pi | `pi-acp` | Guided Reviews (`pi-acp@0.0.34`); Pi itself: `npm install -g @earendil-works/pi-coding-agent` |
| OpenCode | `opencode acp` | you: `curl -fsSL https://opencode.ai/install \| bash` |
| GitHub Copilot CLI | `copilot --acp --stdio` | you: `npm install -g @github/copilot` |
| Cursor | `cursor-agent acp` (or `agent acp`) | you: `curl https://cursor.com/install -fsS \| bash` |
| Kiro CLI | `kiro-cli acp` | you: `curl -fsSL https://cli.kiro.dev/install \| bash` |
| Kilo Code | `kilo acp` (or `kilocode acp`) | you: `npm install -g @kilocode/cli` |

Pi can't write guides yet: `pi-acp` does not pass MCP servers on to Pi, so Pi cannot reach the guide's tools. Any other ACP agent works through `plannotator.guides.customAgent.command` (and `.args`, `.label`). `plannotator.guides.agentCommands` overrides how a listed agent is started (`plannotator.guides.claudeCode.command` still works for Claude Code). These settings, `plannotator.guides.installAdapters`, `plannotator.guides.useInstalledCli`, `plannotator.guides.autoApprove` and `plannotator.guides.ghPath` can only be set in your user settings, never by a workspace.

**Guided Reviews run your agent with your own configuration and permissions.** What the agent may do is governed by your agent's settings, exactly as when you run it yourself. Plannotator adds only what a guide needs: its own tool server (the guide's builder tools, which change nothing but the draft), the model and effort you pick, and the prompt.

- **Approvals.** When the agent asks before doing something, the request waits in the guide's view, with every option the agent offers ("allow once", "always allow", "reject", …), and in a notification. Your answer goes back to the agent as it is. The guide's own builder tools are approved without asking.
- **Approve automatically (opt-in).** You can let the agent work without asking: when you start a guide, at the first request ("Approve all for this run" or "Always approve during guides"), or with the `plannotator.guides.autoApprove` setting. Every request the agent asks about is then approved, and where the agent has a mode that does not ask, Plannotator switches to it and says so in the run's header (Claude Code: `acceptEdits`; Codex: `agent`; a session already in a mode that asks as little or less is left as it is). Off by default.
- **When your setup holds the run back,** the guide's view says so plainly and the run goes on. It names a request you turned down, a tool your agent's settings or sandbox blocked, and an agent that never reached the guide's tools. Where there is a way through, it offers it in one click: "Approve automatically for this run", or "Resume with automatic approval".
- **Pull requests** need the GitHub CLI (`gh`). Each PR opens in a git worktree of its own in the extension's storage, so your checkout is never touched. Like any checkout, it may carry its own agent config (hooks, allow rules, MCP servers), and your agent loads it as it would anywhere.
- **The agent inherits VS Code's environment,** including any credentials in it.
- Guided reviews are saved where Plannotator's web app finds them: open and export them from either side.

### Ask the agent

While you read a guide, ask the agent about the change, and it answers with a page beside the diff: a few short paragraphs and, when it helps, a picture it draws.

- **Where you ask.** Select code in a guide's diff and right-click **Ask the Agent About This…**, or use **Ask…** in the file's CodeLens line (the selection, or the whole file). A question box opens right under the lines: it says what goes with your question, offers suggestions ("Why did this change?", "What could break?", "Draw how this works", …) and the questions asked before about this file (each opens its answer), and takes your own question: click its field, type, and **Ask** (or **Cancel**). The field takes one click: the box never moves your cursor or selection. The gear in its header changes the agent, model and effort. Or use the chapter view's box **Ask the agent about this chapter…** (type and press Enter, or leave it empty for suggestions). No keyboard shortcut; bind `plannotator.guides.askAboutSelection` if you like.
- **While it answers,** the box shows your question and the agent's progress (time, cost, the files it read, **Stop**); when it is done the answer opens beside the diff and the box links to it. Ask follow-ups in the same box. The box is a VS Code comment thread: it is listed in the Comments panel, and VS Code opens that panel by itself the first time a box shows in a window (set `"comments.openView"` to `"never"` or `"firstFileUnresolved"` to stop it). Closing or switching the guide while the agent answers in a box stops that answer. Boxes are not saved; closing the guide removes them (the answers stay).
- **Who answers.** The agent, model and effort that wrote the guide, with your own config and permissions, exactly as for a guide. When the agent can reload sessions (ACP `session/load`; the pinned Claude Code, Codex and Pi adapters advertise it), the first question picks up the session that wrote the guide, so it remembers what it read; otherwise a new session starts with the guide, the selected code and the file's diff. Follow-ups continue the same conversation. The agent stops after 10 minutes with nothing asked; the next question loads the conversation again where it can.
- **The answer** opens in a tab "Answer: …" beside the diff (asked from the chapter view, the tab opens at once and shows the agent's work: Stop, its tool calls, its text as it writes), with the same approval panel as a guide. The agent hands its page over with the `show_answer` tool; an agent that answers without it (or cannot reach MCP servers, as Pi through pi-acp) has its last message shown as a text answer. Links in the page open the code in the guide's diff (`code:`), a symbol (`symbol:`) or a chapter (`chapter:`); a web link asks before it opens.
- **The page runs as the agent wrote it, scripts included,** in a sandboxed frame: it cannot reach VS Code, the extension or the network.
- **Answers are saved with the guide** and listed under the chapter ("Answers · N"); an answer written before the code moved says so. Deleting the guide deletes them; with guide history off they are kept until VS Code closes. They stay in VS Code: exported and shared guides carry none.

## Features

- **In-editor plan review** — approve or deny plans with annotated feedback, directly in a VS Code tab
- **In-editor code review** — review git diffs and PR changes with inline comments and suggestions
- **Editor annotations** — select code directly in your editor and annotate it with `Cmd+Shift+.` — annotations appear in the Plannotator review UI alongside inline comments
- **Theme sync** — Plannotator adapts to your VS Code color theme automatically, and steps aside as soon as you pick a theme of your own in Plannotator's settings. A palette you chose is always used verbatim, and choosing Light or Dark pins the panel to that mode whatever the IDE is set to. Leave the mode on System to keep following the editor. Panels that predate theme sync stored Dark before the mode was ever a choice, so the first panel you open after upgrading resets that one stored Dark to System. It happens once: pick Dark again and it stays.
- **Cookie persistence** — your identity, settings, and preferences persist across sessions
- **Auto-close** — panels close automatically when you approve or send feedback

## How It Works

1. The extension injects a `PLANNOTATOR_BROWSER` env var into integrated terminals
2. When Plannotator opens a URL, a bundled router script sends it to the extension via a local IPC server
3. The extension opens the URL in a WebviewPanel with an embedded iframe
4. A reverse proxy handles cookie persistence transparently (VS Code webview iframes don't support cookies natively)

## Getting Started

1. Install this extension from the VS Code Marketplace
2. Install the [Plannotator Claude Code plugin](https://github.com/backnotprop/plannotator):
   ```
   /install-plugin backnotprop/plannotator
   ```
3. **Launch Claude Code from VS Code's integrated terminal** — this is required so the extension can intercept browser opens. Plan reviews, code reviews, and annotations will automatically open in VS Code tabs instead of an external browser.

> **Note:** Terminals opened before the extension activates won't have the required environment variables. If plans open in an external browser, open a new integrated terminal and try again.

## Configuration

| Setting | Default | Description |
|---------|---------|-------------|
| `plannotatorWebview.injectBrowser` | `true` | Redirect Plannotator to open in VS Code instead of an external browser |

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| **Plannotator: Open URL** | — | Manually open a Plannotator URL in a panel |
| **Plannotator: Add Annotation** | `Cmd+Shift+.` | Annotate selected code in the editor |

## Troubleshooting

### URL opens in external browser instead of VS Code
- Ensure `plannotatorWebview.injectBrowser` is enabled
- Open a **new** terminal after installing the extension (existing terminals won't have the env var)

### Panel shows a blank page
- Check if Plannotator's server is still running
- Some network configurations may block localhost access from the webview

## Requirements

- [Plannotator](https://github.com/backnotprop/plannotator) Claude Code plugin installed
- VS Code 1.85.0+

## License

MIT
