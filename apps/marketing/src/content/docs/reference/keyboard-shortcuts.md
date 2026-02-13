---
title: "Keyboard Shortcuts"
description: "All keyboard shortcuts available in the Plannotator UI."
sidebar:
  order: 31
section: "Reference"
---

Keyboard shortcuts available in the Plannotator plan review, code review, and annotation UIs.

## Global shortcuts

| Shortcut | Context | Action |
|----------|---------|--------|
| `Cmd/Ctrl+Enter` | Plan review (no annotations) | Approve plan |
| `Cmd/Ctrl+Enter` | Plan review (with annotations) | Send feedback |
| `Cmd/Ctrl+Enter` | Code review | Send feedback / Approve |
| `Cmd/Ctrl+Enter` | Annotate mode | Send annotations |
| `Cmd/Ctrl+S` | Any mode (with API) | Quick save to default notes app |
| `Escape` | Annotation toolbar | Close toolbar |

## Notes

- `Cmd/Ctrl+Enter` is blocked when a modal or dialog is open (export, import, confirm dialogs, image annotator)
- `Cmd/Ctrl+Enter` is blocked when typing in an input or textarea
- `Cmd/Ctrl+S` opens the Export modal if no default notes app is configured
- `Escape` in the annotation toolbar closes it without creating an annotation
