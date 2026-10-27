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
| `plannotator inbox --open` | Open it in the browser and print its URL, starting it in the background first if it is not running. It returns at once. Over SSH it opens no browser on the remote machine and says how to reach the Inbox |
| `plannotator inbox --tailscale` | Also publish it [over your tailnet](#over-your-tailnet) until it stops. Works with the forms above. If the Inbox is already running, it is asked to publish |
| `plannotator inbox mcp` | The stdio MCP server for agents. It starts a stopped Inbox without opening a browser tab |

Run `plannotator inbox` once before you connect an agent. That first run writes the Inbox's registry file, and the connections look for that file when a session starts.

You never need to keep the Inbox running yourself. When an agent calls it and it is stopped, it starts in the background, and no tab opens.

### Closed the tab?

Type `/plannotator-inbox` in your agent (Claude Code, OpenCode, Pi, Gemini CLI, Kiro, Mistral Vibe, Droid; `$plannotator-inbox` in Codex; in Amp, **Plannotator: Open Inbox** in the command palette). It opens the Inbox in your browser, starting it if needed, and shows its address. You can also ask your agent where your Inbox is, or run `plannotator inbox --open` in a terminal. Over SSH it opens no browser on the remote machine: it shows the address and how to reach it (forward the port with `ssh -L`, or use `--tailscale`).

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
| Cursor | Cursor User Rules in Settings → Rules (manual copy; no supported global rules file) |

Managed notes sit between two marker lines at the end of the file. Plannotator never overwrites a note you edited, and removing it removes only that section. `plannotator inbox --notes codex,gemini` adds managed notes from the terminal (the agent install prompt runs this only after you say yes). For Cursor, `plannotator inbox --notes cursor` prints the note to copy into Cursor Settings → Rules. Plannotator cannot detect whether it was pasted, update it or remove it; a copied Cursor rule is never shown as installed. `plannotator inbox --help` lists exact files and manual steps.

### Settings → Agents

Settings lists each agent found on this computer with up to three switches: **Reaches the Inbox** (its MCP entry, or the inbox tool for Claude Code, Pi and OpenCode), **Reminder at session start** (Claude Code, Pi and OpenCode: one line at the start of each session that has the inbox tool) and **Note in its instructions**. Cursor's note is a manual Show note workflow, not a managed switch; copy it into Settings → Rules. Plannotator cannot detect, update or remove that copy. Managed note changes apply to that agent's next session. An agent you turn off here is never connected again by `plannotator inbox`. Agents not found are folded under **Not found on this computer**, with the command or one-click link for each, editors included.

## What you see

- **The list.** One row per thread, in sections: Stopped on you, Holding up work, Waiting on you, New since you looked, Sent, and Quiet (folded). Sent waits on the agent, not on you, so it sits below what is new. A row shows the project, the agent, the subject and how many questions wait. New agent activity does not reorder the rows under you. It waits behind "N new in <project>" until you act. Nothing you do in an open thread reorders the list either: the list catches up when you leave the thread.
- **Search.** Click **Search** at the top of the sidebar (on a phone, the search icon in the list header) and type a few words. Results come in groups: **Threads** (subject, thread name or project), **Messages** (agent messages, the questions in them and your answers, and your own replies), **Files** (attachment names and guided reviews) and **Projects**. The words you typed show in bold. Every word must match; the last one can be the start of a word (`rate lim` finds "rate limit"). Accents and case do not matter (`resume` finds "résumé"), and Chinese, Japanese, Arabic and Hebrew work as written. Better matches come first: the exact phrase, then all whole words, then a prefix; an open thread comes before an archived one of the same quality, which is labelled **Archived**; the project you are viewing breaks ties. Use **↑** and **↓** to move, **Enter** to open, and **⌘Enter** (or **Ctrl+Enter**) to open in a new tab; **Esc** closes. Opening a message takes you to it in its thread, unfolded, with your words highlighted until you click or type. **Back** returns to where you were. The chips under the box narrow the search by **Project**, **Status** (Waiting on you, New since you looked, Sent, Quiet, Archived) and **From** (Agents or Me). With no words, a chip lists the matching threads, newest first. With an empty box you see the threads you looked at last and your last six searches (a search is remembered only when you open one of its results; **Clear** forgets them). Press **⌘K** on a Mac (**Ctrl+K** elsewhere) to open search from anywhere in the window, even while typing a reply; it is the Inbox's one keyboard shortcut. Attachment contents are not searched, only their names. Identifiers with letters (commit hashes, ULIDs, UUIDs) are found by their whole value or by their first 7 characters or more, like a short SHA (`9fceb02` finds `9fceb02d0ae5…`); numbers such as timestamps only by their whole value. Search is in this window only, not in the phone app. Agents can search messages too, read-only (the `search` tool below); their searches never show up in your recent searches.
- **Projects.** The sidebar lists each project an agent wrote from: the repository, or the folder when there is none. An agent working in a git worktree of a repository (`git worktree add`, or a Claude Code agent's own worktree) writes into that repository's project, not a project of its own; images and files it names relative to the worktree still open. Click a project to see only its threads.
- **Pinned threads.** Right-click a thread and choose **Pin thread** (the first item), or press the pin in a thread's header (the way to pin on a phone). The thread appears under **Pinned** in the sidebar, above Projects, and stays there in the order you pinned until you unpin it, while it also stays in its place in the list with a small pin after its subject. A pinned row shows the agent's mark, the subject, and what waits on you, as a project shows its count: **Stopped** or **Holds N** in the badges' colours, the number of open questions, or a dot when there is news; a thread where nothing waits on you is drawn quieter. Click it to open the thread; the list stays on the project you were viewing. Hover it and click **⋯** (or right-click it) for **Unpin**, **Move up**, **Move down** and **Copy link**. **Undo** in the Unpinned toast, or `Z`, puts the pin back where it was. An archived thread stays pinned, shown with the archive mark, and opens as an archived thread; a deleted thread leaves Pinned. There is no limit on pins; a long Pinned section scrolls with the projects. Pinning changes nothing about the thread: not its section, its counts or its notifications, and agents never see pins. On a phone, **⋯** is always on each pinned row in the navigation sheet. With nothing pinned there is no Pinned section at all.
- **Copy prompt.** The pill with the agents' marks just above **Settings** in the sidebar. One click copies a short prompt to paste into any agent on this computer (Codex, Cursor, a new Claude Code session, any other). The prompt names the full path of your `plannotator` and tells the agent to read `plannotator inbox --help`, connect itself, and send you a first message offering to send some real recent work. The pill reads **Copied** for two seconds.
- **A thread.** It reads like email. Questions render as cards, and a click saves your pick at once. **Send** carries your picks, your words and your annotations as one reply to each agent session, even when your picks are on several of its messages. **Mod+Enter** sends. A Send never skips a question on its own: the questions you did not answer stay open, and the reply tells the agent how many and not to ask again, because you will answer in the Inbox. The reply box says how many stay open before you send; **Skip them** skips exactly those for that Send (a question that arrives after you press it stays open), and **Skip** on a card skips one. After a Send the line under your reply says where it is. For Claude Code, Pi or OpenCode 2 it reads "Queued · <agent> is working; it gets this when its turn ends" while the agent works, with **Send now** to put it into the running turn (the agent reads it at its next step instead of after the turn), and "Sending to <agent>…" while the session is idle. For an agent that only reads the thread it reads "Saved for <agent>. It sees it when it next reads this thread". Then "Delivered to <agent>, <time>". Messages you already read fold to one line (click one to open it, or **Expand all**), and a thread opens at **New since you looked**; `j` and `k` move between messages and `n` jumps to the first new one.
- **Issue, pull request and merge request cards.** Rest the pointer on a `#123` or a pasted GitHub or GitLab link in a message (or Tab to it) and a card shows what it is: the title, Open / Draft / Merged / Closed, the author, the branch and size of a change, its checks or pipeline and review state, the labels, the description and the latest comment. A click in the card keeps it open so you can scroll; **Esc** closes it. **Open on GitHub** (or GitLab) takes you there. On a phone, a tap on the link shows the card from the bottom of the screen. The details come from your own `gh` or `glab`, so private repos work with whichever signed-in account can see them, and only github.com, gitlab.com and the hosts your CLI is signed in to are ever asked. Nothing is asked until you hover, and a link in the description asks before it opens. Over your tailnet the cards work on your own page; a paired phone's app never gets them.
- **Drafts of your replies.** What you type in a thread's reply box is kept as you type, as a draft of that thread. Leave the thread, open another, reload the page or restart the Inbox, and the words are back in the box when you return (the box opens without taking the cursor). Above the box a **Draft** pill says when it was saved, with **Discard** beside it; **Cancel** keeps the words, and the **Send** that carries them clears them. Anything you have not sent says **Draft** where it used to say "Not sent": a question card you picked ("Picked 4:35 PM · in your draft"), the foot of the thread ("Draft · 2 picks", with **Send** and **Edit draft**), and the list row ("Draft · Your reply", "Draft · 1 pick", "Draft · Your reply, 1 comment"). A thread holding a draft, a pick not sent or a comment not sent never sinks to Quiet: it stays in **New since you looked** (not bold, since nothing new arrived) until you send or discard it, unless you archive it. A thread waiting on a **Re-ask** stays in **Sent**, still marked Draft. The sidebar's **Drafts** counts these threads too, and its page lists them under **Replies not sent** above the messages you started. Drafts never reach an agent, a phone's notifications or search; files you paste into the reply box are not kept in the draft.
- **Mark read.** To get a thread out of the top without answering it, press **Mark read** in the thread's header (or `E`, or the button that shows when you hover a row). The thread moves to Quiet, marked "Read", and its unanswered questions close. A few seconds later the agent that asked gets one note from you: "Set aside for now; don't wait on these:" and the questions. The thread comes back to the top when the agent writes again. **Undo** in the toast, or `Z`, reopens the questions that Mark read closed, as they were; the pressed **Read** button does the same later. Questions an earlier Mark read closed stay closed. If an agent was stopped on the thread, the toast says so and offers **Reply**. A toast goes by itself after a few seconds; to close it sooner, press its **×** or swipe it sideways. Closing it never undoes anything, and once it is closed its Undo (and `Z`) is gone.
- **Archive.** The archive icon in the thread's header ends the thread: its questions close, and the agent's next message starts a new thread. **Unarchive** in the thread's foot reopens it. (Agents call this `resolve_message`.)
- **A whole project at once.** Hover a project in the sidebar and click **⋯** (or right-click the project) for **Mark all as read** and **Archive all**. Mark all as read does Mark read on every thread in the project that waits on you; each agent gets its own note, as above. Archive all archives every thread of the project still in your list. Neither asks first: **Undo** in the toast, or `Z`, puts back the whole batch, and the toast warns you when an agent was stopped or work was held up. On a phone, **⋯** is always on each project in the navigation sheet. A project with nothing left in your list leaves the sidebar on its own, and comes back when an agent writes there again; while you are viewing it, it stays until you go elsewhere. Its archived threads are in **Settings → Archived**, and search still finds it.
- **👍 Looks good.** Next to Reply, **👍 Looks good** says "cool, looks good" in one click. The thread moves to Quiet, marked "👍 Looks good", and comes back when the agent writes again. A few seconds later the 👍 is sent to the agent that wrote the message: a Claude Code, Pi or OpenCode 2 session gets one short message ("The person marked your message 👍 Looks good. No reply needed unless you have a question."), and an agent waiting with `wait_for_reply` is told you acknowledged it. The line under the message says where it is: queued for the agent, then "Delivered to <agent>" with the time. **Undo** in the toast, or `Z`, takes it back before it is sent (the agent never hears of it); clicking the pressed button takes it back later, and stops it if it has not been delivered yet. **Move back** (or `E`) on the thread takes it back too. The button is hidden while a question in the thread is waiting on you (answer it instead, or Mark read) and after you replied (your reply is the answer). To say more than "looks good", Reply.
- **Write to an agent first.** The pencil beside **Search** (on a phone, in the list header), or **New message…** in the **⌘K** search box, opens a message to a running agent session in any project: an idea or a request of your own. **To** is filled with the session you wrote to last while it is running, else one in the project you are looking at; click it to pick another (each session shows its project, when it started, what it last wrote and whether it is working). Type in the search box an agent or a project ("pi billing") for **Message Pi in billing**. **⌘Enter** sends. The message starts a new thread, named by a short first sentence of what you wrote ("I want to explore what adding a board would look like"), not your whole first paragraph. Its name, the chip it shows in the list, sits right under **To**: it fills itself with a short name from what you write ("Kanban board", "Paste bug") until you type in it; then it is yours and stays as you typed it. Empty it to have it named from your message again. A name you typed that another open thread of the project already has is refused when you send, so the two never mix. A name you left as suggested is a placeholder: the agent renames the thread on its first reply, once. The agent is told it is your own idea, not an answer, and to say how it will handle it; its answer comes back in that thread. Attach any file with the paperclip, by dropping it or by pasting it (a screenshot pastes as `pasted-image-<date>-<time>.png`; not `.env` files; up to 100 MB each): the agent gets a real copy to open. A reply takes pasted images and files too: paste them while the reply box has focus. When no agent is running, nothing can be sent: save it as a draft. Closing a message with words in it asks **Keep draft** or **Discard**. Drafts wait under **Drafts** in the sidebar (shown only while there are some), each saying whether the session it was for is running, has ended, or was never chosen; a draft never sends itself, and one for a session that ended keeps it until you pick another. If the session stops before it takes your message, the thread says **Not delivered** and offers **Send to another session** (a session that is resumed still gets it).
- **Skills in your replies.** Type `/` or `$` at the start of a word in the reply box, in a message you start, or in a comment on an attached file, and pick one of the skills installed on this computer (`~/.claude/skills`, `$CODEX_HOME/skills`, `~/.agents/skills`), as in a Plannotator comment. Use the arrow keys and **Enter**, or click a row; **Esc** closes the list. The agent is asked to use the skills you name. A skill an agent cannot start by itself (`disable-model-invocation: true` in its SKILL.md) is underlined, and the box says "Includes skill instructions": when you send, its SKILL.md is added at the end of your message, with its folder, so the agent can follow it. In the thread that text is folded behind one line, **Skills: …**; click **Show** to see exactly what the agent got. Agents cannot add skill instructions to their own messages.
- **Tag other agents.** Type `@` at the start of a word in the reply box and pick a running agent session: the list shows every session in every project, grouped by agent, the one the reply goes to anyway first (**Owns this thread**), and last the agents that only read the Inbox through MCP (Cursor and others, marked **Not woken**; a Codex thread that used the Inbox in the last hour is a running session, and is woken). Type to narrow it, use the arrow keys and **Enter**, or click; **Esc** closes it. The tag reads `@Pi` in your text. Under the box, **Goes to** names everyone the reply goes to, and a note says what each tag means: a session that does not own the thread gets your reply and a pointer to the thread; an agent that reads through MCP cannot be woken and sees your reply the next time it reads the thread. A second session of the same agent reads "Claude Code (another session)", or "Claude Code (plannotator)" when it works in another project. A session on an older Plannotator says **Update Plannotator to tag this session** and cannot be picked. The thread's own agent always gets the reply too, told who else you tagged; each tagged agent is told whose thread it is, to read it first and answer only its part, in the same thread (from any project). Under your sent reply there is one line per agent, each with its own state and **Send now**, and the row in the list reads like "1 of 3 delivered · Pi queued". You can tag an agent in a comment on a Markdown, text or HTML file too: the whole reply goes to it with your next Send, and the comment is marked as the one that tagged it. Your next reply without a tag goes to the agent that wrote last. Agents do not tag each other.
- **When the session that asked has ended.** A reply goes to the session that asked. If the session asked through the Claude Code, Pi or OpenCode 2 connection and is no longer running (the Inbox has not heard from it for a minute), the thread says so before you reply: the message reads "session ended" and a note sits above the reply box. When you press **Send** and another session is running in the project, you choose where the reply goes: one of those sessions, or **Leave it for the next agent**. The button names your choice. **Esc** goes back to your reply. The session you pick is told that the reply was written to a session that ended, and to read the thread first. When no session is running, **Send** saves the reply in the thread until an agent reads it. Nothing is ever sent to another session unless you pick it. An agent connected through MCP alone (or OpenCode 1) is never called ended, because the Inbox cannot tell when it stops; your reply goes to it as before.
- **Files.** An agent can attach any file it can read, from the project or anywhere else on your computer (a screenshot in a temp folder, say), except `.env` files. Images (PNG, JPEG, GIF, WebP, SVG, AVIF, BMP, ICO) show in the message, the way an email shows them, and as tiles. Markdown, text, HTML, Mermaid and Graphviz open beside the thread with Plannotator's viewers; source code, scripts and other text open in the code view with syntax highlighting. Videos (MP4, MOV and WebM) play in the window: the tile reads "MP4 video · 7:41 · 1920 × 1080" with **Play**. Pause at a moment and type under the film: typing pauses it and pins the moment, and **Comment** saves your words at that time with the paused frame (draw on the frame first with **Mark up**). Each comment is a dot on the line under the player and a card with its time in the comments panel; click either to jump back to that moment. The agent gets each comment as `At 1:42 (102.4 s of 7:41)` with the frame's path, so it can look at the moment it cannot watch. A video your browser cannot play (HEVC in some browsers, WebM in Safari) shows **Download** instead. PDFs and every other file are a Download. Comment on documents as in Plannotator, on code by clicking a line or dragging across lines, and on an image by writing under it and, with **Mark up**, drawing on it (pen, arrow, circle): the agent gets the marked-up copy's path. The annotations ride your next Send. If the agent changes a file after it sent it, the Inbox says so and can still show the version it sent. A link in the message to a file it attached, such as `[the mock](mock.html)`, opens that file beside the thread; a link to a file it did not attach shows as plain text, and hovering it says "Not attached". Links inside an attached HTML page work too: click one (hold `Cmd`, or `Ctrl` on Windows and Linux, to comment on the link instead; on a phone, tap to follow and press and hold to comment). Another attached file opens in the viewer; another page in the same folder opens read-only, with **Back** (comments are off on it, since only attached files take them); an image beside the page opens in a lightbox; another site opens a new tab; anything else says why it does not open. Browser Back, Esc and the page's **Back** step back one page. When a thread has more than one file, the bar under the open file reads "3 of 9 · name": **‹** and **›** step through everything the thread shows, in reading order: in each message, the images in its text, then its attached files. Clicking the name (or pressing Enter or ↓ on it) opens the peek, a picture list above the bar with one row per message, the open file ringed; use the arrow keys, Home and End to move, Enter to open, Esc to close. On a phone a file is always full screen, and you step in three ways: the toolbar's pill (`4/9 ⌄`) opens the same list as a sheet, with **‹ Previous** and **Next ›** above the files; a sideways swipe over the file steps to the previous or next one (past a third of the width, or a quick flick; a shorter swipe springs back, and at the first or last file it says "Last file in this thread"); and an image you have not zoomed takes the same swipe. The swipe works on documents, text, code, PDFs and download cards. HTML pages, diagrams and videos keep every touch for themselves, so step those with **Previous** and **Next** in the sheet. A wide code line or table scrolls sideways first, and steps once it reaches its edge. A swipe that starts up or down scrolls the file as usual. The keys are `]` and `[` (and `→` and `←` when nothing on screen uses the arrows); inside an HTML page they step while you are annotating, not in Interact. If a comment you typed is not saved yet, the Inbox asks before it moves on. Browser Back returns to the thread in one press.
- **Artifacts.** A thread with files has an **Artifacts** button at the top right (three small shapes and a count), beside the other icons: Expand all, Archive and the close; hover any of them to see what it does. It swaps the messages for one grid of every artifact in the thread, newest message first: every file an agent attached (PDFs and downloads too), the images shown in a message's text (marked "in text"), guided reviews, and files you pasted into your own replies. Each tile shows a preview (the image, a video's first frame and length, the first lines of a document or code file, the diagram, the HTML page), the name, the kind and size, who sent it and when, "Changed since sent" if the file changed on disk, and how many comments wait on it. Click a tile to open it exactly as its tile in the message opens it; the grid stays beside the file with that file ringed, so the next one is one click away. A guided review opens its reader, and its Back returns to the grid. **Back to the thread**, the Artifacts button again or Esc return to the messages. The address keeps the view (`&artifacts`), so a reload or a shared link opens it. On a phone it is a screen of its own, two tiles across, with **‹ Thread** to go back. The viewer's own **‹ ›** and peek still step through the files in reading order; they leave guided reviews out, so the viewer's count is less than the button's by the number of guided reviews in the thread.
- **Full screen.** **Full screen** in an open file's header gives the file the whole window, with one small toolbar in the top right corner (bottom right on a phone): the pen (HTML pages: Annotate or Interact), the comment count, which opens your comments with **Write the reply**, the position, which opens the list of the thread's files, **⋯**, **Side by side**, **×** and **»**, which tucks the toolbar into the corner. **Side by side** puts the file back beside the thread and makes that the way files open; **×** (or **Esc**) puts it back without changing that. **Esc** first closes whatever is open (a menu, a comment, the comments, Annotate on an HTML page), then leaves full screen. On a phone **‹** goes back to the thread. On an HTML page **⌘⇧X** (**Ctrl+Shift+X**) hides or shows the toolbar. Until you choose, an HTML page opens full screen and other files open beside the thread.
- **Open in.** The **Open** button in an open file's header opens the file in its own app, and its arrow lists the choices: **Browser** for an HTML page (a new tab, served from the page's own folder in the same sandbox the Inbox draws it in), the editors on your computer (VS Code, Cursor, Zed and others) for documents, code and config, **Default app** for images, PDFs and videos (and for `md`, `txt`, `json`, `yaml`, `toml` and `log` files on macOS and Windows), **Finder** (Explorer on Windows) to show the file in its folder, and **Copy path**. The app you pick is remembered, the same one code review uses. Each attachment tile has a **⋯** menu with the same list. Other files, such as archives and programs, only offer Finder and Copy path: the Inbox never runs a file. Apps open the file as it is now on disk; if it is gone, the apps are greyed out and Copy path still works. On a phone, or in a window opened over your tailnet, there is only an **Open in new tab** button, for HTML pages and images: apps open only from this computer's own window.
- **Images.** An image in a message, `![alt](path)` or `<img src="path">`, shows from anywhere on your computer, as attached files do: a path relative to the folder the agent sent from (the project root for your own replies), or an absolute one such as a screenshot in `/tmp`. PNG, JPEG, GIF, WebP, SVG, AVIF, BMP and ICO up to 10 MB and 50 megapixels. Not shown: a `.env`-named file; anything in a hidden folder (such as `~/.ssh`) outside the project and the folder the agent sent from, followed through symlinks (hidden folders inside the project, such as `.walkthrough/`, do show, unless the project is your home folder itself or a folder above it); and images from the web (`https://…` or `//host/…`). Your own replies show images from the project only, wherever they are sent from (this window, a phone, another device on your tailnet). When an agent sends a message with an image that will not show, the Inbox tells the agent which one and why (missing files are reported as "not written yet", files the system will not let Plannotator read as unreadable), so it can copy or attach the file instead. Click an image in a message (or press Enter on it) to open it full screen in the same viewer as attached files, with the comment box, **Mark up** and **Actual size**; your comments ride the next Send, named by the image's path and the message it was in. The Inbox keeps a copy of each image when the message arrives (for a message from before this, the first time you open its thread), so if the agent overwrites the file later it says so and can still show the version it sent.
- **Comments on a message.** Select words in an agent's message and the same small toolbar as on an attached file appears: **Comment** opens a comment box (**Mod+Enter** saves it, or **Enter** with **Enter saves a comment** on in Plannotator's Settings → General; an Inbox tab already open picks up a change after a reload. The reply box is not a comment box: Enter there stays a new line), and 👍 marks the words "Looks good" in one click. The words keep a light highlight, the comment waits in the reply box's annotations chip with your file comments (edit or remove it there until you send), and it rides your next **Send**. It goes to the session that wrote that message, under "Feedback on your message from 2:58 PM" with the message's id: the words you selected (as shown on screen), quoted, then your comment. Your own messages and the words of a question card take no comments. **Esc** closes the toolbar.
- **Replaced questions.** When your plans change (often in the agent's own session) while an earlier question still waits, the agent can replace it with a newer one, or say it no longer applies. The old card then reads **Replaced** (or **No longer applies**), names what replaced it with a link, and shows your pick on it marked **Not sent**; its options fold behind **Show the old options** and nothing on it can be answered. The newer card says what it replaces. A pick on a replaced question is never sent, and the thread's subject follows the new question when it came from the old one. If it happens while you are writing a reply, a note appears above the reply box, and **Send** stops once to say so: **Answer the new question** (your draft stays), **Send your words only**, or **Keep editing**.
- **Re-ask.** When a question has gone stale, or questions pile up across several messages, open the **open questions** list at the foot of the thread and choose **Re-ask in one new message** at its end. It is there whenever a question or action item waits on you that you have not picked, even just one. The agent that asked gets a note asking it to ask its open questions and action items again, together in one new message with fresh context, and to drop any that no longer apply. Picks you made but had not sent go with the note as answers. The thread shows your note on one line ("You asked Claude Code to ask the 3 open questions again…") and moves to **Sent** until the agent asks again; the old cards stay open until its new message replaces them (they then read **Replaced** or **No longer applies**). If the session that asked has ended, you pick a live session to ask again, as when you reply. When several agents asked, each gets its own note.
- **Action items.** When an agent is stuck on something only you can do outside the chat (approve a deploy, sign in, touch a security key, merge a pull request it cannot merge), its message carries a **Action item** card: what to do, why, where (an **Open** button for a link, or a command with **Copy**), and, when the agent will notice it happen, what it is watching. An action item counts like a question: it puts the thread under **Stopped on you** (or **Holding up work**, or **Waiting on you**), it notifies and rings like one, and the row reads "1 action item" (or "1 question, 1 action item"). Press **Done** when you did it (**Add note** first to say more), or **Can't do it…** and say why: it goes to the agent right away, with a few seconds to **Undo** (the toast, `Z`, or the card's own Undo), as 👍 Looks good does. The agent gets it in your reply under "Action items you asked for" ("Done, 3:12 PM." with your note, or "Can't do it: " and your reason). When the agent sees it happen by itself (the deploy it was watching is Ready), it can close the card itself: the card then reads "<agent> saw it done", and nothing is sent. **Mark read** sets an open action item aside like a question.
- **Guided reviews.** An agent can send a guided review of a code change. It opens as sections, files and the diff, and you can tick sections as reviewed. **Split | Unified**, in the small tab on top of the first section, draws the diffs side by side or in one column; it is the same setting as code review's, so a choice in either holds in the other. On a phone the diffs are always in one column. Comment on the diff as in code review (click a line number, drag across lines, or select code): your comments ride your next Send under "Feedback on the guided review", with each file, line and the lines you commented on.
- **Notifications.** The open page raises a browser notification for every new thread an agent starts, and for every new question unless it is in the thread you have open on screen, even while the Inbox tab is in front. Plain messages in a thread you already have do not notify. Until you allow or decline them, a line above the list asks. **Settings** shows whether they are on for this address, sends a test notification, and says whether any open Inbox tab can notify you.
- **Sound.** When an agent asks you something and no Inbox tab is in front, the page plays a soft doorbell, once per burst of questions (more questions within 30 seconds stay quiet). Plain messages never ring, and several Inbox tabs ring once. It works whether notifications are on or not, and while it is on, a notification about a question that rings it arrives without a system sound, so you never hear two. Browsers play sound only after one click in the tab; the first click anywhere turns it on. Turn it off, change the volume or hear it in **Settings**, under Notifications. After the update that brings it, the Inbox says so once.
- **Settings.** Appearance (light, dark or match the system; the text size; and the colors, a palette for the light half and one for the dark half, the same choices and the same setting as plan review's Theme tab), the inbox tool switch per host, notifications and the sound, the MCP command for other agents, and how much space each project and thread takes on disk, with **Delete thread** and **Delete project**.

How to write questions is described in [Questions in Plans and Documents](/docs/guides/questions/). The Inbox reads the same `:::question` blocks.

In the Inbox a question block can carry two more lines, each on its own line after the question. `Stopped: <why>` says the agent cannot go on until you answer: the thread goes first, under **Stopped on you**. `Holds up: <work>; <work>` names the work that waits while the agent goes on: the thread shows under **Holding up work**, unless a question also says `Stopped:`, which wins.

```markdown
:::question
Which database password should I use for staging?

Stopped: can't run the migration without it
Holds up: staging deploy; release notes

- [ ] The one in 1Password "staging-db"
- [ ] Make a new one
:::
```

Agents are told to write `Stopped:` only when they truly cannot continue. A negative value (`no`, `none`, `n/a`, a dash) means no stop, so `Stopped: no` is read as if the line were not there, and a `Holds up:` entry `none` holds nothing up. `plannotator inbox --help` and the `send_message` tool's `body` field teach agents both lines.

An action item is an Inbox-only `:::action` block. Its first line is what to do; the other lines say why, except these: `Where:` (a link becomes an **Open** button, or a place in words), `Run:` (a command to copy), `Stopped:` and `Holds up:` (as for questions), and `Watching:` (what the agent watches to notice it done by itself).

```markdown
:::action
Approve the production deploy on Vercel
The 4.2 build passed every check and waits under "Promote to Production". Nothing else needs changing.

Where: https://vercel.com/acme/web/deployments
Stopped: release 4.2 cannot go out until it is approved
Watching: the deployment; I go on by myself once it is Ready
:::
```

Agents are told to write an action item only for a true blocker: something you must go and do outside the conversation, that they cannot do themselves. Never for a decision or a question (that is a `:::question`), for anything the agent can do, or as a checklist or a status update. `plannotator inbox --help` and the `send_message` tool's `body` field teach it, and its `done` field lets the agent close an action item it saw happen.

## The Board

The Board shows work in flight, by stage, as cards: one card per piece of work that outlasts the message it was asked in (a feature started, a pull request opened, "I'll send you the numbers"). Agents keep their cards current; you move them too.

**It is off until you turn it on**, in **Settings → Capabilities → Board** (or with **Turn it on** on the Board's own page). Off, there is no Board in the sidebar, and agents are not offered cards. On, agents get the `card` action from their next session: a session already running keeps the tools it started with (it can still use `plannotator card` in its shell). Turning it off again keeps every card: an agent that still tries gets "the Board is off" and nothing is written, and turning it back on shows the cards as they were. The switch changes nothing else in the Inbox.

- **The lanes.** **Backlog** (work asked for and not started, or a card you wrote), **Designing**, **Your look**, **Building** and **Your review**. In Your look and Your review a card says what you owe ("You: approve the copy"). A card shows the agent, the title, the agent's last word and how long ago it heard. A card with a pull request or issue shows its state as a small icon in GitHub's colours (open, draft, merged or closed; an issue open or closed), read only while the Board is open, only for the cards on screen, and kept for five minutes; the state never moves a card. A page opened over your tailnet does not read it. A card an agent wrote to since you last opened the Board is bold until you leave. The header counts what is in flight and what is on you; **Shipped** and **Icebox** are links to their own lists.
- **A card.** Click one to open it beside the lanes: move it (the Move menu, or drag it to another lane), the agent and whether it is working, **Ask where this is** (a short message to its agent, or to another session in the project when its agent has ended), your notes, its threads (a click opens the thread, with a way back to the card), its links (pull requests and issues, with their live state read when you open the card), and its history. **Start** asks the card's agent to begin; **Send to an agent** gives a card nobody was asked about to a running session. **Ship**, **Icebox** and **Drop…** are at its foot.
- **The Icebox.** Cards you put aside. Nothing happens to them and no agent moves one out; **Restore** puts it back where it was. Cards that were dropped are listed there too, with who dropped them and why. When an agent drops a card, a note above the lanes says so until you look.
- **New card.** A title, notes, links and the project; **Add to Backlog**, **Send to an agent** (a new thread to a running session, naming the card), or **Add to Icebox**.
- **The first visit.** The first time you open the Board after turning it on, a short dialog offers a prompt to copy into your agent, asking it to make cards for the work it already has. The **?** in the header shows it again.

On a phone the Board is one list, a fold per lane, and a card opens full screen.

## Connecting your agent

Before any agent has written, the Inbox window shows one next step for this computer: Plannotator's own connections first (Claude Code, Pi and OpenCode 2, where your reply arrives in the session as a new turn on its own), then agents that reach it through MCP, which see your reply the next time they check the Inbox (except Codex 0.149 or later, where it arrives as a new turn too). A tool that is off turns on with one click. A plugin that is missing shows its install command to copy; the window never installs anything, and it moves on by itself once you have. Below the step, a short list says which agents are already connected and what is left.

### Claude Code

With the Plannotator plugin and [the Plannotator mod](/docs/guides/claude-code/#the-plannotator-mod) (Claude Code 2.1.287 or newer), Claude Code gets a `plannotator_inbox` tool. The tool is on by default for Claude Code, also before you ever ran the Inbox: the first time Claude uses it, it starts the Inbox in the background. The tool is added when Claude Code starts, not when you start a new conversation in a running one, so restart Claude Code after you change the setting. When you send a reply, it arrives in that session as a new turn after Claude finishes what it is doing; **Send now** puts it into the turn Claude is in instead. The thread then shows "Delivered to Claude Code".

The mod is off in `claude -p`, in SDK runs and on Windows. There the tool is not added. Use the MCP server instead (see [Other agents](#other-agents)).

### Pi

Install the [Pi extension](/docs/getting-started/installation/#pi), then run `plannotator inbox`: it turns the inbox tool on for Pi when it finds the extension. The tool is off by default on Pi, because Pi sends every tool's full definition with each request: the inbox tool adds about 9 KB to every request, roughly 2,500 tokens depending on the model (about 10 KB, roughly 2,900 tokens, with the Board on). To turn it on yourself:

```bash
export PLANNOTATOR_INBOX_TOOL=1
```

Start a new Pi session (or `/reload`). A reply arrives as a follow-up message once Pi is idle, and Pi never interrupts a run for it; **Send now** steers it into the running run instead. The thread shows "Delivered to Pi". The tool is inactive in print and JSON mode, because nothing could deliver a reply there.

### OpenCode

Add the [OpenCode plugin](/docs/getting-started/installation/#opencode), then run `plannotator inbox`: it turns the inbox tool on for OpenCode when it finds the plugin in your global opencode config. The tool is off by default on OpenCode, for the same reason as Pi (about 9 KB per request, roughly 2,500 tokens). To turn it on yourself:

```bash
export PLANNOTATOR_INBOX_TOOL=1
```

Restart OpenCode. On OpenCode 2 a reply is queued into the session as its own turn once the session is idle, and the thread shows "Delivered to OpenCode"; **Send now** steers it into the running turn instead. On OpenCode 1 the agent has the tool but is not woken. It reads replies with `read_thread` or `wait_for_reply`.

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

- **Claude Code:** once, in the context of the conversation's first message. It names the tool by its full name (`mcp__…__plannotator_inbox`), so Claude can find it. After a compaction, the plugin adds the same line again. On Team and Enterprise accounts, Claude Code's built-in security plugin keeps plugins out of that first-message context, so there the line goes with your first prompt instead. Claude Code still shows a note that the plugin's `prompt.context` hook was skipped; the reminder reaches Claude anyway.
- **Pi:** once, as a hidden message with the session's first prompt.
- **OpenCode:** a line in the system prompt of every request. On OpenCode 1, and on an OpenCode 2 that cannot bring a reply back by itself, the sentence about the reply says to call `wait_for_reply` instead.

The text never changes during a session, so it costs little and does not invalidate the prompt cache. It never appears without the tool. To turn it off, set `inboxReminder` in `~/.plannotator/config.json`: `false` for every host, or one per host, for example `{ "inboxReminder": { "claude-code": false } }`.

#### Your own reminder

You can replace the line with your own, in **Settings → Prompts** or in `~/.plannotator/config.json`:

```json
{
  "prompts": {
    "inbox": {
      "reminder": "Plannotator Inbox is on. Send to it only when no upstream session can take the decision. Use plannotator_inbox send_message and keep going.",
      "runtimes": {
        "pi": { "reminder": "You are a worker session: report to your upstream session first. Use plannotator_inbox send_message only when it is gone." }
      }
    }
  }
}
```

- `prompts.inbox.reminder` is for every agent. `prompts.inbox.runtimes.<agent>.reminder` (`claude-code`, `pi` or `opencode`) is for one agent and wins over the shared text.
- Your text replaces the whole line, on every host, OpenCode 1 included. Each `plannotator_inbox` in it becomes the tool's name in that agent (on Claude Code, its full `mcp__…` name).
- Empty or blank text counts as unset. At most 4,128 characters; longer text is refused when you save it, and ignored if written by hand (Settings → Prompts says so, with Reset to default).
- With no `prompts.inbox` set, every agent gets the line above, exactly as before.
- Like the switch, it is read when a session starts: a change applies to each agent's next session.
- After a compaction on Claude Code, the plugin adds your line again, exactly as you wrote it.
- **Settings → Prompts** shows the line in effect, marked Default or Custom (on OpenCode 1, whose replies do not come back by themselves, its row shows the `wait_for_reply` wording it gets), with **Edit**, **Reset to default** and each agent's own text (**Use shared** deletes it). It also lists the plan, review and annotate prompts (see [custom feedback](/docs/guides/custom-feedback/)), read-only. Changes are made on this computer only; through your tailnet the page is read-only.

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

**Codex** needs no plugin: with Codex 0.149 or later, connected through `plannotator inbox mcp`, your reply arrives in the Codex thread that asked as a new turn by itself (in the TUI, the Codex app and the IDE extension; a one-shot `codex exec` run is not woken, its agent waits for the reply instead). The Inbox puts it there with `codex queue`: an idle thread starts the turn within about a second, a busy one gets it when its current turn ends (never in the middle of one), and a thread whose Codex is closed gets it when you resume it. The Inbox finds `codex` on its `PATH`, else the ChatGPT or Codex app's own Codex. While it queues, your reply is an argument of the `codex queue` command, so for that moment it shows in the process list. The line under your reply says "Queued for Codex; it gets this as its next turn." until the thread's next turn uses the Inbox; there is no **Send now** for Codex. If Codex does not know the thread (it was deleted, or Codex uses another `CODEX_HOME` than the Inbox), the reply is saved for the next agent, as for a session that has ended. If handing it to Codex took too long (30 seconds), the Inbox does not try again, so it never arrives twice, and the line says the reply is saved for the agent's next read. If the Inbox finds no `codex` at all, the reply waits, and goes the next time something happens in the Inbox once a Codex is there.

The Inbox also answers MCP over Streamable HTTP at `http://127.0.0.1:<port>/mcp`. Prefer the command: the port can change when the Inbox restarts.

`plannotator inbox --help` prints a full guide for agents in markdown: when to use the Inbox, each tool and its arguments, how threads and replies work, the question syntax, and the setup line for each client above with your binary's path. An agent with no Plannotator skill can read it once and use the Inbox.

The stdio command fills in the project (its working folder) and a session id for the agent. When a Claude Code or Pi session runs it (a script or command the agent starts), that id is the session's own, so the message joins the session's thread and your reply reaches that session as with its tool. In Codex the id is the Codex thread, which Codex names on every tool call, so your reply goes back into that thread (see below). Otherwise the id lasts as long as the command's process; an agent that passes its own `agent_session` keeps its threads across restarts. Without one of the three connections, or Codex, nothing wakes the agent when you reply. The agent calls `wait_for_reply`, which returns your reply as soon as you send it, or a cursor to wait again after 50 seconds.

### The tools

| Tool | What it does |
|------|--------------|
| `send_message` | Send you a message. It can carry `:::question` blocks and `attachments` (any file it can read, absolute or relative to the project; `.env` refused). `thread` names a thread to join, and `reply_to` answers one of your replies. In a thread you started that has no name you typed, the agent's first reply names it with `thread` (a name another open thread of the project already has is refused, and the agent picks another). `supersedes` (or a `Replaces: <message id>/<key>` line in a new question block) retires earlier questions of the thread, so you can no longer answer them. `done` closes the agent's own action items it saw happen (the card reads "<agent> saw it done"; nothing is sent) |
| `read_thread` | Read one thread as a short transcript: the questions still waiting on you, the newest 6 messages in full (`limit` sets how many), your earlier messages in full (up to 12 KB of them), and every other earlier message as one line with its questions' answers. A message over 16 KB is cut, except your newest one, which is always whole. Your answers are given whole. The agent can ask for any message in full (`expand`), read further back (`before`), or read only what is new since its last read (`after`). Your 👍 Looks good shows on its message. Without a thread, it lists the threads this session wrote in, one short row each (subject, name, where it sits in your list, open questions, last writer and time, your last message, and whether it has a reply from you it has not read) |
| `search` | Find messages by their words, in the agent's project or in every project: its own, other agents' and yours. Read-only: it uses the same search as your **⌘K**, never adds to your recent searches, and marks nothing read. Each result is one line: the thread, the message, who wrote it, when, and the words around the match |
| `wait_for_reply` | Wait for your reply (or your 👍 Looks good on its latest message), up to 50 seconds per call. It returns your reply in full, and each question it answers as its key, state and answer |
| `resolve_message` | Resolve (archive) or reopen a thread |
| `get_guide_brief` | Get the brief for writing a guided review, with an example that works as it is |
| `submit_guide` | Send a guided review: a guide plus its patch, or a snapshot |
| `card` | Only while the Board is on (see [The Board](#the-board)). Make, move and keep its cards current: `create`, `move`, `say` (its last word, and what you owe in Your look or Your review), `link` (a thread, a pull request or an issue), `ship`, `drop` (with a reason) and `list`. Only you put a card in the Icebox or restore one |

No tool answers, approves or sends anything for you.

## Over your tailnet

If you use [Tailscale](https://tailscale.com), you can open the Inbox from your phone, tablet or another computer on your tailnet:

```bash
plannotator inbox --tailscale
```

The command prints an address such as `https://studio.tail1234.ts.net:52817/`. Open it on your other device.

- **Only you can open it.** The Inbox lets in only the Tailscale login that owns this computer. Other people on your tailnet, and tagged devices, get "403". To let in another login (for example, your own login on a shared tailnet), add it to `~/.plannotator/config.json`: `{ "inboxTailscaleAllow": ["you@example.com"] }`.
- **Nothing is public.** The Inbox stays bound to `127.0.0.1`. Tailscale's `tailscale serve` gives the address HTTPS inside your tailnet. The Inbox never uses `tailscale funnel`.
- **Agents stay local, but your answers reach them.** MCP and the agent connections answer only on this computer. A reply, and above all a message you start, becomes a turn in a live agent session on this computer. So anyone who can open the address can drive agents that run commands here: any login in `inboxTailscaleAllow`, and anyone holding your unlocked phone while it is signed in to Tailscale. Allow only logins you would let use this computer.

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
| `projects/<name>-<hash>/` | One folder per project: `project.json`, plus `messages.jsonl`, `questions.jsonl`, `annotations.jsonl` and `cards.jsonl` (the Board's cards, kept when you turn the Board off), which grow by appending lines (a `decisions.jsonl` an older Inbox wrote, when it kept decisions, stays as it was; it is kept only so sequence numbers are never reused, and its decisions are never shown) |
| `blobs/<sha256>` | The version of each attached file as it was sent, a copy of each image a message shows, and each guided review |
| `markups/<sha256>.png` | The images you marked up when commenting on an image attachment, and the frames your video comments carry (`.jpg`) |
| `seq.json` | The highest event number ever written, kept across deletions |
| `agents.json` | The agents `plannotator inbox` found or connected, so it never adds one back that you turned off |
| `drafts/` | Messages you started and did not send, one file each. They never reach an agent, a phone or search |
| `reply-drafts/` | The words typed in a thread's reply box and not sent, one file per thread. They never reach an agent or search; a phone can read them |
| `uploads/` | Files you attached to a message you started or pasted into a reply: those not sent yet (forgotten after a day unless a draft keeps them), and read-only copies of those you sent, which the agent opens |
| `board.json` | When you last looked at the Board, so the cards written since show bold |
| `pins.json` | The threads pinned to the sidebar, in their order. Never seen by an agent or search; a phone reads them with the list |
| `recent-searches.json` | Your last six searches, written only when you open a result. **Clear** in the search box empties it |
| `claims/`, `leases/` and `connection-tools.json` | Bookkeeping for the Pi and OpenCode connections |

The Inbox stores the files agents attached as they were when sent, the messages and your replies. It sets no size limits. To free space, use **Delete thread** or **Delete project** in **Settings**, which also remove sent files that nothing else uses. Your choices for the inbox tool, notifications and the tailnet are kept in `~/.plannotator/config.json` (`inboxTool`, `inboxReminder`, `prompts.inbox`, `inboxNotifications`, `inboxSound`, `inboxBoard`, `inboxTailscale`, `inboxTailscaleAllow`).

## Uninstall

`plannotator uninstall` keeps your Inbox data. To remove it too:

```bash
plannotator uninstall --purge
```

Both forms remove the `plannotator-inbox` entries `plannotator inbox` added to your agents (an entry you changed to run something else is left, and named). `--purge` also stops a running Inbox first, then deletes `~/.plannotator/inbox/` with the rest of the Plannotator data. If the Inbox does not stop, uninstall still removes the plugins, skills, hooks and config entries, but keeps your Plannotator data (`~/.plannotator`) and the `plannotator` binary. Quit the Inbox and run the command again to finish. Add `--dry-run` to see what would be removed.

## Troubleshooting

### The agent has no plannotator_inbox tool

- On Pi and OpenCode, run `plannotator inbox` once, then type `/reload` in Pi (`/restart` in Oh My Pi), run `opencode2 reload` for OpenCode 2, or restart OpenCode 1. A session that started before the Inbox was installed does not get the tool. Claude Code gets the tool without that step, but a Claude Code process that started before you changed the setting needs a restart.
- On Pi and OpenCode, turn the inbox tool setting on: it is off by default there.
- On Claude Code, check that the mod is on (see [Turning the mod off](/docs/guides/claude-code/#turning-the-mod-off)). Without it, use `plannotator inbox mcp`.
- Check `PLANNOTATOR_INBOX_TOOL`: when set, it decides for every host, and the switches in **Settings** are disabled.

### The tool says to install Plannotator

The Pi or OpenCode connection could not find a `plannotator` binary to start a stopped Inbox. It looks for `PLANNOTATOR_BIN`, then `plannotator` on `PATH`, then `~/.local/bin/plannotator`. Install Plannotator, or set `PLANNOTATOR_BIN`.

### My reply did not arrive in the session

- A reply waits until the session is idle, and the line under it says "Queued" while the agent works. Press **Send now** to put it into the running turn instead: the agent reads it at its next step. Nothing is ever stopped or interrupted.
- No **Send now** for a Claude Code session that runs a Plannotator plugin from before Send now, while a newer one is installed: the line says so, and **How to reload** gives the steps. Type `/reload-plugins` in that Claude Code: it loads the new plugin and keeps the session, and nothing is interrupted. If the note is still there after that, type `/exit` in it (this stops the turn it is working on; wait for it to finish to keep it), then run the command it shows (`cd <folder> && claude --resume <session id>`, with **Copy**) to start the same session again. Your reply waits in the Inbox until then. If the installed plugin itself is older than the Inbox, the line says to update the plugin first and shows that command.
- If the agent already read your reply with `read_thread` or `wait_for_reply`, the session is not woken again.
- On OpenCode 1, and for agents connected through MCP alone (except Codex 0.149 or later), nothing wakes the session. The agent has to read the reply.
- Codex gets your reply as its next turn, after the turn it is in ends, so there is no **Send now** for it. With an older Codex, or no `codex` the Inbox can find (its `PATH`, or the ChatGPT app), the reply is not queued: the agent reads it.
- The reply stays in the thread. You can always read it there, and the agent can read it with `read_thread`.

### Notifications stopped

Browsers grant notifications per address (scheme, name and port). The Inbox always opens at `http://localhost:<port>/`, and a page opened at `127.0.0.1` on the same port goes there by itself. If the Inbox had to move to another port because the old one was taken, it says "Notifications are off at this address" above the list on every load until you click **Allow** (or **Not now**).

**Settings → General** shows the state plainly: on for this address, not allowed (with **Allow**), or blocked (with the steps for your browser). **Send a test notification** shows one now: if your browser allows it but you see nothing, check your system's notification settings for the browser, and Focus or Do Not Disturb. **Notifications reach you** says whether any open Inbox tab can show one. Notifications come from an open Inbox tab: with no Inbox tab open, nothing can notify you. If Chrome closed or paused the tab in the background to save memory or energy, the Inbox says so when you come back; add `localhost` under Chrome's **Settings → Performance → Always keep these sites active**.

### Update

When a newer Plannotator release is out, the sidebar shows an **Update** button above **Settings**. The machine checks GitHub every few minutes and when the Inbox starts or the page is reloaded (never your browser), so a new release shows within minutes; turn this off in **Settings → About** ("Tell me when a new version is out"), with `{ "updateCheck": false }` in `~/.plannotator/config.json`, or `PLANNOTATOR_UPDATE_CHECK=0`.

Click **Update to X** to see what's new and what will happen, then **Update now**: the install script runs for that version with the choices from your last install, the button reads **Updating…**, and when the new binary is in, the Inbox restarts on it and the page reloads. Open reviews keep running on the old version until you finish them. **Remind me tomorrow** hides the button for that version for a day. Tick **Install new versions automatically** to let Plannotator do this by itself from then on.

If the binary was already updated (by auto-update, `plannotator update`, or the install script), the button restarts the Inbox at once; if you are typing a reply, it asks first. If an update you started fails, the button reads **Update failed** and shows the exit code and the log. After an update, **What's new in X** sits above Settings for that run.

A Claude Code window keeps the plugin it started with until you reload it. While any connected Claude Code session runs an older plugin than the one installed, the sidebar shows **Reload Claude Code N** under What's new. It opens **Settings → Agents**, where **Open sessions** lists them: type `/reload-plugins` in each (it keeps the session and interrupts nothing; several sessions in the same folder each need their own, and the list tells them apart by when they started). If one is still listed after that, type `/exit` in it and run the command **Copy restart** gives (it starts the same session again in its folder). The row goes away by itself once they have the new plugin. For Pi the same row says to run `pi update --extensions`, then `/reload`. Only sessions connected to the Inbox (the Inbox tool on) are seen.

A copy of Plannotator that the install script did not install cannot update itself: the dialog shows the command to run instead.

### The Inbox does not start

Read `~/.plannotator/inbox/inbox.log`. If another Inbox is already running but not answering (paused or blocked), callers wait up to 20 seconds for it and then report an error rather than start a second one. Stop the stuck process and run `plannotator inbox` again.

### I work over SSH or in a container

The Inbox binds only `127.0.0.1` and ignores `PLANNOTATOR_REMOTE` and `PLANNOTATOR_PORT`. Run it on the machine where you work. To open it from another device, publish it [over your tailnet](#over-your-tailnet).

### The tailnet address answers 403

The Inbox lets in only the Tailscale login that owns the computer it runs on. Open the address on a device signed in with that login, or add your login to `inboxTailscaleAllow` in `~/.plannotator/config.json`. A tagged machine has no owner, so it publishes only after `inboxTailscaleAllow` names a login.
