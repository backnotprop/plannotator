---
title: "Snapshots"
description: "The /plannotator-snapshot command and plannotator snapshot: capture your screen on macOS, mark it up, and send it to an agent session as one message."
sidebar:
  order: 14
section: "Commands"
---

Plannotator Snapshots shows an agent what is on your screen. Press a hotkey, the screen freezes, and you drag a box around what you mean. Mark the snapshot with numbered boxes and comments, collect more if you like, and press **⌘↩**. The agent session gets one message with each image's path, your notes, and each box's position and comment. Nothing blocks the session while you capture.

Capture runs on macOS 14 or newer.

## Usage

### Claude Code, Pi and OpenCode

```
/plannotator-snapshot
```

The command opens Plannotator Snapshots and returns at once. When you press Send, the snapshots arrive in that session as a new message. Claude Code needs [the Plannotator mod](/docs/guides/claude-code/#the-plannotator-mod) (Claude Code 2.1.287 or newer); OpenCode needs OpenCode 2.

### Other agents

Codex, Gemini CLI, Copilot CLI, Kiro, Mistral Vibe, OpenCode 1 and Claude Code without the mod run the command and wait for your Send:

```bash
plannotator snapshot --wait
```

The message is printed when you press Send, and the agent reads it from there.

## Two capture modes

| Mode | Hotkey | What it takes |
|------|--------|---------------|
| Screen Capture | **⌥⇧⌘4** | A box you drag. The picture only |
| App Capture | **⌥⇧⌘5** | The frontmost window, plus its accessibility text (shown in **View text** before you send, where you can remove lines) |

The capture overlay also has a toolbar: Screen Capture (drag), Window (Space), Full Screen (F) and App Capture (A). Esc cancels. The menu bar item has the same choices, plus "Screen Capture in 3 Seconds" for open menus.

## Keys

| Key | What it does |
|-----|--------------|
| **⌥⇧⌘4** | Screen Capture |
| **⌥⇧⌘5** | App Capture |
| **⌥⇧⌘P** | Show or hide the HUD |
| **⌘↩** | Send everything to the agent session as one message |
| **⌘J** | Ask the session about a snapshot. The answer streams back into the HUD |
| **⌘K** | Pick which session receives the send |

## Where a send goes

The session that opened Plannotator Snapshots receives it. Otherwise it goes to the session you typed into in the last 15 minutes, or the only one running. Press **⌘K** to pick another. If no session is connected, the HUD offers Copy as Markdown, Copy images and Reveal in Finder.

## Permissions

The first run installs **Plannotator Snapshots.app** into `~/Applications`. macOS then asks you to allow Screen Recording for it. App Capture also asks for Accessibility, and only when you take one. The app holds these permissions itself: nothing running in your terminal gets them.

The hotkeys need no Accessibility or Input Monitoring permission.

## The command

| Command | What it does |
|---------|--------------|
| `plannotator snapshot` | Open the capture overlay for a Screen Capture, starting the app and the local hub if needed |
| `plannotator snapshot --app` | Take an App Capture of the frontmost window |
| `plannotator snapshot --wait` | The same, then wait and print the message when you press Send |
| `plannotator snapshot --no-capture` | Show the HUD without opening the overlay |
| `plannotator snapshot add <image>` | Add an image file as a snapshot (`-` reads stdin, `--screen` captures the whole display) |
| `plannotator snapshot open` | Open the HUD in your browser |
| `plannotator snapshot status` | Show the hub, the app and the connected sessions |
| `plannotator snapshot stop` | Stop the local hub |
| `plannotator snapshot install-app` | Install the app that ships inside the macOS `plannotator` binary into `~/Applications`. It never replaces a newer build unless you add `--force` |
| `plannotator snapshot hub` | Run the local hub in this terminal (`--background` detaches it) |

`add <file>`, `open`, `status`, `stop` and `hub` also work off macOS and without the app. `add --screen` uses macOS's `screencapture`, so it needs macOS.

## Turning it off

Snapshots is on by default in the Claude Code mod, Pi and OpenCode 2. To turn those integrations off:

```bash
export PLANNOTATOR_SNAPSHOTS=0
```

or set `{ "snapshots": false }` in `~/.plannotator/config.json`. The environment variable takes precedence. The setting is read when a session starts. With it off, `/plannotator-snapshot` is not added and no session connects to the hub. The `plannotator snapshot` command still works.

## Data on disk

Snapshots live under `~/.plannotator/snapshots/` (or `$PLANNOTATOR_DATA_DIR/snapshots/`): each collection's images, crops, window text and notes. A sent collection is kept for 7 days. `plannotator uninstall` removes the app; `plannotator uninstall --purge` also stops the hub and removes `snapshots/`.
