---
title: "UI Settings"
description: "In-browser settings for Plannotator — theme, identity, permission mode, auto-close, plan saving, and integrations."
sidebar:
  order: 6
section: "Getting Started"
---

Plannotator stores all settings in **cookies** rather than localStorage. This is because each hook invocation starts a server on a random port, and localStorage is scoped by origin (including port). Cookies persist across ports, so your preferences carry over between sessions.

Open settings with the **gear icon** in the header. Available tabs depend on the current surface; code review includes dedicated Git, Editor, Analysis, Comments, and AI settings alongside General and Theme.

## Theme

The sun/moon toggle in the header switches between **Dark**, **Light**, and **System** themes. System follows your OS preference and updates automatically. Dark is the default.

The **Theme** tab in Settings assigns a palette to each half of a pair: one theme for light mode, one for dark mode. A Light/Dark switch above the grid decides which half you are assigning, and the grid then lists only the palettes that can render it (Kanagawa Wave appears under Dark, Kanagawa Lotus under Light, and a palette that ships both variants appears under each with that mode's colors). The summary line above the grid always names both halves, and clicking either side jumps the grid to it.

With **System** selected, your two choices swap as your OS switches between light and dark. All three mode buttons stay available whatever you pick, because a dark-only palette simply never occupies the light half. The pair is saved to `~/.plannotator/config.json` under `theme`, so it carries across sessions and hosts.

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

Controls which agent to switch to after plan approval or after sending code review feedback. The dropdown is populated dynamically from your OpenCode configuration.

| Option | Behavior |
|--------|----------|
| **Build** | Switch to the build agent |
| **Custom** | Enter a custom agent name (shows a warning if the agent isn't found) |
| **Disabled** | Stay on the current agent |

Until you pick an option, the default differs by surface: plan approval hands off to the **build** agent, and review feedback stays on the current agent. Once you pick an option it applies to both.

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
| **Selection** (default) | Select text, then choose an annotation type from the toolbar (comment, deletion, quick label, "looks good") |
| **Comment** | Select text to immediately create a comment annotation |
| **Redline** | Select text to immediately create a deletion annotation |

## Plan Diff

When the agent resubmits a revised plan, a `+N/-M` badge appears showing what changed. Click it to toggle between normal view and diff view. Two diff modes are available — **Rendered** (color-coded borders on the formatted plan) and **Raw** (monospace git-style `+/-` lines). You can also compare against any previous version from the sidebar's Version Browser tab.

## Diff style

In the code review UI, a toggle in the header switches between **Split** (side-by-side) and **Unified** (single-pane) diff views. Split is the default.

## Review analysis

Code review's **Analysis** tab controls two independent, optional layers:

- **Semantic changes** identifies changed named code entities. It is enabled by default for compatibility and can be turned off without affecting the ordinary diff.
- **Call flow** uses CallDiff to compare inferred call trees between the review's two exact Git snapshots. It is experimental and off by default.

The first code-review session shows both choices side by side in a one-time welcome; change them later in **Settings → Analysis**.

When Call Flow is enabled and supported, **Call flow** appears beside All files in the left panel. Its Dock switches between an interactive **Paths** tree and CallDiff's exact, copyable **Raw** output. The compact **flow** badge in a file header opens every complete inferred entry tree containing a changed call in that file rather than a pruned step list. Both structured surfaces navigate to source locations in the ordinary diff, and all Dock/Lens views share one snapshot-bound analysis result.

Call Flow is syntactic: it does not use type resolution, runtime traces, or data-flow analysis. Treat its paths as review and navigation context, not proof that a path executes. The managed runtime requires Node.js 22 or newer and is not installed with Plannotator. First use detects the changed languages and installs the pruned core (about 5 MB on macOS arm64) plus only their grammar packs. Later missing languages appear as skipped files with an install action while installed-language analysis remains available. Open the Dock's **Languages** detail to see every supported family, installed state, and estimated size or install one ahead of need. Scripted installs can opt into the core with `--with-call-flow`, `PLANNOTATOR_INSTALL_CALLDIFF=1`, or `plannotator install-runtime call-flow`.

## Resizable panels

Both the plan review and code review UIs have resizable panels. Drag the panel edges to adjust widths — your layout is saved automatically and restored on the next session.

- **Plan review:** Table of Contents sidebar (left) and annotation panel (right)
- **Code review:** File tree sidebar (left) and review panel (right)
