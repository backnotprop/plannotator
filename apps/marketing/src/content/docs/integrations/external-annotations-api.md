---
title: "External Annotations API"
description: "Push annotations from external tools into a live Plannotator session via HTTP."
sidebar:
  order: 40
section: "Integrations"
---

External programs (linters, AI tools, security scanners, custom scripts) can push annotations into a live Plannotator session over HTTP. Annotations appear in the browser in real-time, tagged with their source, alongside any user-created annotations.

## How it works

```
External tool (eslint, AI agent, etc.)
        ↓ POST /api/external-annotations
Local Plannotator server (in-memory store)
        ↓ SSE broadcast
Browser UI - annotation appears in real-time
```

Annotations are stored in an in-memory store on the local Plannotator server. Connected browsers receive updates instantly via Server-Sent Events. If SSE isn't available (e.g., proxy environments), the client automatically falls back to polling. Annotations persist for the session lifetime.

When the user submits feedback (approve, deny, or send), external annotations are included in the exported feedback alongside user-created ones.

## Quick start

Find the port number in your terminal output when Plannotator starts (e.g., `Server running on http://localhost:54321`).

**Plan review** - annotate a text selection:

```bash
curl -X POST http://localhost:PORT/api/external-annotations \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "my-tool",
    "type": "COMMENT",
    "originalText": "the selected text in the plan",
    "text": "This needs attention"
  }'
```

**Code review** - annotate a code location:

```bash
curl -X POST http://localhost:PORT/api/external-annotations \
  -H 'Content-Type: application/json' \
  -d '{
    "source": "eslint",
    "type": "concern",
    "filePath": "src/utils.ts",
    "lineStart": 10,
    "lineEnd": 12,
    "text": "Possible null reference"
  }'
```

The `source` field identifies the tool and appears as a badge in the UI. The server returns `{ "ids": ["<uuid>"] }` on success.

## API at a glance

| Method | Endpoint | What it does |
|--------|----------|--------------|
| GET | `/api/external-annotations/stream` | SSE stream (real-time updates) |
| GET | `/api/external-annotations` | JSON snapshot (polling fallback, `?since=N` for version gating) |
| POST | `/api/external-annotations` | Add one or many annotations |
| PATCH | `/api/external-annotations?id=` | Update an annotation's fields |
| DELETE | `/api/external-annotations?id=` | Remove by id, `?source=` by tool, or clear all |

See [API Endpoints](/docs/reference/api-endpoints/) for full request/response details.

## Batch annotations

To send multiple annotations at once, wrap them in an `annotations` array:

```bash
curl -X POST http://localhost:PORT/api/external-annotations \
  -H 'Content-Type: application/json' \
  -d '{
    "annotations": [
      { "source": "eslint", "type": "concern", "filePath": "src/a.ts", "lineStart": 5, "lineEnd": 5, "text": "Unused variable" },
      { "source": "eslint", "type": "concern", "filePath": "src/b.ts", "lineStart": 12, "lineEnd": 14, "text": "Missing error handling" }
    ]
  }'
```

Returns `{ "ids": ["<uuid1>", "<uuid2>"] }`.

## Try the sandbox

The repo includes a test script that starts a sandbox review server and sends timed waves of annotations so you can see them arrive in real-time:

```bash
bun run tests/manual/test-external-annotations.ts
```

This opens a browser with a sample diff and sends 6 waves over ~17 seconds: single annotations, batches, deletes, and source-level clears. Watch the annotation panel to see them appear, update, and disappear.

## Available in all modes

The external annotations API is available in plan review, code review, and annotate mode. The endpoint surface is identical across all three. Only the annotation shape differs (plan annotations use `originalText` and `blockId`; code review annotations use `filePath`, `lineStart`, `lineEnd`, and `side`).
