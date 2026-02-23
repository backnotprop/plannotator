---
title: "Quickstart"
description: "Your first plan review with Plannotator — from ExitPlanMode to approval."
sidebar:
  order: 2
section: "Getting Started"
---

Once Plannotator is installed, it works automatically. Here's what a plan review looks like.

## 1. Claude generates a plan

Ask Claude to do something that requires planning. When Claude calls `ExitPlanMode`, the Plannotator hook intercepts the request and opens the review UI in your browser.

```
Claude calls ExitPlanMode
        ↓
PermissionRequest hook fires
        ↓
Plannotator reads the plan from stdin
        ↓
Browser opens with the plan review UI
```

## 2. Review the plan

The plan renders as formatted markdown with syntax-highlighted code blocks. Read through it at your own pace.

## 3. Annotate

Select any text in the plan to open the annotation toolbar. Choose an action:

- **Delete** — Mark text for removal ("Remove this")
- **Replace** — Suggest replacement text ("Change this to...")
- **Comment** — Add feedback on a section ("This needs more detail")
- **Insert** — Add new content after the selection ("Add error handling here")

You can also add **global comments** — general feedback that isn't tied to specific text.

Switch between annotation modes using the mode switcher at the top of the document:

- **Select** — Click to select text, then choose an annotation type
- **Redline** — Select text to instantly mark it for deletion
- **Comment** — Select text to jump straight to adding a comment

## 4. Approve or request changes

When you're done reviewing:

- **Approve** (`Cmd/Ctrl+Enter` with no annotations) — Claude proceeds with implementation
- **Send Feedback** (`Cmd/Ctrl+Enter` with annotations) — Your annotations are formatted and sent back to Claude, who revises the plan

Your annotations are exported as structured feedback that Claude can act on directly.

## 5. Claude continues

After approval, Claude implements the plan. After feedback, Claude revises the plan and presents it again for review. When the revised plan arrives, a diff badge shows what changed — click it to toggle between normal and diff view. The cycle continues until you approve.
