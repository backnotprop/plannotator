---
title: "Prompts"
description: "How Plannotator's review agents structure their prompts, what we control, what the CLI harness owns, and how the pieces fit together."
sidebar:
  order: 33
section: "Reference"
---

Plannotator's review agents (Claude, Codex, and Code Tour) all shell out to an external CLI. This page maps what those CLIs receive on every invocation: which parts Plannotator controls, and which parts are owned by the CLI's own agent harness.

Importantly, **we don't invent our own review prompts**. The Claude review prompt is derived from Claude Code's published open-source review prompt, and the Codex review prompt is copied verbatim from [`codex-rs/core/review_prompt.md`](https://github.com/openai/codex). You get the same review behavior those tools ship with. Code Tour is the one exception: it's a Plannotator-original workflow, so its prompt is ours.

## The three layers

Every review call is shaped by three layers:

1. **System prompt.** Owned by the CLI (Claude Code or codex-rs). Plannotator never sets or touches this.
2. **User message.** What Plannotator sends. Always a single concatenated string of two parts: a static **review prompt** plus a dynamic **user prompt**.
3. **Output schema.** A JSON schema passed to the CLI as a flag, forcing the final assistant message to match a known shape.

## What's in the user message

The user message Plannotator sends is always:

```
<review prompt>

---

<user prompt>
```

**Review prompt** is a long, static review instruction that lives in the repo as a TypeScript constant. It's distinct per provider.

**User prompt** is a short, dynamic line built per call from the diff type (`uncommitted`, `staged`, `last-commit`, `branch`, `jj-current`, PR URL, and so on). Review agents share one builder; Code Tour uses a tour-specific builder with the same diff instructions.

## Matrix

| | Claude review | Codex review | Code Tour (Claude or Codex) |
|---|---|---|---|
| **System prompt** | Owned by `claude` CLI. We don't touch it. | Owned by `codex` CLI. We don't touch it. | Same as whichever engine runs. |
| **Review prompt (static, ours)** | `CLAUDE_REVIEW_PROMPT` in `packages/server/claude-review.ts` | `CODEX_REVIEW_SYSTEM_PROMPT` in `packages/server/codex-review.ts` (misnamed; it's user content) | `TOUR_REVIEW_PROMPT` in `packages/server/tour/tour-review.ts` |
| **User prompt (dynamic, ours)** | `buildAgentReviewUserMessage(patch, diffType, …)` | same function | `buildTourUserMessage(patch, diffType, …)` |
| **Full user message** | `review prompt + "\n\n---\n\n" + user prompt` | same | same |
| **Delivered via** | stdin | last positional argv | stdin (Claude engine) or positional argv (Codex engine) |
| **Output schema flag** | `--json-schema <inline JSON>` | `--output-schema <file path>` | same as engine |
| **Schema shape** | severity findings (`important`, `nit`, `pre_existing`) | priority findings (P0 through P3) | stops plus QA checklist |

## Why the schema matters

The schema flag is a terminal constraint, not a per-turn one. The agent reasons freely across N turns, reading files, grepping, running tests, and only the final assistant message is forced to deserialize against the schema. Everything upstream is unconstrained exploration.

That's why this pattern works for review. You get agentic exploration (the whole point of using Claude Code or Codex over a raw LLM call), plus a machine-readable payload the UI can render without any scraping.

## What you can tune per job

From the **Agents** tab in the code-review UI, each provider exposes these settings:

| Setting | Claude | Codex | Tour |
|---|---|---|---|
| Model | yes (`--model`) | yes (`-m`) | yes (per engine) |
| Reasoning effort | yes (`--effort`) | yes (`-c model_reasoning_effort=…`) | yes (per engine) |
| Fast mode | no | yes (`-c service_tier=fast`) | Codex engine only |

None of these change the review prompt or user prompt. They only change how the underlying CLI executes the same user message.

## Relationship to code review

See [Code Review](/docs/commands/code-review/) for the end-to-end flow this feeds into.
