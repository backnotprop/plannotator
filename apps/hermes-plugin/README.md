# Plannotator for Hermes Agent

Connects [Hermes Agent](https://github.com/NousResearch/hermes-agent) to the [Plannotator Inbox](https://plannotator.ai/docs/reference/inbox/). The agent gets a `plannotator_inbox` tool to send you messages and questions, the session shows up when you write a new message in the Inbox, and your reply comes back into the Hermes session that asked as a new turn.

## Install

Hermes and Plannotator on the same computer. You need the `plannotator` command first ([install Plannotator](https://plannotator.ai/docs/getting-started/installation/)). Then:

```bash
hermes plugins install backnotprop/plannotator/apps/hermes-plugin --enable
hermes config set plugins.entries.plannotator.allow_gateway_injection true
```

The second line lets the plugin start a turn with your reply. Without it the tool still works, but replies wait in the Inbox until the agent reads them.

The first line installs what is on this repository's `main` branch, not a released version. It has not been tried from the public repository yet: the plugin was tested installed from a local folder (`hermes plugins install file://<checkout>#apps/hermes-plugin --enable`).

## Turn it on

The Inbox tool starts off. Run `plannotator inbox` once: it finds the plugin and turns the tool on. You can also use the switch for Hermes Agent in the Inbox's **Settings → Agents**. It applies to new Hermes sessions.

## Good to know

- Only your own sessions get it: the terminal, the TUI, the Desktop app, and your own direct messages to the bot. Your own direct messages count when you are on that platform's DM admin list (`allow_admin_from`), or when its allowlist names only you. In any other chat the tool refuses and nothing reaches the Inbox.
- Your reply waits until the session is idle, then starts a turn. It never goes into a running turn.
- In Hermes's classic window (`hermes`) the woken turn runs and is saved in the session, but that window does not show it. `hermes --tui` shows your reply and the answer as they happen.
- Tested on Hermes Agent 0.23.1 on Linux with a stand-in model; not yet on macOS, the Desktop app or real chat accounts.
- The plugin runs one `plannotator inbox connection` process next to Hermes, which talks only to the Inbox on `127.0.0.1`. It reads Plannotator's own data folder (`~/.plannotator`) and nothing of Hermes's.
