---
title: "Inbox"
description: "The Plannotator Inbox: one local window where agents leave messages, questions, files and guided reviews for you, and where your reply wakes the session that asked."
sidebar:
  order: 35
section: "Reference"
---

The Plannotator Inbox is one local window per machine. Agents leave messages for you there: questions you answer with a click, files to read and annotate, and guided reviews of their changes. You answer when you can, and nothing holds an agent session open while you do. When you press **Send**, the reply goes back to the session that asked. With Claude Code, Pi or OpenCode 2 it arrives as a new turn once the session is idle. Any other agent reads it with `wait_for_reply`.

The Inbox runs on your computer. It binds `127.0.0.1` and keeps everything under your Plannotator data directory. To open it from your other devices, publish it [over your tailnet](#over-your-tailnet).

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
| `plannotator inbox --tailscale` | Also publish it [over your tailnet](#over-your-tailnet) until it stops. Works with the forms above. If the Inbox is already running, it is asked to publish |
| `plannotator inbox mcp` | The stdio MCP server for agents. It starts a stopped Inbox without opening a browser tab |

Run `plannotator inbox` once before you connect an agent. That first run writes the Inbox's registry file, and the connections look for that file when a session starts.

You never need to keep the Inbox running yourself. When an agent calls it and it is stopped, it starts in the background, and no tab opens.

### Your agents are connected for you

When you run `plannotator inbox` (not `--background`, which is how agents start it), it connects the agents it finds on this computer that are not connected yet, and says which on the terminal:

```
Connected Codex, Gemini CLI and Cursor to the Inbox (Claude Code was already on).
Pi needs connecting by hand: Pi before 0.99 has no `pi mcp`; update Pi, or add plannotator-inbox to ~/.pi/agent/mcp.json by hand.
Agents use it from their next session. PLANNOTATOR_INBOX_CONNECT=0 skips this step; plannotator uninstall removes what it added.
```

| Agent | Found when | What is added |
|-------|------------|---------------|
| Claude Code | the Plannotator plugin is enabled | nothing: the plugin already gives it the `plannotator_inbox` tool |
| Pi, OpenCode | Plannotator's extension or plugin is installed | the inbox tool turned on (`inboxTool` in `~/.plannotator/config.json`) |
| Pi without the extension | Pi 0.99 or later on your `PATH` (older Pi has no `pi mcp`: connect it by hand) | `pi mcp add plannotator-inbox` |
| Codex | `codex` 0.35 or later on your `PATH` (older Codex has no `codex mcp add`, and a `~/.codex` or `$CODEX_HOME` folder without the CLI: connect it by hand) | `codex mcp add plannotator-inbox` (the Codex app and IDE extension share it) |
| Gemini CLI | `gemini` 0.1.19 or later on your `PATH` (older has no `gemini mcp add`: connect it by hand; `$GEMINI_CLI_HOME` honored) | `gemini mcp add -s user plannotator-inbox` |
| Windsurf / Devin, Amp | `devin` or `amp` on your `PATH` | the agent's own `mcp add plannotator-inbox` |
| Cursor, Kiro | `~/.cursor` exists or `cursor` / `cursor-agent` is on your `PATH`; `~/.kiro` exists or `kiro-cli` is on your `PATH` | one `plannotator-inbox` key in `~/.cursor/mcp.json` or `~/.kiro/settings/mcp.json` |
| The Claude app | its settings folder exists | one key in `claude_desktop_config.json` (restart the Claude app) |

Each entry runs `<your plannotator binary> inbox mcp`. The agent uses it from its next session. Before it runs an agent's own command, Plannotator checks the program's `--version`, so a different program with the same name is never handed it. Cline is not connected automatically yet: add it in Cline's MCP settings. When an agent started the Inbox in the background, a later `plannotator inbox` connects agents with the Inbox's environment (the `PATH` and home it was started with).

- Every later `plannotator inbox` connects an agent installed since, and says so once ("Connected Amp to the Inbox (new on this computer)").
- An agent you turned off (its switch in the Inbox's Settings → Agents, or `inboxTool: false` in config.json for Pi and OpenCode), or whose `plannotator-inbox` entry you removed after Plannotator added or found it, is never added back by itself. Turn it back on in Settings → Agents.
- An agent only you can connect (no CLI on your `PATH`, Pi before 0.99, Cline) is named once on the terminal with the reason, and again only if the reason changes.
- An existing `plannotator-inbox` entry that runs something else is never replaced.
- In a JSON file only that one entry is added; every other byte of the file stays as it was, and removing it gives the file back exactly as it was (an empty file stays empty; a file Plannotator created is deleted). A file Plannotator cannot edit that way (comments, a duplicate key) is left as it was, and the terminal says why.
- Editors (VS Code, Zed, JetBrains, Goose) are never changed. Settings has a one-click link or a snippet for each.
- `PLANNOTATOR_INBOX_CONNECT=0` skips this step.
- `plannotator uninstall` removes every entry it recorded adding (never one you added yourself). `--dry-run` lists them first. If its record (`~/.plannotator/inbox/agents.json`) is gone, it removes none: an entry that runs this Plannotator is named with how to remove it, since you may have added it by hand.

### A note in each agent's instructions

The first time you open the Inbox after it connected your agents, a dialog asks whether to add a short note about the Inbox to each agent's own instructions file, so agents send you decisions and finished work there while you are away. It lists each agent with the exact file, every agent ticked (Claude Code too), and writes nothing until you press **Add**: untick an agent to leave it out, or choose **Not now**. The top of the dialog says which agents `plannotator inbox` just connected. Each agent is asked once: an agent you connect later (say, Codex next week) gets the same dialog for itself alone. The dialog never opens on the same page load as another one-time dialog (the sound dialog comes first). The files:

| Agent | File |
|-------|------|
| Claude Code | `~/.claude/rules/plannotator-inbox.md` (a file of its own) |
| Codex | `~/.codex/AGENTS.override.md` when you have one, else `~/.codex/AGENTS.md` |
| Gemini CLI | `~/.gemini/GEMINI.md` (or your `context.fileName`) |
| Pi | the one instructions file Pi reads in `~/.pi/agent/` |
| OpenCode | `~/.config/opencode/AGENTS.md`, only when you already have it: creating it would stop OpenCode 1 reading your `~/.claude/CLAUDE.md` |

The note sits between two marker lines at the end of the file. Plannotator never overwrites a note you edited, and removing it removes only that section. `plannotator inbox --notes codex,gemini` adds it from the terminal (the agent install prompt runs this only after you say yes). `plannotator inbox --help` lists the exact files on your computer.

### Settings → Agents

Settings lists each agent found on this computer with up to three switches: **Reaches the Inbox** (its MCP entry, or the inbox tool for Claude Code, Pi and OpenCode), **Reminder at session start** (Claude Code, Pi and OpenCode: one line at the start of each session that has the inbox tool) and **Note in its instructions**. A change applies to that agent's next session. An agent you turn off here is never connected again by `plannotator inbox`. Agents not found are folded under **Not found on this computer**, with the command or one-click link for each, editors included.

## What you see

- **The list.** One row per thread, in sections: Stopped on you, Holding up work, Waiting on you, New since you looked, Sent, and Quiet (folded). Sent waits on the agent, not on you, so it sits below what is new. A row shows the project, the agent, the subject and how many questions wait. New agent activity does not reorder the rows under you. It waits behind "N new in <project>" until you act. Nothing you do in an open thread reorders the list either: the list catches up when you leave the thread.
- **Projects.** The sidebar lists each project an agent wrote from: the repository, or the folder when there is none. Click a project to see only its threads.
- **Copy connect prompt.** Just above **Settings** in the sidebar. One click copies a short prompt to paste into any agent on this computer (Codex, Cursor, a new Claude Code session, any other). The prompt names the full path of your `plannotator` and tells the agent to read `plannotator inbox --help`, connect itself, and send you a first message offering to send some real recent work. The row reads **Copied** for two seconds.
- **A thread.** It reads like email. Questions render as cards, and a click saves your pick at once. **Send** carries your picks, your words and your annotations as one reply. **Mod+Enter** sends. Once a Send answers at least one question, it skips the ones you left unanswered, and the reply tells the agent so; the reply box says how many before you send, and **Keep open** leaves them open for that Send. A reply with no answers (only your words or annotations) leaves every question open by default, and the agent is told not to ask again because you will answer in the Inbox; **Skip them** skips them instead. After a Send the reply reads "Saved for <agent>" until the agent reads it, then "Delivered to <agent>, <time>". Messages you already read fold to one line (click one to open it, or **Expand all**), and a thread opens at **New since you looked**; `j` and `k` move between messages and `n` jumps to the first new one.
- **Mark read.** To get a thread out of the top without answering it, press **Mark read** in the thread's header (or `E`, or the button that shows when you hover a row). The thread moves to Quiet, marked "Read", and its unanswered questions close. A few seconds later the agent that asked gets one note from you: "Set aside for now; don't wait on these:" and the questions. The thread comes back to the top when the agent writes again. **Undo** in the toast, or `Z`, reopens the questions that Mark read closed, as they were; the pressed **Read** button does the same later. Questions an earlier Mark read closed stay closed. If an agent was stopped on the thread, the toast says so and offers **Reply**.
- **Archive.** The archive icon in the thread's header ends the thread: its questions close, and the agent's next message starts a new thread. **Unarchive** in the thread's foot reopens it. (Agents call this `resolve_message`.)
- **New message.** Next to Reply, **New message** writes to an agent session that is running now in the thread's project (Claude Code, Pi or OpenCode 2 with the inbox tool; Pi and OpenCode 2 sessions are listed once they have written in that project). With one session running, the message goes to it; with several, you pick one. The session takes it as its next turn. The message belongs only to the session you picked: another agent session reading the thread does not take it. When no session is running, the button says so and offers Reply instead.
- **When the session that asked has ended.** A reply goes to the session that asked. If the session asked through the Claude Code, Pi or OpenCode 2 connection and is no longer running (the Inbox has not heard from it for a minute), the thread says so before you reply: the message reads "session ended" and a note sits above the reply box. When you press **Send** and another session is running in the project, you choose where the reply goes: one of those sessions, or **Leave it for the next agent**. The button names your choice. **Esc** goes back to your reply. The session you pick is told that the reply was written to a session that ended, and to read the thread first. When no session is running, **Send** saves the reply in the thread until an agent reads it. Nothing is ever sent to another session unless you pick it. An agent connected through MCP alone (or OpenCode 1) is never called ended, because the Inbox cannot tell when it stops; your reply goes to it as before.
- **Files.** An agent can attach any file it can read, from the project or anywhere else on your computer (a screenshot in a temp folder, say), except `.env` files. Images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message, the way an email shows them, and as tiles. Markdown, text, HTML, Mermaid and Graphviz open beside the thread with Plannotator's viewers; source code, scripts and other text open in the code view with syntax highlighting. PDFs and every other file are a Download. Comment on documents as in Plannotator, on code by clicking a line or dragging across lines, and on an image by writing under it and, with **Mark up**, drawing on it (pen, arrow, circle): the agent gets the marked-up copy's path. The annotations ride your next Send. If the agent changes a file after it sent it, the Inbox says so and can still show the version it sent. A link in the message to a file it attached, such as `[the mock](mock.html)`, opens that file beside the thread; a link to a file it did not attach shows as plain text, and hovering it says "Not attached". When a thread has more than one file, the bar under the open file reads "3 of 5 · name": **‹** and **›** step through every file of the thread in order, and clicking the name lists them all. The keys are `]` and `[` (and `→` and `←` when nothing on screen uses the arrows); inside an HTML page they step while you are annotating, not in Interact. If a comment you typed is not saved yet, the Inbox asks before it moves on. Browser Back returns to the thread in one press.
- **Images.** An image in a message, `![alt](path)` or `<img src="path">`, shows when the file is in the message's project: a path relative to the folder the agent sent from (the project root for your own replies), or an absolute one inside the project. PNG, JPEG, GIF, WebP, SVG, AVIF, BMP and ICO up to 10 MB. Images from the web (`https://…`) do not load.
- **Replaced questions.** When your plans change (often in the agent's own session) while an earlier question still waits, the agent can replace it with a newer one, or say it no longer applies. The old card then reads **Replaced** (or **No longer applies**), names what replaced it with a link, and shows your pick on it marked **Not sent**; its options fold behind **Show the old options** and nothing on it can be answered. The newer card says what it replaces. A pick on a replaced question is never sent, and the thread's subject follows the new question when it came from the old one. If it happens while you are writing a reply, a note appears above the reply box, and **Send** stops once to say so: **Answer the new question** (your draft stays), **Send your words only**, or **Keep editing**.
- **Decisions.** A question can record your answer as a project decision. The switch on the card is on by default when the agent wrote `Decision: when answered`. The **Decisions** page lists what is waiting, what is settled, and what was replaced or retired.
- **Guided reviews.** An agent can send a guided review of a code change. It opens as sections, files and the diff, and you can tick sections as reviewed. Comment on the diff as in code review (click a line number, drag across lines, or select code): your comments ride your next Send under "Feedback on the guided review", with each file, line and the lines you commented on.
- **Notifications.** The open page can raise a browser notification when a new question arrives while the tab is in the background. The Inbox asks once, the first time something arrives. You can change this later in **Settings**.
- **Sound.** When an agent asks you something and no Inbox tab is in front, the page plays a soft doorbell, once per burst of questions (more questions within 30 seconds stay quiet). Plain messages never ring, and several Inbox tabs ring once. It works whether notifications are on or not, and while it is on, notifications arrive without a system sound so you never hear two. Browsers play sound only after one click in the tab, so until then the sidebar shows **Click to turn on sound**. Turn it off, change the volume or hear it in **Settings**, under Notifications. After the update that brings it, the Inbox says so once.
- **Settings.** The inbox tool switch per host, notifications and the sound, the MCP command for other agents, and how much space each project and thread takes on disk, with **Delete thread** and **Delete project**.

How to write questions is described in [Questions in Plans and Documents](/docs/guides/questions/). The Inbox reads the same `:::question` blocks.

## Connecting your agent

### Claude Code

With the Plannotator plugin and [the Plannotator mod](/docs/guides/claude-code/#the-plannotator-mod) (Claude Code 2.1.287 or newer), Claude Code gets a `plannotator_inbox` tool. The tool is on by default for Claude Code, also before you ever ran the Inbox: the first time Claude uses it, it starts the Inbox in the background. The tool is added when Claude Code starts, not when you start a new conversation in a running one, so restart Claude Code after you change the setting. When you send a reply, it arrives in that session as a new turn after Claude finishes what it is doing. The thread then shows "Delivered to Claude Code".

The mod is off in `claude -p`, in SDK runs and on Windows. There the tool is not added. Use the MCP server instead (see [Other agents](#other-agents)).

### Pi

Install the [Pi extension](/docs/getting-started/installation/#pi), then run `plannotator inbox`: it turns the inbox tool on for Pi when it finds the extension. The tool is off by default on Pi, because Pi sends every tool's full definition with each request. To turn it on yourself:

```bash
export PLANNOTATOR_INBOX_TOOL=1
```

Start a new Pi session (or `/reload`). A reply arrives as a follow-up message once Pi is idle, and Pi never interrupts a run for it. The thread shows "Delivered to Pi". The tool is inactive in print and JSON mode, because nothing could deliver a reply there.

### OpenCode

Add the [OpenCode plugin](/docs/getting-started/installation/#opencode), then run `plannotator inbox`: it turns the inbox tool on for OpenCode when it finds the plugin in your global opencode config. The tool is off by default on OpenCode, for the same reason as Pi. To turn it on yourself:

```bash
export PLANNOTATOR_INBOX_TOOL=1
```

Restart OpenCode. On OpenCode 2 a reply is queued into the session as its own turn once the session is idle, never mixed into a running turn, and the thread shows "Delivered to OpenCode". On OpenCode 1 the agent has the tool but is not woken. It reads replies with `read_thread` or `wait_for_reply`.

### The same session in two windows

You can open one Pi session twice (`pi -c` or `--session`), or run two OpenCode 2 servers on one database. Then only one process delivers a reply: the one you used last. On Pi, typing in a window or the agent calling the inbox tool there moves replies to that window. On OpenCode 2, only the agent calling the inbox tool moves them, because the plugin does not see what you type (checked on OpenCode 2.0.19). The process that holds replies checks in every 5 seconds. If it quits, another process takes over at once, and if it crashes, after about 20 seconds. A reply is delivered once either way.

## The inbox tool setting

The `plannotator_inbox` tool is one tool. Its actions are the Inbox's MCP tools (listed below). It files messages under the project of the agent's working folder; an agent working in another folder (a notes folder, say) can pass `project_path` to name the repository or folder the message is about. Pi and OpenCode add it only when both of these are true at session start:

- the Inbox is installed (you ran `plannotator inbox` once), and
- the inbox tool setting is on for that host.

Claude Code needs only the setting: before the Inbox was ever installed, the tool's first call starts it.

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

### The reminder at session start

Once you have run the Inbox on this computer, a session that has the tool also gets one line, so the agent knows when the Inbox is the right place:

> Plannotator Inbox is on: when you finish long work, or need a decision the person isn't here to give, send it with plannotator_inbox send_message and keep going. Their reply comes back here. Run `plannotator inbox --help` for how it works.

Where it goes:

- **Claude Code:** once, in the context of the conversation's first message. It names the tool by its full name (`mcp__…__plannotator_inbox`), so Claude can find it.
- **Pi:** once, as a hidden message with the session's first prompt.
- **OpenCode:** a line in the system prompt of every request. On OpenCode 1, and on an OpenCode 2 that cannot bring a reply back by itself, the sentence about the reply says to call `wait_for_reply` instead.

The text is fixed and never changes during a session, so it costs little and does not invalidate the prompt cache. It never appears without the tool. To turn it off, set `inboxReminder` in `~/.plannotator/config.json`: `false` for every host, or one per host, for example `{ "inboxReminder": { "claude-code": false } }`.

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

`plannotator inbox --help` prints a full guide for agents in markdown: when to use the Inbox, each tool and its arguments, how threads and replies work, the question syntax, and the setup line for each client above with your binary's path. An agent with no Plannotator skill can read it once and use the Inbox.

The stdio command fills in the project (its working folder) and a session id for the agent. When a Claude Code or Pi session runs it (a script or command the agent starts), that id is the session's own, so the message joins the session's thread and your reply reaches that session as with its tool. Otherwise the id lasts as long as the command's process; an agent that passes its own `agent_session` keeps its threads across restarts. Without one of the three connections, nothing wakes the agent when you reply. The agent calls `wait_for_reply`, which returns your reply as soon as you send it, or a cursor to wait again after 50 seconds.

### The tools

| Tool | What it does |
|------|--------------|
| `send_message` | Send you a message. It can carry `:::question` blocks and `attachments` (any file it can read, absolute or relative to the project; `.env` refused). `thread` names a thread to join, and `reply_to` answers one of your replies. `supersedes` (or a `Replaces: <message id>/<key>` line in a new question block) retires earlier questions of the thread, so you can no longer answer them |
| `read_thread` | Read one thread, or list the threads this session wrote in |
| `wait_for_reply` | Wait for your reply, up to 50 seconds per call |
| `resolve_message` | Resolve (archive) or reopen a thread |
| `list_decisions` | List the project's decisions: current by default, or replaced, retired or all |
| `record_decision` | Record a decision the agent made, with its reason |
| `get_guide_brief` | Get the brief for writing a guided review, with an example that works as it is |
| `submit_guide` | Send a guided review: a guide plus its patch, or a snapshot |

No tool answers, approves or sends anything for you.

## Over your tailnet

If you use [Tailscale](https://tailscale.com), you can open the Inbox from your phone, tablet or another computer on your tailnet:

```bash
plannotator inbox --tailscale
```

The command prints an address such as `https://studio.tail1234.ts.net:52817/`. Open it on your other device.

- **Only you can open it.** The Inbox lets in only the Tailscale login that owns this computer. Other people on your tailnet, and tagged devices, get "403". To let in another login (for example, your own login on a shared tailnet), add it to `~/.plannotator/config.json`: `{ "inboxTailscaleAllow": ["you@example.com"] }`.
- **Nothing is public.** The Inbox stays bound to `127.0.0.1`. Tailscale's `tailscale serve` gives the address HTTPS inside your tailnet. The Inbox never uses `tailscale funnel`.
- **Agents stay local, but your answers reach them.** MCP and the agent connections answer only on this computer. A reply, and above all a **New message**, becomes a turn in a live agent session on this computer. So anyone who can open the address can drive agents that run commands here: any login in `inboxTailscaleAllow`, and anyone holding your unlocked phone while it is signed in to Tailscale. Allow only logins you would let use this computer.

`--tailscale` publishes until the Inbox stops. To publish at every start, also when an agent starts the Inbox, turn on **Over your tailnet** in **Settings**. You can also set `PLANNOTATOR_INBOX_TAILSCALE=1`, or put `{ "inboxTailscale": true }` in `~/.plannotator/config.json`. When the environment variable is set, it decides and the switch is disabled. `PLANNOTATOR_INBOX_TAILSCALE=0` keeps it off, even with `--tailscale`. You can turn the switch on only from this computer.

The address uses the Inbox's own port. The Inbox removes it when it stops or restarts. If Tailscale is not installed, stopped or signed out, the Inbox still runs on this computer. **Settings** shows the reason.

If the Inbox is killed (for example by `kill -9`, the system running out of memory, or a restart of the computer), the address stays in Tailscale and points at a port nothing uses any more. Until the Inbox starts again, a different program that takes that port is reachable from your tailnet. The Inbox removes the old address first thing at its next start. To remove it at once, run `tailscale serve --https=<port> off`, or `plannotator uninstall --purge`. `review --tailscale` and `annotate --tailscale` sessions have the same window.

While the Inbox is published, closing the terminal it runs in stops it, even under `nohup`. Use `plannotator inbox --background --tailscale` to keep it running.

If you published the Inbox yourself with `tailscale serve --https=<port> http://127.0.0.1:<port>`, that mapping gives everyone on your tailnet the whole Inbox, including its agent tools. The Inbox now refuses every request that comes through it. **Settings** names the mapping and offers to replace it with the owner-only address.

Browsers allow notifications per address. Each device asks once.

The Inbox's MCP address (`/mcp`) now answers only when the request names `127.0.0.1` or `localhost` with the Inbox's own port. An `ssh -L` forward to a different local port is refused. Forward the same port number, or run `plannotator inbox mcp` on the Inbox's computer.

## Data on disk

Everything lives under `~/.plannotator/inbox/` (or `$PLANNOTATOR_DATA_DIR/inbox/`):

| Path | What it holds |
|------|---------------|
| `inbox.json` | The registry: port, URL, version, process id, and a token that changes at every start. Owner-only |
| `inbox.log` | The output of an Inbox started with `--background` |
| `projects/<name>-<hash>/` | One folder per project: `project.json`, plus `messages.jsonl`, `questions.jsonl`, `decisions.jsonl` and `annotations.jsonl`, which grow by appending lines |
| `blobs/<sha256>` | The version of each attached file as it was sent, and each guided review |
| `markups/<sha256>.png` | The images you marked up when commenting on an image attachment |
| `seq.json` | The highest event number ever written, kept across deletions |
| `agents.json` | The agents `plannotator inbox` found or connected, so it never adds one back that you turned off |
| `claims/`, `leases/` and `connection-tools.json` | Bookkeeping for the Pi and OpenCode connections |

The Inbox stores the files agents attached as they were when sent, the messages and your replies. It sets no size limits. To free space, use **Delete thread** or **Delete project** in **Settings**, which also remove sent files that nothing else uses. Your choices for the inbox tool, notifications and the tailnet are kept in `~/.plannotator/config.json` (`inboxTool`, `inboxReminder`, `inboxNotifications`, `inboxSound`, `inboxTailscale`, `inboxTailscaleAllow`).

## Uninstall

`plannotator uninstall` keeps your Inbox data. To remove it too:

```bash
plannotator uninstall --purge
```

Both forms remove the `plannotator-inbox` entries `plannotator inbox` added to your agents (an entry you changed to run something else is left, and named). `--purge` also stops a running Inbox first, then deletes `~/.plannotator/inbox/` with the rest of the Plannotator data. If the Inbox does not stop, uninstall still removes the plugins, skills, hooks and config entries, but keeps your Plannotator data (`~/.plannotator`) and the `plannotator` binary. Quit the Inbox and run the command again to finish. Add `--dry-run` to see what would be removed.

## Troubleshooting

### The agent has no plannotator_inbox tool

- On Pi and OpenCode, run `plannotator inbox` once, then restart OpenCode or start a new Pi session. A session that started before the Inbox was installed does not get the tool. Claude Code gets the tool without that step, but a Claude Code process that started before you changed the setting needs a restart.
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

### Update

When a newer Plannotator release is out, the sidebar shows an **Update** button above **Settings**. The machine checks GitHub once a day (never your browser); turn this off in **Settings → About** ("Tell me when a new version is out"), with `{ "updateCheck": false }` in `~/.plannotator/config.json`, or `PLANNOTATOR_UPDATE_CHECK=0`.

Click **Update** to see what's new and what will happen, then **Update now**: the install script runs for that version with the choices from your last install, the button reads **Updating…**, and when the new binary is in, the Inbox restarts on it and the page reloads. Open reviews keep running on the old version until you finish them. **Remind me tomorrow** hides the button for that version for a day. Tick **Install new versions automatically** to let Plannotator do this by itself from then on.

If the binary was already updated (by auto-update, `plannotator update`, or the install script), the button restarts the Inbox at once; if you are typing a reply, it asks first. If an update you started fails, the button reads **Update failed** and shows the exit code and the log. After an update, **What's new in X** sits above Settings for that run.

A copy of Plannotator that the install script did not install cannot update itself: the dialog shows the command to run instead.

### The Inbox does not start

Read `~/.plannotator/inbox/inbox.log`. If another Inbox is already running but not answering (paused or blocked), callers wait up to 20 seconds for it and then report an error rather than start a second one. Stop the stuck process and run `plannotator inbox` again.

### I work over SSH or in a container

The Inbox binds only `127.0.0.1` and ignores `PLANNOTATOR_REMOTE` and `PLANNOTATOR_PORT`. Run it on the machine where you work. To open it from another device, publish it [over your tailnet](#over-your-tailnet).

### The tailnet address answers 403

The Inbox lets in only the Tailscale login that owns the computer it runs on. Open the address on a device signed in with that login, or add your login to `inboxTailscaleAllow` in `~/.plannotator/config.json`. A tagged machine has no owner, so it publishes only after `inboxTailscaleAllow` names a login.
