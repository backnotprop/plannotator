---
title: "Annotate Last"
description: "The /plannotator-last slash command for annotating the agent's most recent message."
sidebar:
  order: 13
section: "Commands"
---

The `/plannotator-last` command opens the agent's most recent response in the annotation UI, letting you highlight text, add comments, and send structured feedback back.

## Usage

### Claude Code

```
/plannotator-last
```

### OpenCode

```
/plannotator-last
```

### Pi

```
/plannotator-last
```

### Codex

```
!plannotator last
```

## How it works

```
User runs /plannotator-last
        ↓
Last assistant message extracted from session
        ↓
Annotate server starts (random port)
        ↓
Browser opens, loads annotation UI
        ↓
/api/plan returns { plan: message, mode: "annotate-last" }
        ↓
User annotates → Send Annotations
        ↓
Feedback sent to agent
```

## Session log parsing

Each harness reads the last assistant message differently:

| Harness | Source | Method |
|---------|--------|--------|
| **Claude Code** | `~/.claude/projects/{slug}/*.jsonl` | Parses JSONL session logs, finds last assistant text blocks |
| **OpenCode** | SDK | `client.session.messages()` API |
| **Pi** | SDK | `ctx.sessionManager.getEntries()` API |
| **Codex** | `~/.codex/sessions/` rollout files | Parses JSONL by `CODEX_THREAD_ID` env var |

For Claude Code, the parser handles streamed chunks (multiple JSONL lines sharing the same `message.id`), filters out system-generated user messages, and skips noise entries. If the most recent session log has no assistant messages, it tries earlier logs sorted by modification time.

## Annotate-last mode differences

The annotation UI in `annotate-last` mode works the same as `/plannotator-annotate`, with minor copy changes:

- Copy button shows "Copy message" instead of "Copy plan"
- Completion screen says "annotations on the message"
- Feedback export is titled "Message Feedback" instead of "Plan Feedback"

## Server API

The annotate-last mode reuses the same annotate server endpoints. See the [annotate docs](/docs/commands/annotate/#server-api).

## Environment variables

Same as plan review. See the [environment variables reference](/docs/reference/environment-variables/).
