---
title: "Obsidian Integration"
description: "Auto-save approved plans to your Obsidian vault or Bear."
sidebar:
  order: 22
section: "Guides"
---

Plannotator can automatically save plans to Obsidian or Bear when you approve or deny them.

## Obsidian setup

1. Open **Settings** (gear icon) in the Plannotator header
2. Enable **Obsidian Integration**
3. Select your vault from the dropdown (auto-detected from Obsidian's config) or enter the path manually
4. Set a folder name (default: `plannotator`)

Plannotator detects vaults by reading Obsidian's configuration file:
- **macOS**: `~/Library/Application Support/obsidian/obsidian.json`
- **Linux**: `~/.config/obsidian/obsidian.json`
- **Windows**: `%APPDATA%/obsidian/obsidian.json`

## What gets saved

Each plan is saved as a markdown file with:

- **Human-readable filename**: `Title - Jan 2, 2026 2-30pm.md`
- **YAML frontmatter** with `created` timestamp, `source: plannotator`, and auto-extracted `tags`
- **Backlink** to `[[Plannotator Plans]]` for graph view connectivity
- **Full plan content** as markdown

### Tag extraction

Tags are automatically extracted from:
- The plan title (first H1 heading) — meaningful words become tags
- Code fence languages (e.g., ` ```typescript ` adds a `typescript` tag)
- The git project name (repository or directory name)
- A `plannotator` tag is always included

Up to 7 tags are extracted per plan.

### Example saved file

```markdown
---
created: 2026-01-02T14:30:00.000Z
source: plannotator
tags: [plannotator, my-project, authentication, typescript, sql]
---

[[Plannotator Plans]]

# Implementation Plan: User Authentication
...
```

## Custom folder

By default, plans save to a `plannotator` folder within your vault. You can change this to any folder name in Settings. The folder is created automatically if it doesn't exist.

## Bear integration

Bear works similarly to Obsidian but uses Bear's `x-callback-url` scheme:

1. Open **Settings** in Plannotator
2. Enable **Bear Integration**
3. Plans are sent to Bear via URL scheme on approval

Bear notes include the plan content with hashtags extracted from the title and code languages.

Bear integration is macOS-only (Bear is a macOS/iOS app).

## Quick save

You can also save to Obsidian or Bear at any time using the Export dropdown:

- Click the dropdown arrow next to **Export**
- Select **Save to Obsidian** or **Save to Bear**
- Or press `Cmd/Ctrl+S` to save to your configured default notes app
