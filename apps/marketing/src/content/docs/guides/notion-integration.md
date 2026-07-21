---
title: "Notion Integration"
description: "Save Plannotator plans as child pages in Notion."
sidebar:
  order: 23
section: "Guides"
---

Plannotator can save plans to Notion as child pages of a page you choose. The integration uses your local Notion integration token; Plannotator never stores the token in browser settings.

## Setup

1. Create an internal integration or personal access token in the [Notion developer portal](https://www.notion.com/developers).
2. Copy its token into the environment that starts Plannotator:

   ```bash
   export NOTION_TOKEN="ntn_..."
   ```

3. In Notion, open the page under which plans should be created and share it with your integration.
4. Open **Settings > Notion** in Plannotator, enable Notion, and paste the parent page URL or ID.

The token persists through future sessions wherever you keep your environment secrets. It is read only by the local Plannotator server and is never sent from the browser.

## Exporting

Use **Export > Notes**, **Save to Notion** in the header menu, or set Notion as the default `Cmd/Ctrl+S` destination. You can also enable **Auto-save on Plan Arrival**.

Each export creates a child page whose title is the plan's first H1. The plan body is sent as Notion-flavored Markdown.

## Troubleshooting

- `Set NOTION_TOKEN`: start Plannotator with `NOTION_TOKEN` defined.
- `token is invalid or revoked`: create or restore a valid Notion token.
- `Share the parent page`: add your Notion integration to the parent page's connections before exporting.
- Markdown extensions unique to Plannotator may not render exactly as they do in Plannotator.
