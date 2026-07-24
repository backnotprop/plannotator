---
title: "Annotate Gates and JSON Responses"
description: "The --gate, --json, and --hook flags extend plannotator annotate from a feedback tool into a structured review gate with machine-readable decisions. Use them to wire Plannotator into spec-driven workflows, Stop hooks, and agent pipelines."
sidebar:
  order: 28
section: "Guides"
---

`plannotator annotate` and `plannotator annotate-last` accept three flags that turn markdown annotation into a full review gate with structured output. Direct `plannotator annotate` invocations also support strict automation with `--require-approval` and `--result-file`.

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
 --gate --json            │  3-button        │  {"decision":"approved","feedback":"..."}│  {"decision":"dismissed"}│  {"decision":"annotated","feedback":"..."}
 --hook                   │  3-button        │  empty                  │  empty                   │  {"decision":"block","reason":"..."}
```

### JSON schema

```json
{
  "decision": "approved" | "annotated" | "dismissed",
  "feedback": "string (present for annotated decisions and approvals with notes)"
}
```

### Example outputs

**Approved** (reviewer clicked Approve, `--gate --json`):

```json
{"decision":"approved"}
```

If the reviewer approves while leaving notes, direct structured transport preserves both:

```json
{"decision":"approved","feedback":"Keep the retry bounded."}
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
- Direct `--gate --json` approval can include feedback. Transports that can
  deliver approval but not attached notes warn before discarding feedback and
  direct the reviewer to **Send Feedback** instead.
- On OpenCode and Pi, `--json` is accepted silently. Those harnesses write back to the session directly rather than via stdout, so the flag has no effect there. Recipes remain portable.

## `--hook`

Emits hook-native JSON that works directly with Claude Code and Codex PostToolUse/Stop hook protocols. Implies `--gate` (always three-button UX). If both `--hook` and `--json` are passed, `--hook` wins.

- Approve → empty stdout → hook passes → agent proceeds.
- Close → empty stdout → hook passes → agent proceeds.
- Send Annotations → `{"decision":"block","reason":"<feedback>"}` → hook blocks with feedback.

This is the recommended approach for hook integrations. The `{"decision":"block","reason":"..."}` format is the native protocol both Claude Code and Codex use for PostToolUse and Stop hooks. No wrapper script needed.

`--hook` remains intentionally unchanged: approval is represented by empty
stdout in the native hook protocol, so it has no channel for approval notes.
Use **Send Feedback** to block with notes; that action still means “revise and
reopen,” not “approve and continue.”

The flag is accepted silently on OpenCode and Pi for the same reason `--json` is: those harnesses don't use stdout as the signal channel.

## Strict direct gates

For a fail-closed direct CLI gate, add either or both strict options:

```sh
plannotator annotate docs/plan.md --gate --json \
  --require-approval \
  --result-file .tmp/plan-review-result.json
```

- **`--require-approval`** exits `0` only for `approved`. `annotated` and `dismissed` still publish their valid JSON decision, then exit nonzero.
- **`--result-file <path>`** atomically publishes the same newline-terminated JSON bytes written to stdout. The path is resolved from the invocation working directory.
- Both options require `--gate --json`, are available only on direct `annotate` invocations, and cannot be combined with `--hook`. Hook output and exit behavior are unchanged.

The result-file parent directory must already exist and the destination must not. Plannotator writes a private `0600` temporary file in the same directory, flushes and closes it, then publishes it with an atomic no-clobber hard link. It never overwrites an existing destination or falls back to a non-atomic copy. Use a unique result path for every invocation.

The stdout decision record is written **before** the result file. If publication fails, the reviewer's decision has already been emitted on stdout — capture stdout even when you also pass `--result-file`.

Two caveats on the publication guarantees:

- The `0600` temporary-file mode is a POSIX permission and is effectively a no-op on Windows; use filesystem ACLs there if the result path needs to be private.
- The atomic link (like an atomic rename) is not followed by an `fsync` of the parent directory. Publication is atomic against concurrent readers, but a machine crash immediately afterwards can still lose the directory entry.

Keep the reviewed source at a stable project path so revisions and version history continue to refer to the same artifact. Result and diagnostic log files can instead live in a narrowly scoped temporary directory.

Clicking Close publishes `{"decision":"dismissed"}`.

Abandoning the review publishes the same `dismissed` decision. A local direct structured gate tracks its connected review surfaces: once at least one has connected, losing the last one starts a 30-second reconnect grace period, and expiry resolves the gate as `dismissed`. Reloading the page, navigating away and back, or closing one of several tabs all reconnect or leave another surface connected, so none of them dismiss the review. Approve, Send Annotations, and Close still win over a pending expiry.

An abandoned review keeps its saved annotation draft, so nothing you wrote is lost. If a stale tab comes back after the gate already resolved, its Approve, Send Annotations, or Close reports an error instead of pretending to apply: the decision the caller received is the one that counts.

Two cases remain caller-side recovery, never approval: a session where no review client ever connected (a browser that failed to launch keeps waiting, so pass your own startup timeout), and a half-open transport loss, where the connection is only proven dead by a failing heartbeat write and can take longer than the grace period to notice. Remote and shared sessions keep the behavior off entirely, because a tunnel or proxy disconnect is not abandonment.

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

By default, every decision exits `0`; existing plaintext, JSON, and hook integrations are unchanged. With `--require-approval`, only `approved` exits `0`; `annotated` and `dismissed` publish their JSON result before exiting `1`.

Strict invocations that are misconfigured or cannot start exit `2` — bad flag combinations, an invalid `--result-file` destination, and every annotate startup failure (missing or unreadable path, unreachable URL, empty folder, ambiguous filename, oversized file). Those startup failures exit `1` for non-strict invocations, as they always have; under a strict flag `1` means "the reviewer did not approve", so a mistyped path must never be reported as a rejection.

A failed atomic publish also exits `2`, but that code means the result *file* was not published — the reviewer's decision was already written to stdout. Only a stdout write failure leaves no record at all.

This follows the grep convention: `0` approved, `1` not approved, `2` the gate itself errored.
