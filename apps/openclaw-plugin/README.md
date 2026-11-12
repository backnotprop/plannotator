# @plannotator/openclaw

Plannotator for [OpenClaw](https://github.com/openclaw/openclaw). It connects your own OpenClaw chats to the [Plannotator Inbox](https://plannotator.ai/docs/reference/inbox/): the agent gets a `plannotator_inbox` tool to send you messages and questions, the chat shows up when you write a new message in the Inbox, and your replies come back into the same chat as a new message.

## Install

```bash
openclaw plugins install @plannotator/openclaw
```

No restart: the running Gateway loads it. It needs OpenClaw 2026.11.3 or newer, on the same computer as the Inbox, and the `plannotator` CLI:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

## Turn it on

The Inbox tool is off by default, because OpenClaw sends every tool's definition with each request. Turn it on for OpenClaw in the Inbox's **Settings → Agents**, or add `{ "inboxTool": { "openclaw": true } }` to `~/.plannotator/config.json`, keeping its other keys. (`plannotator inbox` also turns it on when it finds this plugin.) The tool appears only once the Inbox has run on this computer; if it never has, start it once with `plannotator inbox --background`. It applies from the next message in each chat.

## Who gets it

Only your own chats, with nothing to set up:

- OpenClaw on this computer (the CLI, the TUI, the Control UI), and your own direct messages, as OpenClaw knows you (`commands.ownerAllowFrom`, or the first sender you approved when pairing).
- Never a group or a channel, even when you write there, and never anyone else's messages. Someone else cannot use the tool, and your replies never go into their chat.

## Good to know

- Your reply arrives as a new message in the same chat. If the agent is busy, it waits until the current turn ends. The agent's answer goes where that chat's answers go (your Telegram DM gets it in Telegram).
- Replies follow the chat, not the conversation: after `/new`, a reply goes into the chat's new conversation.
- The plugin only connects out to the Inbox on `127.0.0.1`. An OpenClaw on another machine (a VPS) cannot reach it yet.
