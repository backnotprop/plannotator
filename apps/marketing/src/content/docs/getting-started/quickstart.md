---
title: "Quickstart"
description: "Your first plan review with Plannotator — from agent plan to approval."
sidebar:
  order: 2
section: "Getting Started"
---

Once Plannotator is installed, it works automatically. Here's what a plan review looks like.

## 1. Your agent generates a plan

Ask your agent to do something that requires planning. When the agent reaches its plan handoff point, Plannotator opens the review UI in your browser.

```
Agent proposes a plan
        ↓
Plannotator hook or plugin fires
        ↓
Plannotator reads the plan from stdin
        ↓
Browser opens with the plan review UI
```

Claude Code uses an `ExitPlanMode` hook. Codex uses a `Stop` hook after a plan turn completes. Both flows open Plannotator automatically after installation.

## 2. Review the plan

The plan renders as formatted markdown with syntax-highlighted code blocks. Read through it at your own pace.

## 3. Annotate

Select any text in the plan to open the annotation toolbar. Choose an action:

- **Delete** — Mark text for removal ("Remove this")
- **Comment** — Add feedback on a section ("This needs more detail")
- **Quick label** (⚡) — Apply a preset label like "Clarify this", "Needs tests", or "Out of scope"
- **Looks good** (👍) — Mark a section as approved
- **Copy** — Copy the selected text to your clipboard

You can also add **global comments** — general feedback that isn't tied to specific text.

Need a replacement or an insertion? Just say so in a comment — the agent will handle it.

Switch between annotation modes using the mode switcher at the top of the document:

- **Select** — Click to select text, then choose an annotation type
- **Redline** — Select text to instantly mark it for deletion
- **Comment** — Select text to jump straight to adding a comment

## 4. Approve or request changes

When you're done reviewing:

- **Approve** (`Cmd/Ctrl+Enter` with no annotations) — The agent proceeds through its normal post-plan flow
- **Send Feedback** (`Cmd/Ctrl+Enter` with annotations) — Your annotations are formatted and sent back to the agent, which revises the plan

Your annotations are exported as structured feedback that the agent can act on directly.

## 5. The agent continues

After approval, the agent continues through its native implementation workflow. In interactive Codex, that means Codex can show its normal post-plan implementation prompt. After feedback, the agent revises the plan and presents it again for review. When the revised plan arrives, a diff badge shows what changed — click it to toggle between normal and diff view. The cycle continues until you approve.

## Other commands

Beyond plan review, Plannotator provides slash commands you can use anytime during a session:

- **`/plannotator-review`** — Review uncommitted code changes, or pass a GitHub PR URL to review a pull request. See [Code Review](/docs/commands/code-review/).
- **`/plannotator-annotate <file.md>`** — Annotate any markdown file. See [Annotate](/docs/commands/annotate/).
- **`/plannotator-last`** — Annotate the agent's last message. See [Annotate Last](/docs/commands/annotate-last/).
