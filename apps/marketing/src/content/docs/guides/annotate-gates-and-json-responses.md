---
title: "Annotate Gates and JSON Responses"
description: "The --gate, --json, and --hook flags extend plannotator annotate from a feedback tool into a structured review gate with machine-readable decisions. Use them to wire Plannotator into spec-driven workflows, Stop hooks, and agent pipelines."
sidebar:
  order: 28
section: "Guides"
---

`plannotator annotate` and `plannotator annotate-last` accept three flags that turn markdown annotation into a full review gate with structured output.

## Capabilities

- **`--gate`** adds an Approve button to the annotation UI. The reviewer picks one of three decisions: approve, send annotations, or close.
- **`--json`** emits every decision as a structured JSON object on stdout so hooks and plugins can route on the outcome without parsing free text.
- **`--hook`** emits hook-native JSON that works directly with Claude Code and Codex PostToolUse/Stop hook protocols. Implies `--gate`. Recommended for hook integrations.
- The flags compose. Use any alone or together.
- Identical semantics across every supported harness: Claude Code, Copilot CLI, Gemini CLI, OpenCode, Pi, and Codex.

## Stdout contract

```
          Flags           │        UX        │         Approve         │          Close           │                 Annotate
──────────────────────────┼──────────────────┼─────────────────────────┼──────────────────────────┼───────────────────────────────────────────────
 (none)                   │  2-button        │  n/a                    │  empty                   │  feedback (plaintext)
 --gate                   │  3-button        │  `The user approved.`   │  empty                   │  feedback (plaintext)
 --json                   │  2-button        │  n/a                    │  {"decision":"dismissed"}│  {"decision":"annotated","feedback":"..."}
 --gate --json            │  3-button        │  {"decision":"approved"}│  {"decision":"dismissed"}│  {"decision":"annotated","feedback":"..."}
 --hook                   │  3-button        │  empty                  │  empty                   │  {"decision":"block","reason":"..."}
```

### JSON schema

```json
{
  "decision": "approved" | "annotated" | "dismissed",
  "feedback": "string (present only when decision is 'annotated')"
}
```

### Example outputs

**Approved** (reviewer clicked Approve, `--gate --json`):

```json
{"decision":"approved"}
```

**Dismissed** (reviewer clicked Close, `--json` or `--gate --json`):

```json
{"decision":"dismissed"}
```

**Annotated** (reviewer sent annotations, `--json` or `--gate --json`). The `feedback` field is the same markdown Plannotator emits in plaintext mode:

```json
{
  "decision": "annotated",
  "feedback": "# File Feedback\n\nI've reviewed this file and have 2 pieces of feedback:\n\n## 1. Remove this\n`the selected text`\n> I don't want this.\n\n## 2. Feedback on: \"some highlighted text\"\n> This needs more detail.\n\n---"
}
```

The object is emitted as a single line of JSON per invocation. One invocation, one decision, one line on stdout.

## `--gate`

A three-way review decision. The annotation UI adds an Approve button alongside Close and Send Annotations. The reviewer declares intent explicitly:

- **Approve.** The artifact is good as written. The agent should proceed.
- **Send Annotations.** The reviewer has specific changes. The feedback is returned verbatim.
- **Close.** The session ends without a decision. Neither a signal to the agent nor an instruction set.

In plaintext mode, Approve emits the single line `The user approved.` on stdout so templates and agents can distinguish approval from close without needing `--json`. Close emits nothing. Send Annotations emits the feedback markdown. For hook integrations, use `--hook` instead, which emits hook-native JSON directly.

## `--json`

Structured stdout. Every decision is emitted as a JSON object with a `decision` field and optionally a `feedback` payload. Hooks and plugins that need explicit routing (log approvals separately from dismissals, gate on decision type, accumulate telemetry) use this.

`--json` is orthogonal to `--gate`:

- `--json` alone keeps the two-button UI. Only `annotated` and `dismissed` decisions are emitted.
- `--gate --json` unlocks all three decisions in structured form.
- On OpenCode and Pi, `--json` is accepted silently. Those harnesses write back to the session directly rather than via stdout, so the flag has no effect there. Recipes remain portable.

## `--hook`

Emits hook-native JSON that works directly with Claude Code and Codex PostToolUse/Stop hook protocols. Implies `--gate` (always three-button UX). If both `--hook` and `--json` are passed, `--hook` wins.

- Approve → empty stdout → hook passes → agent proceeds.
- Close → empty stdout → hook passes → agent proceeds.
- Send Annotations → `{"decision":"block","reason":"<feedback>"}` → hook blocks with feedback.

This is the recommended approach for hook integrations. The `{"decision":"block","reason":"..."}` format is the native protocol both Claude Code and Codex use for PostToolUse and Stop hooks. No wrapper script needed.

The flag is accepted silently on OpenCode and Pi for the same reason `--json` is: those harnesses don't use stdout as the signal channel.

## Primary use cases

### Spec-driven development frameworks

Spec-driven development frameworks like spec-kit, kiro, and openspec generate multiple markdown artifacts per feature: `spec.md`, `plan.md`, `tasks.md`, `research.md`, `data-model.md`. Each goes through clarify, review, and approve cycles. Plannotator's annotation UI is a first-class fit for reviewing these artifacts: inline, targeted feedback on markdown is exactly what these workflows need.

With `--gate`, a PostToolUse hook on Write triggers a full review gate every time the agent produces a spec artifact. The reviewer approves, annotates, or dismisses. The agent proceeds, revises, or skips accordingly.

### Turn-by-turn review

`plannotator annotate-last --gate` wired into a Claude Code Stop hook pauses every agent turn for human review. Approve closes the turn cleanly. Send Annotations re-prompts the agent with the reviewer's feedback. Close ends the turn without injecting anything.

### Programmatic decision routing

When a hook or plugin needs to distinguish approve from dismiss, `--json` provides a single-line, stable contract. One-shot decisions become machine-readable events. No stdout parsing, no fragility.

## Hook integration recipes

See [Hook Integration](/docs/guides/hook-integration/) for copy-paste recipes that wire these flags into PostToolUse and Stop hooks on Claude Code, plus portable variants for OpenCode and Pi.

## Exit codes

Every decision exits `0`. Signals live on stdout. This keeps Plannotator composable with harnesses that use exit codes for their own purposes.
