---
title: "OpenCode Migration (0.19.1)"
description: "What changes for existing OpenCode users in Plannotator 0.19.1, and how to keep or change the old behavior."
sidebar:
  order: 6
section: "Getting Started"
---

Plannotator `0.19.1` changes the default OpenCode workflow.

Before `0.19.1`, OpenCode behavior was effectively broad automatic access: primary agents could see `submit_plan`, and users could run into cases where `build` or another non-planning agent reached for it.

Starting in `0.19.1`, the default becomes `plan-agent`.

## What changes on upgrade

If you already use `@plannotator/opencode` and upgrade to `0.19.1` without adding any new config:

- `submit_plan` stays available to OpenCode's planning agent, default `plan`
- any agents you list in `planningAgents` are added alongside `plan`
- `build` and other non-planning primary agents stop seeing or calling `submit_plan` by default
- the broad reminder that nudged non-plan primary agents toward `submit_plan` goes away
- `/plannotator-last`, `/plannotator-annotate`, `/plannotator-review`, and `/plannotator-archive` still work

This is the new omitted-config default:

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

## Why the default changed

OpenCode feedback was consistent on two points:

- users still want Plannotator integrated with OpenCode plan mode
- users do not want `submit_plan` exposed broadly enough that `build` or other implementation agents eagerly call it

`plan-agent` is the compromise default:

- it keeps OpenCode plan-mode integration through the built-in `plan` agent
- it narrows `submit_plan` access to `plan` plus any extra planning agents you configure
- it avoids forcing everyone all the way into commands-only mode

## If you want the old behavior

If you want the pre-`0.19.1` broad behavior back, opt into `all-agents`:

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

Use this if you intentionally want primary agents other than `plan` to see and call `submit_plan`.

## If you want commands only

If you do not want automatic plan review at all, switch to `manual`:

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

In `manual` mode:

- `submit_plan` is not registered
- OpenCode planning stays native
- you use Plannotator explicitly through:
  - `/plannotator-last`
  - `/plannotator-annotate`
  - `/plannotator-review`
  - `/plannotator-archive`

## Recommended upgrade path

Choose one of these:

### Keep the new default

Do nothing if you want:

- Plannotator in OpenCode plan mode
- no broad `build` access to `submit_plan`

### Restore the legacy model

Set `workflow` to `all-agents` if your team already depends on broad primary-agent access.

### Move to manual review

Set `workflow` to `manual` if you prefer OpenCode's native planning flow and only want Plannotator when you invoke it yourself.

## Common questions

### Does this remove OpenCode plan integration?

No. The default still keeps Plannotator integrated with OpenCode planning through the planning agent.

### Does this break `/plannotator-last` or `/plannotator-annotate`?

No. Manual commands continue to work across all workflow modes.

### What if my planning agent is not named `plan`?

Add it explicitly. OpenCode's built-in `plan` agent stays enabled in `plan-agent` mode:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    ["@plannotator/opencode@latest", {
      "workflow": "plan-agent",
      "planningAgents": ["planner"]
    }]
  ]
}
```

If you also use other OpenCode plugins, keep Plannotator as the two-item array entry and put the other plugins beside it:

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

Do not put `{ "workflow": "plan-agent" }` as a separate item in the `plugin` array. OpenCode expects each plugin entry to be either a string or `[pluginName, options]`.

### I upgraded but OpenCode still looks stale

Restart OpenCode after upgrading. If a cached plugin version is still being used, rerun the install script or clear the OpenCode cache and restart.

See also:

- [OpenCode guide](/docs/guides/opencode/)
- [Configuration](/docs/getting-started/configuration/)
- [Troubleshooting](/docs/guides/troubleshooting/)
