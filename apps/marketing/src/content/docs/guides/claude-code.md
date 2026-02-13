---
title: "Claude Code"
description: "How Plannotator works with Claude Code — hooks, permission modes, and the plan review lifecycle."
sidebar:
  order: 4
section: "Getting Started"
---

Plannotator integrates with Claude Code through the hooks system. When Claude calls `ExitPlanMode`, a `PermissionRequest` hook intercepts the call and opens the Plannotator UI.

## How the hook works

Claude Code's hook system lets external commands intercept tool calls. Plannotator registers a `PermissionRequest` hook that matches the `ExitPlanMode` tool:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

When matched, the hook:

1. Receives the plan markdown via stdin (as JSON with `tool_input.plan`)
2. Starts a local Bun server on a random port
3. Opens the browser to the plan review UI
4. Blocks until the user approves or denies
5. Returns a JSON response to stdout that Claude Code interprets

**Approve** returns:
```json
{"hookSpecificOutput":{"decision":{"behavior":"allow"}}}
```

**Deny** returns:
```json
{"hookSpecificOutput":{"decision":{"behavior":"deny","message":"<feedback>"}}}
```

## Permission mode

On first use, Plannotator asks you to choose a permission mode. This controls what Claude Code does after you approve a plan:

- **Bypass permissions** — Claude proceeds with implementation without further permission prompts for the approved plan
- **Default** — Normal Claude Code permission behavior applies (you may see additional permission prompts)

This preference is saved and sent with each approval. You can change it in Settings.

## Approve vs. Send Feedback

Claude Code's hook system doesn't support including feedback in an approval response. This means:

- **Approve** — Plan is approved as-is. If you have annotations, a warning dialog explains they'll be lost.
- **Send Feedback** — The plan is denied with your annotations as structured feedback. Claude revises the plan and presents it again.

If you want to approve with minor notes, use "Send Feedback" — Claude will see your annotations and can incorporate them before resubmitting.

## Slash commands

The plugin registers two slash commands that work inside your Claude Code session:

### `/plannotator-review`

Opens a code review UI for your uncommitted `git diff`. See the [code review docs](/docs/commands/code-review/) for details.

### `/plannotator-annotate <file.md>`

Opens any markdown file in the annotation UI. See the [annotate docs](/docs/commands/annotate/) for details.

## Plugin installation

The plugin is installed from the marketplace:

```
/plugin marketplace add backnotprop/plannotator
/plugin install plannotator@plannotator
```

Restart Claude Code after installing for hooks to take effect. See the [installation guide](/docs/getting-started/installation/) for manual setup.
