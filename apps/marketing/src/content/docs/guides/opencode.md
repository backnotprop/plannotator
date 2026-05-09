---
title: "OpenCode"
description: "How Plannotator works with OpenCode — plugin setup, submit_plan tool, and agent switching."
sidebar:
  order: 5
section: "Getting Started"
---

Plannotator integrates with OpenCode as an npm plugin. By default it makes `submit_plan` available to OpenCode's `plan` agent only, so OpenCode plan mode can use Plannotator without exposing the tool to `build`.

If you are upgrading from an older OpenCode setup, read the [0.19.1 migration guide](/docs/guides/opencode-migration-0-19-1/) first.

## How the plugin works

The OpenCode plugin (`@plannotator/opencode`) hooks into OpenCode's plugin system:

1. The plugin registers a `submit_plan` tool for OpenCode's built-in `plan` agent and any extra planning agents you configure
2. When `submit_plan` is called with a plan, Plannotator starts a local server and opens the browser
3. The user reviews and annotates the plan
4. On approval, the plugin returns a success response to the agent
5. On denial, the plugin returns the feedback for the agent to revise

## Workflow modes

OpenCode support has four explicit modes:

- **`plan-agent`** (default): `submit_plan` is available to OpenCode's built-in `plan` agent plus any extra agents listed in `planningAgents`.
- **`manual`**: `submit_plan` is not registered. Use `/plannotator-last`, `/plannotator-annotate`, `/plannotator-review`, and `/plannotator-archive` when you want Plannotator.
- **`user-managed`**: `submit_plan` is registered but no prompts or agent permissions are modified. You configure which agents can call `submit_plan` via OpenCode's agent configuration.
- **`all-agents`**: legacy broad behavior. Primary agents can see and call `submit_plan`.

Default config:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["plan"]
    }]
  ]
}
```

If you use other OpenCode plugins, keep everything in the same `plugin` array and attach Plannotator's options directly to the Plannotator entry:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["plan", "sisyphus"]
    }],
    "@tarquinen/opencode-dcp@latest",
    "octto",
    "oh-my-opencode-slim"
  ]
}
```

Do not put `{ "workflow": "plan-agent" }` as its own item in the `plugin` array. OpenCode plugin entries must be either a plugin string or a two-item array like `[pluginName, options]`.

If you want the old broad behavior:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "all-agents"
    }]
  ]
}
```

If you want commands only:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "manual"
    }]
  ]
}
```

If you want the tool registered but want to manage prompts and permissions yourself:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "user-managed"
    }]
  ]
}
```

## Custom planning agents

OpenCode's built-in `plan` agent is always included in `plan-agent` mode. If you use another planning agent, add its OpenCode agent name to `planningAgents`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["planner", "sisyphus"]
    }]
  ]
}
```

With other plugins, the same rule applies. Only the Plannotator entry becomes a tuple with options:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["planner", "sisyphus"]
    }],
    "oh-my-opencode-slim",
    "openviking-opencode"
  ]
}
```

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

The plugin registers slash commands that work in every workflow mode:

### `/plannotator-review`

Opens a code review UI for uncommitted changes. Also supports reviewing GitHub pull requests:

```
/plannotator-review https://github.com/owner/repo/pull/123
```

Requires the CLI to be installed (the slash command runs `plannotator review` under the hood).

### `/plannotator-annotate <file.md>`

Opens a markdown file, directory, or URL in the annotation UI. Also requires the CLI.

### `/plannotator-last`

Annotates the agent's most recent message. See the [annotate last docs](/docs/commands/annotate-last/) for details.

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

Restart OpenCode. With the default workflow, `submit_plan` is available to the `plan` agent. If you need `build` or another primary agent to call it, set `workflow` to `all-agents`. See the [installation guide](/docs/getting-started/installation/) for full details.

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
