---
title: "API Endpoints"
description: "Server API reference for plan review, code review, and annotation servers."
sidebar:
  order: 32
section: "Reference"
---

Plannotator runs a local Bun HTTP server for each session. The server serves the UI and exposes a REST API for communication between the browser and the CLI.

All servers use random ports locally or a fixed port (`19432` by default) in remote mode.

## Plan server

Used during plan review (`ExitPlanMode` hook).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan` | GET | Returns the plan and session info |
| `/api/approve` | POST | Approve the plan |
| `/api/deny` | POST | Deny the plan with feedback |
| `/api/image` | GET | Serve a local image by path query param |
| `/api/upload` | POST | Upload an image, returns `{ path, originalName }` |
| `/api/obsidian/vaults` | GET | Detect available Obsidian vaults |
| `/api/save-notes` | POST | Save plan to Obsidian/Bear on demand |

### GET `/api/plan`

Returns:

```json
{
  "plan": "# Implementation Plan...",
  "origin": "claude-code",
  "sharingEnabled": true,
  "shareBaseUrl": "https://share.plannotator.ai",
  "repoInfo": { "display": "my-project", "branch": "main" }
}
```

### POST `/api/approve`

Body:

```json
{
  "permissionMode": "bypassPermissions",
  "agentSwitch": "claude-3-5-sonnet",
  "planSave": { "enabled": true, "customPath": null },
  "obsidian": { "vaultPath": "/path/to/vault", "folder": "plannotator", "plan": "..." },
  "bear": { "plan": "..." },
  "feedback": "optional annotations if present"
}
```

### POST `/api/deny`

Body:

```json
{
  "feedback": "# Plan Feedback\n\nI've reviewed this plan...",
  "planSave": { "enabled": true }
}
```

## Review server

Used during code review (`/plannotator-review`).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/diff` | GET | Returns the diff and session info |
| `/api/feedback` | POST | Submit review feedback |
| `/api/image` | GET | Serve a local image by path |
| `/api/upload` | POST | Upload an image attachment |

### GET `/api/diff`

Returns:

```json
{
  "rawPatch": "diff --git a/file.ts...",
  "gitRef": "abc1234",
  "origin": "claude-code"
}
```

### POST `/api/feedback`

Body:

```json
{
  "feedback": "formatted review feedback",
  "annotations": [],
  "agentSwitch": "optional-agent-name"
}
```

## Annotate server

Used during file annotation (`/plannotator-annotate`).

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan` | GET | Returns the file content in annotate mode |
| `/api/feedback` | POST | Submit annotation feedback |
| `/api/image` | GET | Serve a local image by path |
| `/api/upload` | POST | Upload an image attachment |

### GET `/api/plan`

Returns:

```json
{
  "plan": "# File contents...",
  "origin": "claude-code",
  "mode": "annotate",
  "filePath": "/absolute/path/to/file.md"
}
```

### POST `/api/feedback`

Body:

```json
{
  "feedback": "formatted annotation feedback",
  "annotations": []
}
```
