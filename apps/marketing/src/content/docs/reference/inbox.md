---
title: "Inbox"
description: "The Plannotator Inbox: one local window where agents leave messages, questions, files and guided reviews for you, and where your reply wakes the session that asked."
sidebar:
  order: 35
section: "Reference"
---

The Plannotator Inbox is one local window per machine. Agents leave messages for you there: questions you answer with a click, files to read and annotate, and guided reviews of their changes. You answer when you can, and nothing holds an agent session open while you do. When you press **Send**, the reply goes back to the session that asked. With Claude Code, Pi or OpenCode 2 it arrives as a new turn once the session is idle. Any other agent reads it with `wait_for_reply`.

The Inbox runs on your computer only. It binds `127.0.0.1` and keeps everything under your Plannotator data directory.

## Install and start

The Inbox ships in the `plannotator` binary. Install Plannotator as described in [Installation](/docs/getting-started/installation/), then run:

```bash
plannotator inbox
```

This starts the Inbox and opens it in your browser. If it is already running, the command opens the running one. Other forms:

| Command | What it does |
|---------|--------------|
| `plannotator inbox` | Start the Inbox and open it in the browser, or open the one already running |
| `plannotator inbox --background` | Start it detached without opening a browser, print its URL and exit. Agents run this form |
| `plannotator inbox --no-open` | Run it in this terminal without opening a browser |
| `plannotator inbox mcp` | The stdio MCP server for agents. It starts a stopped Inbox without opening a browser tab |

Run `plannotator inbox` once before you connect an agent. That first run writes the Inbox's registry file, and the connections look for that file when a session starts.

You never need to keep the Inbox running yourself. When an agent calls it and it is stopped, it starts in the background, and no tab opens.

## What you see

- **The list.** One row per thread, in sections: Stopped on you, Holding up work, Waiting on you, Sent, New since you looked, and Quiet (folded). A row shows the project, the agent, the subject and how many questions wait. New agent activity does not reorder the rows under you. It waits behind "N new in <project>" until you act.
- **Projects.** The sidebar lists each project an agent wrote from: the repository, or the folder when there is none. Click a project to see only its threads.
- **A thread.** It reads like email. Questions render as cards, and a click saves your pick at once. **Send** carries your picks, your words and your annotations as one reply. **Mod+Enter** sends. After a Send the reply reads "Saved for <agent>" until the agent reads it, then "Delivered to <agent>, <time>".
- **New message.** Next to Reply, **New message** writes to an agent session that is running now in the thread's project (Claude Code, Pi or OpenCode 2 with the inbox tool; Pi and OpenCode 2 sessions are listed once they have written in that project). With one session running, the message goes to it; with several, you pick one. The session takes it as its next turn. The message belongs only to the session you picked: another agent session reading the thread does not take it. When no session is running, the button says so and offers Reply instead.
- **Files.** Files an agent attached open beside the thread: markdown, text, HTML, Mermaid and Graphviz. Annotate them as in Plannotator, and the annotations ride your next Send. If the agent changes a file after it sent it, the Inbox says so and can still show the version it sent.
- **Images.** An image in a message, `![alt](path)` or `<img src="path">`, shows when the file is in the agent's project: a path relative to the folder the agent sent from, or an absolute one inside the project. PNG, JPEG, GIF, WebP, SVG, AVIF, BMP and ICO up to 10 MB. Images from the web (`https://…`) do not load.
- **Decisions.** A question can record your answer as a project decision. The switch on the card is on by default when the agent wrote `Decision: when answered`. The **Decisions** page lists what is waiting, what is settled, and what was replaced or retired.
- **Guided reviews.** An agent can send a guided review of a code change. It opens as sections, files and the diff, and you can tick sections as reviewed.
- **Notifications.** The open page can raise a browser notification when a new question arrives while the tab is in the background. The Inbox asks once, the first time something arrives. You can change this later in **Settings**.
- **Settings.** The inbox tool switch per host, notifications, the MCP command for other agents, and how much space each project and thread takes on disk, with **Delete thread** and **Delete project**.

How to write questions is described in [Questions in Plans and Documents](/docs/guides/questions/). The Inbox reads the same `:::question` blocks.

## Connecting your agent

### Claude Code

With the Plannotator plugin and [the Plannotator mod](/docs/guides/claude-code/#the-plannotator-mod) (Claude Code 2.1.287 or newer), Claude Code gets a `plannotator_inbox` tool when the Inbox is installed. The tool is on by default for Claude Code. Run `plannotator inbox` once, then restart Claude Code: the tool is added when Claude Code starts, not when you start a new conversation in a running one. When you send a reply, it arrives in that session as a new turn after Claude finishes what it is doing. The thread then shows "Delivered to Claude Code".

The mod is off in `claude -p`, in SDK runs and on Windows. There the tool is not added. Use the MCP server instead (see [Other agents](#other-agents)).

### Pi

Install the [Pi extension](/docs/getting-started/installation/#pi), then turn the inbox tool on for Pi. It is off by default on Pi, because Pi sends every tool's full definition with each request:

```bash
export PLANNOTATOR_INBOX_TOOL=1
```

Start a new Pi session (or `/reload`). A reply arrives as a follow-up message once Pi is idle, and Pi never interrupts a run for it. The thread shows "Delivered to Pi". The tool is inactive in print and JSON mode, because nothing could deliver a reply there.

### OpenCode

Add the [OpenCode plugin](/docs/getting-started/installation/#opencode), then turn the inbox tool on for OpenCode. It is off by default on OpenCode, for the same reason as Pi:

```bash
export PLANNOTATOR_INBOX_TOOL=1
```

Restart OpenCode. On OpenCode 2 a reply is queued into the session as its own turn once the session is idle, never mixed into a running turn, and the thread shows "Delivered to OpenCode". On OpenCode 1 the agent has the tool but is not woken. It reads replies with `read_thread` or `wait_for_reply`.

### The same session in two windows

You can open one Pi session twice (`pi -c` or `--session`), or run two OpenCode 2 servers on one database. Then only one process delivers a reply: the one you used last. On Pi, typing in a window or the agent calling the inbox tool there moves replies to that window. On OpenCode 2, only the agent calling the inbox tool moves them, because the plugin does not see what you type (checked on OpenCode 2.0.19). The process that holds replies checks in every 5 seconds. If it quits, another process takes over at once, and if it crashes, after about 20 seconds. A reply is delivered once either way.

## The inbox tool setting

The `plannotator_inbox` tool is one tool. Its actions are the Inbox's MCP tools (listed below). Your host adds it only when both of these are true at session start:

- the Inbox is installed (you ran `plannotator inbox` once), and
- the inbox tool setting is on for that host.

| Host | Default |
|------|---------|
| Claude Code (with the mod) | on |
| Pi | off |
| OpenCode | off |

There are three ways to change it. The first that decides wins:

1. The environment variable `PLANNOTATOR_INBOX_TOOL`: `1`, `true` or `on` turns it on for every host, and `0`, `false`, `off` or `disabled` turns it off.
2. `inboxTool` in `~/.plannotator/config.json`: one boolean for every host, or one per host, for example `{ "inboxTool": { "pi": true, "opencode": false } }`. The switches in the Inbox's **Settings** write this key, and they are disabled while the environment variable decides.
3. The default in the table above.

The setting is read when a session starts and never during one, because a change to the tool list mid-session would invalidate the model's prompt cache. After a change, restart Claude Code or OpenCode, or start a new Pi session (or `/reload`).

## Other agents

Any MCP client can use the Inbox through the stdio command:

```bash
plannotator inbox mcp
```

For example, with Claude Code without the plugin, or with Codex:

```bash
claude mcp add --scope user plannotator-inbox -- plannotator inbox mcp
codex mcp add plannotator-inbox -- plannotator inbox mcp
```

The Inbox's first-run screen and **Settings** give the exact command or install link for each client, with the absolute path of your `plannotator` binary filled in. The list covers Claude Code, the Claude app, Codex, Cursor, VS Code, Windsurf / Devin, Gemini CLI, Goose, Amp, Cline, Pi, OpenCode, Zed, Kiro, JetBrains, and any other MCP client. Apps started from the Dock may not see your shell's `PATH`, which is why the commands use the full path.

The Inbox also answers MCP over Streamable HTTP at `http://127.0.0.1:<port>/mcp`. Prefer the command: the port can change when the Inbox restarts.

The stdio command fills in the project (its working folder) and a session id for the agent. Without one of the three connections, nothing wakes the agent when you reply. The agent calls `wait_for_reply`, which returns your reply as soon as you send it, or a cursor to wait again after 50 seconds.

### The tools

| Tool | What it does |
|------|--------------|
| `send_message` | Send you a message. It can carry `:::question` blocks and `attachments` (files inside the project). `thread` names a thread to join, and `reply_to` answers one of your replies |
| `read_thread` | Read one thread, or list the threads this session wrote in |
| `wait_for_reply` | Wait for your reply, up to 50 seconds per call |
| `resolve_message` | Resolve or reopen a thread |
| `list_decisions` | List the project's decisions: current by default, or replaced, retired or all |
| `record_decision` | Record a decision the agent made, with its reason |
| `get_guide_brief` | Get the brief for writing a guided review, with an example that works as it is |
| `submit_guide` | Send a guided review: a guide plus its patch, or a snapshot |

No tool answers, approves or sends anything for you.

## Data on disk

Everything lives under `~/.plannotator/inbox/` (or `$PLANNOTATOR_DATA_DIR/inbox/`):

| Path | What it holds |
|------|---------------|
| `inbox.json` | The registry: port, URL, version, process id, and a token that changes at every start. Owner-only |
| `inbox.log` | The output of an Inbox started with `--background` |
| `projects/<name>-<hash>/` | One folder per project: `project.json`, plus `messages.jsonl`, `questions.jsonl`, `decisions.jsonl` and `annotations.jsonl`, which grow by appending lines |
| `blobs/<sha256>` | The version of each attached file as it was sent, and each guided review |
| `seq.json` | The highest event number ever written, kept across deletions |
| `claims/`, `leases/` and `connection-tools.json` | Bookkeeping for the Pi and OpenCode connections |

The Inbox stores the files agents attached as they were when sent, the messages and your replies. It sets no size limits. To free space, use **Delete thread** or **Delete project** in **Settings**, which also remove sent files that nothing else uses. Your choices for the inbox tool and notifications are kept in `~/.plannotator/config.json` (`inboxTool`, `inboxNotifications`).

## Uninstall

`plannotator uninstall` keeps your Inbox data. To remove it too:

```bash
plannotator uninstall --purge
```

This stops a running Inbox first, then deletes `~/.plannotator/inbox/` with the rest of the Plannotator data. If the Inbox does not stop, uninstall still removes the plugins, skills, hooks and config entries, but keeps your Plannotator data (`~/.plannotator`) and the `plannotator` binary. Quit the Inbox and run the command again to finish. Add `--dry-run` to see what would be removed.

## Troubleshooting

### The agent has no plannotator_inbox tool

- Run `plannotator inbox` once, then restart Claude Code or OpenCode, or start a new Pi session. A session that started before the Inbox was installed does not get the tool.
- On Pi and OpenCode, turn the inbox tool setting on: it is off by default there.
- On Claude Code, check that the mod is on (see [Turning the mod off](/docs/guides/claude-code/#turning-the-mod-off)). Without it, use `plannotator inbox mcp`.
- Check `PLANNOTATOR_INBOX_TOOL`: when set, it decides for every host, and the switches in **Settings** are disabled.

### The tool says to install Plannotator

The Pi or OpenCode connection could not find a `plannotator` binary to start a stopped Inbox. It looks for `PLANNOTATOR_BIN`, then `plannotator` on `PATH`, then `~/.local/bin/plannotator`. Install Plannotator, or set `PLANNOTATOR_BIN`.

### My reply did not arrive in the session

- A reply waits until the session is idle. It never interrupts a running turn.
- If the agent already read your reply with `read_thread` or `wait_for_reply`, the session is not woken again.
- On OpenCode 1, and for agents connected through MCP alone, nothing wakes the session. The agent has to read the reply.
- The reply stays in the thread. You can always read it there, and the agent can read it with `read_thread`.

### Notifications stopped

The Inbox moved to another port, because the old one was taken when it restarted, and browsers grant notifications per address. The Inbox shows "The Inbox moved to a new address. Allow notifications again." once. Turn them on again there or in **Settings**.

### "A new version is ready"

The `plannotator` binary on disk was updated while the Inbox kept running. Click **Restart** in the sidebar: the Inbox restarts on the new binary, and the page reloads.

### The Inbox does not start

Read `~/.plannotator/inbox/inbox.log`. If another Inbox is already running but not answering (paused or blocked), callers wait up to 20 seconds for it and then report an error rather than start a second one. Stop the stuck process and run `plannotator inbox` again.

### I work over SSH or in a container

The Inbox is local only. It always binds `127.0.0.1` and ignores `PLANNOTATOR_REMOTE` and `PLANNOTATOR_PORT`. Run it on the machine where you work and open it there.
