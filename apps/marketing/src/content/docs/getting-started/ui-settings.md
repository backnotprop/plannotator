---
title: "UI Settings"
description: "In-browser settings for Plannotator — theme, identity, permission mode, auto-close, plan saving, and integrations."
sidebar:
  order: 6
section: "Getting Started"
---

Plannotator stores all settings in **cookies** rather than localStorage. This is because each hook invocation starts a server on a random port, and localStorage is scoped by origin (including port). Cookies persist across ports, so your preferences carry over between sessions.

Open settings with the **gear icon** in the header. The dialog has three tabs: **General**, **Display**, and **Saving**. The code review UI shows only the General tab.

## Theme

The sun/moon toggle in the header switches between **Dark**, **Light**, and **System** themes. System follows your OS preference and updates automatically. Dark is the default.

## General

### Identity

Your identity is an auto-generated name in the format `adjective-noun-tater` (e.g., "swift-falcon-tater"). It appears as the author on your annotations when you share a plan or review with others. Click **Regenerate** to create a new one — this updates the author field on all existing annotations in the current session.

### Permission mode

> Claude Code only. Requires Claude Code 2.1.7 or later.

Controls what happens with tool permissions after you approve a plan. This determines how much autonomy Claude gets during implementation.

| Option | Behavior |
|--------|----------|
| **Auto-accept Edits** (default) | Auto-approve file edits, ask for other tools |
| **Bypass Permissions** | Auto-approve all tool calls (equivalent to `--dangerously-skip-permissions`) |
| **Manual Approval** | Manually approve each tool call |

On first launch, Plannotator shows a one-time setup dialog for this setting. You can change it at any time in Settings.

### Agent switching

> OpenCode only.

Controls which agent to switch to after plan approval. The dropdown is populated dynamically from your OpenCode configuration.

| Option | Behavior |
|--------|----------|
| **Build** (default) | Switch to the build agent after approval |
| **Custom** | Enter a custom agent name (shows a warning if the agent isn't found) |
| **Disabled** | Stay on the current agent after approval |

### Auto-close tab

Controls whether the browser tab closes automatically after you approve or deny a plan.

| Option | Behavior |
|--------|----------|
| **Off** (default) | Tab stays open after submitting |
| **Immediately** | Tab closes right away |
| **After 3 seconds** | Tab closes after a 3-second delay |
| **After 5 seconds** | Tab closes after a 5-second delay |

## Display

> Plan review only. These settings do not appear in the code review UI.

On first launch, Plannotator shows a one-time setup dialog for these display options.

### Table of Contents

Toggle the sidebar navigation panel on desktop. Enabled by default. On mobile, the sidebar is always hidden regardless of this setting.

### Sticky Actions

Keep the action buttons (Approve, Send Feedback, Export) pinned to the top of the page while scrolling. Enabled by default. Useful for long plans where you'd otherwise have to scroll back up to submit.

### Tater Mode

Enables animated Tater sprite characters that run across the screen. Off by default. Purely decorative.

## Saving

> Plan review only.

### Save plans

Auto-save approved and denied plans to disk. Enabled by default. Plans are saved to `~/.plannotator/plans/` unless you specify a custom path.

When enabled, an optional **Custom Path** input lets you override the default directory. Leave it empty to use the default location.

### Default save action

Controls what the **Cmd/Ctrl+S** keyboard shortcut does.

| Option | Behavior |
|--------|----------|
| **Ask each time** (default) | Opens the Export dialog |
| **Download Annotations** | Downloads the annotations file directly |
| **Obsidian** | Saves directly to your Obsidian vault (only shown if Obsidian is enabled) |
| **Bear** | Saves directly to Bear (only shown if Bear is enabled) |

### Obsidian integration

Auto-save approved plans to an Obsidian vault. Disabled by default. When enabled, the following options appear:

- **Vault** — dropdown of auto-detected vaults, or choose "Custom path..." to enter a vault path manually
- **Folder** — subfolder within the vault (defaults to `plannotator`)
- **Frontmatter preview** — read-only preview of the YAML frontmatter that will be added to saved plans, including timestamps, tags extracted from the plan, and source metadata

Plans are saved as Markdown files to `{vault}/{folder}/`. See the [Obsidian integration guide](/docs/guides/obsidian-integration/) for detailed setup instructions.

### Bear Notes

Auto-save approved plans to Bear using the `x-callback-url` protocol. Disabled by default. No additional configuration is needed — just toggle it on.

## Annotation modes

The mode switcher below the header in the plan review UI controls how text selection creates annotations. This preference persists between sessions.

| Mode | Behavior |
|------|----------|
| **Selection** (default) | Select text, then choose an annotation type from the toolbar (comment, deletion, replacement, insertion) |
| **Comment** | Select text to immediately create a comment annotation |
| **Redline** | Select text to immediately create a deletion annotation |

## Plan Diff

When the agent resubmits a revised plan, a `+N/-M` badge appears showing what changed. Click it to toggle between normal view and diff view. Two diff modes are available — **Rendered** (color-coded borders on the formatted plan) and **Raw** (monospace git-style `+/-` lines). You can also compare against any previous version from the sidebar's Version Browser tab.

## Diff style

In the code review UI, a toggle in the header switches between **Split** (side-by-side) and **Unified** (single-pane) diff views. Split is the default.

## Resizable panels

Both the plan review and code review UIs have resizable panels. Drag the panel edges to adjust widths — your layout is saved automatically and restored on the next session.

- **Plan review:** Table of Contents sidebar (left) and annotation panel (right)
- **Code review:** File tree sidebar (left) and review panel (right)
