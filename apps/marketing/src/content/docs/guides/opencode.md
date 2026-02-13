---
title: "OpenCode"
description: "How Plannotator works with OpenCode — plugin setup, submit_plan tool, and agent switching."
sidebar:
  order: 5
section: "Getting Started"
---

Plannotator integrates with OpenCode as an npm plugin that registers a `submit_plan` tool. When the agent calls `submit_plan`, Plannotator opens the review UI in your browser.

## How the plugin works

The OpenCode plugin (`@plannotator/opencode`) hooks into OpenCode's plugin system:

1. The plugin registers a `submit_plan` tool that the agent can call
2. When `submit_plan` is called with a plan, Plannotator starts a local server and opens the browser
3. The user reviews and annotates the plan
4. On approval, the plugin returns a success response to the agent
5. On denial, the plugin returns the feedback for the agent to revise

## Approve with annotations

Unlike Claude Code, OpenCode supports feedback on approval. This means:

- **Approve** (no annotations) — Agent proceeds with implementation
- **Approve** (with annotations) — Agent proceeds, but also receives your annotations as notes
- **Send Feedback** — Plan is rejected. Agent receives your annotations and revises the plan.

This makes it possible to approve a plan while leaving minor suggestions that the agent can incorporate during implementation.

## Agent switching

OpenCode supports multiple agents. Plannotator lets you choose which agent handles the approved plan:

1. Open **Settings** (gear icon)
2. Under "Agent Switch", select from available agents or enter a custom agent name
3. On approval, the selected agent receives the plan

If the configured agent isn't found in the current OpenCode session, Plannotator shows a warning before approval. You can approve anyway (the default agent will be used) or go back and change the setting.

## Slash commands

The plugin registers two slash commands:

### `/plannotator-review`

Opens a code review UI for uncommitted changes. Requires the CLI to be installed (the slash command runs `plannotator review` under the hood).

### `/plannotator-annotate <file.md>`

Opens a markdown file in the annotation UI. Also requires the CLI.

Install the CLI for slash command support:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

This also clears any cached plugin versions.

## Plugin installation

Add to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@plannotator/opencode@latest"]
}
```

Restart OpenCode. The `submit_plan` tool is now available. See the [installation guide](/docs/getting-started/installation/) for full details.

## Devcontainer / Docker

OpenCode in a container works with the same remote mode environment variables:

```json
{
  "containerEnv": {
    "PLANNOTATOR_REMOTE": "1",
    "PLANNOTATOR_PORT": "9999"
  },
  "forwardPorts": [9999]
}
```

Open `http://localhost:9999` when `submit_plan` is called. See the [remote guide](/docs/guides/remote-and-devcontainers/) for more details.
