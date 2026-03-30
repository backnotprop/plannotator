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
| `/api/external-annotations/stream` | GET | SSE stream for real-time external annotations |
| `/api/external-annotations` | GET | Snapshot of external annotations (`?since=N` for version gating) |
| `/api/external-annotations` | POST | Add external annotations (single or batch) |
| `/api/external-annotations` | PATCH | Update annotation fields (`?id=`) |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |

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
| `/api/external-annotations/stream` | GET | SSE stream for real-time external annotations |
| `/api/external-annotations` | GET | Snapshot of external annotations (`?since=N` for version gating) |
| `/api/external-annotations` | POST | Add external annotations (single or batch) |
| `/api/external-annotations` | PATCH | Update annotation fields (`?id=`) |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |

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
| `/api/external-annotations/stream` | GET | SSE stream for real-time external annotations |
| `/api/external-annotations` | GET | Snapshot of external annotations (`?since=N` for version gating) |
| `/api/external-annotations` | POST | Add external annotations (single or batch) |
| `/api/external-annotations` | PATCH | Update annotation fields (`?id=`) |
| `/api/external-annotations` | DELETE | Remove by `?id=`, `?source=`, or clear all |

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

## Paste service

Stores compressed plan data for short URL sharing. Runs as a separate service from the plan/review/annotate servers.

Default: `https://plannotator-paste.plannotator.workers.dev` (or self-hosted)

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/paste` | POST | Store compressed plan data, returns `{ id }` |
| `/api/paste/:id` | GET | Retrieve stored compressed data |

### POST `/api/paste`

Body:

```json
{
  "data": "<compressed base64 string>"
}
```

Returns: `{ "id": "aBcDeFgH" }` (201 Created)

Limits: 512KB max payload. Auto-deleted after configured TTL (default: 7 days).

### GET `/api/paste/:id`

Returns:

```json
{
  "data": "<compressed base64 string>"
}
```

Or: `{ "error": "Paste not found or expired" }` (404)

Cached for 1 hour (`Cache-Control: public, max-age=3600`).

## External annotations

Available on all three servers (plan, review, annotate). See the [External Annotations API](/docs/integrations/external-annotations-api/) guide for a full overview.

### POST `/api/external-annotations`

Single annotation:

```json
{
  "source": "eslint",
  "type": "concern",
  "filePath": "src/utils.ts",
  "lineStart": 10,
  "lineEnd": 12,
  "text": "Possible null reference"
}
```

Batch:

```json
{
  "annotations": [
    { "source": "eslint", "type": "concern", "filePath": "src/a.ts", "lineStart": 5, "lineEnd": 5, "text": "Unused variable" },
    { "source": "eslint", "type": "concern", "filePath": "src/b.ts", "lineStart": 12, "lineEnd": 14, "text": "Missing error handling" }
  ]
}
```

Returns: `{ "ids": ["<uuid>", ...] }` (201 Created)

### DELETE `/api/external-annotations`

Remove a single annotation: `DELETE /api/external-annotations?id=<uuid>`

Remove all annotations from a source: `DELETE /api/external-annotations?source=eslint`

Clear all: `DELETE /api/external-annotations`

Returns: `{ "ok": true, "removed": <count> }`
