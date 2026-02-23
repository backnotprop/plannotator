---
title: "Plan Review"
description: "The core plan review flow — how Plannotator intercepts ExitPlanMode and presents the annotation UI."
sidebar:
  order: 10
section: "Commands"
---

Plan review is the core Plannotator workflow. It's not a slash command — it fires automatically when your agent calls `ExitPlanMode`.

## How it works

```
Claude calls ExitPlanMode
        ↓
PermissionRequest hook fires (hooks.json matcher: "ExitPlanMode")
        ↓
Bun server reads plan from stdin JSON (tool_input.plan)
        ↓
Server starts on random port, opens browser
        ↓
User reviews plan, optionally adds annotations
        ↓
Approve → agent proceeds with implementation
Deny    → annotations sent as structured feedback
        ↓
Agent resubmits → Plan Diff shows what changed
```

The hook configuration lives at `apps/hook/hooks/hooks.json` and matches the `ExitPlanMode` tool name.

## Annotation types

When you select text in the plan, the annotation toolbar appears with these options:

| Type | What it does | Example |
|------|-------------|---------|
| **Deletion** | Marks text for removal | "Remove this section" |
| **Replacement** | Suggests alternative text | "Change `WebSocket` to `SSE`" |
| **Comment** | Adds feedback on a section | "This needs error handling" |
| **Insertion** | Adds content after the selection | "Add a retry mechanism here" |
| **Global comment** | General feedback (not tied to text) | "The plan looks good overall but needs tests" |

## Image attachments

You can paste or upload images and attach them to annotations. Images are given human-readable names (e.g., "login-mockup") and referenced in the exported feedback. This is useful for sharing mockups, screenshots, or diagrams alongside your annotations.

To attach an image:
1. Copy an image to your clipboard
2. Paste anywhere in the Plannotator UI
3. Optionally draw on the image to highlight areas
4. Name the image and confirm

Images are stored as temporary files and referenced by name in the feedback sent to your agent.

## Approval flow

**Approve** (no annotations):
- Click "Approve" or press `Cmd/Ctrl+Enter`
- Optionally saves plan to disk or Obsidian/Bear
- Agent proceeds with implementation

**Approve with annotations** (Claude Code):
- Claude Code doesn't yet support feedback on approval
- A warning dialog explains that annotations will be lost
- Use "Send Feedback" instead to include your annotations

**Approve with annotations** (OpenCode):
- OpenCode supports "approve with notes"
- Annotations are included in the approval response

**Send Feedback** (with annotations):
- Click "Send Feedback" or press `Cmd/Ctrl+Enter`
- Annotations are exported as structured markdown
- Agent receives feedback and revises the plan

## Agent switching (OpenCode)

OpenCode users can configure which agent receives the approved plan. Set this in Settings — choose from available agents or enter a custom agent name. If the configured agent isn't found, Plannotator shows a warning before approval.

## Server API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan` | GET | Returns `{ plan, origin }` |
| `/api/approve` | POST | Approve plan |
| `/api/deny` | POST | Deny plan with feedback |
| `/api/image` | GET | Serve image by path |
| `/api/upload` | POST | Upload image attachment |
| `/api/obsidian/vaults` | GET | Detect Obsidian vaults |
