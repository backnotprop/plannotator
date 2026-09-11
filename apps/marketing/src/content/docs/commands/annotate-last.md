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

## Flags

`plannotator annotate-last` accepts the same `--gate`, `--json`, and `--hook` flags as `plannotator annotate`. See [Annotate → Flags](/docs/commands/annotate/#flags) for the full matrix.

### `--exclude-active-turn`

Pass this when the agent launches `annotate-last` itself — from a shell tool call inside a skill, say — rather than through a `!`-inline slash command. In that setup the agent can still write to the transcript after the command starts ("Opened it for you."), and that acknowledgement would otherwise become the "last message".

With the flag, the Claude Code parser ignores the **active turn**: everything from the newest human prompt onward, on the active (post-`/rewind`) branch. The message opened, and the messages offered in the picker, all come from before that prompt — so neither a preamble before the launch nor an acknowledgement after it can be selected. Right after a `/compact` the parser falls back to file order, so the pre-compaction messages are still offered.

```bash
plannotator annotate-last --exclude-active-turn --json
```

Leave it off for the `/plannotator-last` slash command: Claude Code records that command's prompt only after the command finishes, so at read time the "active turn" would be the previous one and the cutoff would skip the message you want. The flag is accepted on every harness; Codex already excludes the active turn unconditionally, and the other harnesses ignore it. If nothing precedes the current turn, the command exits non-zero with `No assistant message precedes the current turn` instead of opening an older session's log.

The common use case for `--gate` on annotate-last is a turn-by-turn review gate wired to a Stop hook:

```bash
plannotator annotate-last --gate
```

Paired with a Claude Code `Stop` hook, this pauses every agent turn for human review. Approve lets the turn end; Send Annotations re-prompts the agent with feedback. See [Hook integration recipes](/docs/guides/hook-integration/).

## Server API

The annotate-last mode reuses the same annotate server endpoints. See the [annotate docs](/docs/commands/annotate/#server-api).

## Environment variables

Same as plan review. See the [environment variables reference](/docs/reference/environment-variables/).
