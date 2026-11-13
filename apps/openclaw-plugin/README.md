# @plannotator/openclaw

Plannotator for [OpenClaw](https://github.com/openclaw/openclaw). It connects your own OpenClaw chats to the [Plannotator Inbox](https://plannotator.ai/docs/reference/inbox/): the agent gets a `plannotator_inbox` tool to send you messages and questions, the chat shows up when you write a new message in the Inbox, and your replies come back into the same chat as a new message.

## Install

The package is not published yet, so `openclaw plugins install @plannotator/openclaw` fails today. Install it from a checkout of this repository instead: pack the plugin, unpack it, and install that folder (the way it was tested). OpenClaw asks you to confirm a folder install; `--force` confirms it without asking.

```bash
git clone https://github.com/backnotprop/plannotator.git
cd plannotator && bun install && bun run build:openclaw
cd apps/openclaw-plugin && npm pack
mkdir -p ~/plannotator-openclaw && tar xzf plannotator-openclaw-*.tgz -C ~/plannotator-openclaw
openclaw plugins install ~/plannotator-openclaw/package
```

Once it is published, this is the install:

```bash
openclaw plugins install @plannotator/openclaw
```

No restart: the running Gateway loads it. It needs OpenClaw 2026.11.5-beta.1 or newer: until 2026.11.5 is out that means OpenClaw's beta (tested on 2026.11.5-beta.2), and older OpenClaw such as 2026.11.3 refuses to install it. It also needs to run on the same computer as the Inbox, with the `plannotator` CLI:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

## Turn it on

The Inbox tool starts off. Run `plannotator inbox` once: it finds this plugin and turns the tool on. You can also turn it on for OpenClaw in the Inbox's **Settings → Agents**, or add `{ "inboxTool": { "openclaw": true } }` to `~/.plannotator/config.json`, keeping its other keys. The tool appears only once the Inbox has run on this computer; if it never has, start it once with `plannotator inbox --background`. It applies from the next message in each chat.

## Who gets it

Only your own chats, with nothing to set up:

- OpenClaw on this computer (the CLI, the TUI, the Control UI), and your own direct messages, as OpenClaw knows you (`commands.ownerAllowFrom`, or the first sender you approved when pairing).
- In a group or a channel OpenClaw has no `plannotator_inbox` tool, even when you write there, and none for anyone else's messages. Someone else cannot use it, and your replies never go into their chat.

## Good to know

- Your reply arrives as a new message in the same chat. If the agent is busy, it waits until the current turn ends. The agent's answer goes where that chat's answers go (your Telegram DM gets it in Telegram).
- Installing it again after `openclaw plugins uninstall` leaves it disabled (OpenClaw keeps `enabled: false` for it): run `openclaw plugins enable plannotator`.
- Replies follow the chat, not the conversation: after `/new`, a reply goes into the chat's new conversation.
- The plugin only connects out to the Inbox on `127.0.0.1`. An OpenClaw on another machine (a VPS) cannot reach it yet.
