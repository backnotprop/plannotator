---
title: "Hook Integration"
description: "Wire Plannotator into agent hooks for human-in-the-loop review gates on spec artifacts, code output, and agent turns. Works with Claude Code, Codex, OpenCode, and any agent that supports PostToolUse or Stop hooks."
sidebar:
  order: 27
section: "Guides"
---

Plannotator can run as a hook command inside any agent that supports lifecycle hooks. The agent writes a file or finishes a turn, the hook fires, and Plannotator opens a review UI in the browser. The reviewer approves, sends annotations, or dismisses. The hook blocks until a decision is made, then returns the result in the hook protocol's native format.

One flag does everything:

```
plannotator annotate <file> --hook
```

`--hook` implies `--gate` (three-button UX) and emits hook-native JSON. Approve and Close produce empty stdout (hook passes). Send Annotations produces `{"decision":"block","reason":"<feedback>"}` (hook blocks with feedback). This format is the native protocol for Claude Code, Codex, and any agent that uses `{"decision":"block"}` for hook signaling.

## How hooks see Plannotator

Agent hooks communicate via stdout and exit codes. Plannotator always exits `0`. The decision lives in stdout:

| Decision | Stdout | Hook behavior |
|---|---|---|
| Approve | empty | passes, agent proceeds |
| Close | empty | passes, agent proceeds |
| Send Annotations | `{"decision":"block","reason":"<feedback>"}` | blocks, feedback shown to agent |

The `{"decision":"block","reason":"..."}` format is the native hook protocol used by [Claude Code](https://code.claude.com/docs/en/hooks), [Codex](https://developers.openai.com/codex/hooks), and compatible agents. No wrapper script needed.

## Environment variables in hooks

When a hook fires, the agent exposes tool inputs as environment variables. The variable names depend on the agent:

| Agent | File path variable | Project root |
|---|---|---|
| Claude Code | `$CLAUDE_TOOL_INPUT_file_path` | `$CLAUDE_PROJECT_DIR` |
| Codex | `$CODEX_TOOL_INPUT_file_path` | `$CODEX_PROJECT_DIR` |

The examples below use Claude Code's variable names. Substitute your agent's equivalents. See your agent's hook documentation for the full list of available variables.

## Recipe 1: Review every file the agent writes

A PostToolUse hook on Write triggers Plannotator every time the agent creates or modifies a file. This is the core pattern for spec-driven frameworks (spec-kit, kiro, openspec) where each artifact needs human review before the agent builds from it.

Add to `.claude/hooks.json` (or the equivalent for your agent):

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator annotate \"$CLAUDE_TOOL_INPUT_file_path\" --hook",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

The `timeout` is 4 days in seconds. The hook blocks while the reviewer works in the browser, so set it high.

What happens:

1. Agent writes `spec.md`.
2. PostToolUse hook fires, opens Plannotator in the browser.
3. Reviewer reads the spec, adds inline annotations, clicks **Send Annotations**.
4. Hook emits `{"decision":"block","reason":"<feedback>"}`. Agent sees the feedback and revises.
5. Or reviewer clicks **Approve**. Hook emits nothing. Agent proceeds to the next task.

## Recipe 2: Review every agent turn

A Stop hook pauses the agent after every response for human review. Use `annotate-last` to open the agent's last message in Plannotator.

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator annotate-last --hook",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

- **Send Annotations** prevents the agent from stopping and re-prompts with feedback.
- **Approve** or **Close** lets the turn end normally.

## Combining both

You can use PostToolUse and Stop hooks together. The PostToolUse hook gates individual file writes. The Stop hook gates the overall turn. The agent gets targeted file feedback during execution and a final review at the end.

## Alternative modes

`--hook` is the recommended approach for hook integrations. Two other modes exist for different use cases:

### `--gate` (plaintext)

Three-button UX without hook-native JSON. Approve emits the line `The user approved.`, Close emits nothing, Send Annotations emits plaintext feedback. Useful for slash command templates where the agent reads stdout directly.

### `--json` (structured decisions)

Emits `{"decision":"approved|annotated|dismissed","feedback":"..."}` for every decision. Useful for wrapper scripts that want to parse the decision type for logging, telemetry, or conditional routing. Pair with `--gate` for all three decisions.

See [Annotate Flags](/docs/commands/annotate/#flags) for the full stdout matrix.

## Agents with built-in plugins

OpenCode and Pi have native Plannotator plugins with slash commands:

```
/plannotator-annotate spec.md --gate
```

These harnesses don't use stdout for signaling -- the plugin writes directly to the session. Approve and Close skip injection; Send Annotations injects the feedback. `--hook` and `--json` are accepted silently so recipes stay portable across all harnesses.

## Notes

- Exit code is always `0`. Decisions are signaled via stdout.
- Folder annotation with `--hook` applies one decision to the whole session. The reviewer navigates files inside the UI and submits once.
- `--hook` and `--gate` are opt-in. Interactive users running `/plannotator-annotate README.md` still see the default two-button experience.
