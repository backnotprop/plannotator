---
title: "Sharing Plans With Your Team"
description: "How Plannotator's legacy URL sharing handles hash links, encrypted short links, and teammate annotations."
date: 2026-02-18
author: "backnotprop"
tags: ["sharing", "collaboration", "privacy"]
---

> **Status update, July 31, 2026:** Open source asynchronous link sharing remains available for compatibility but is moving to deprecated support. [Workspaces](/workspaces/) is the primary direction for team sharing. No removal date has been announced.

**Plannotator is an open-source plan review UI for AI coding agents.** It intercepts plan mode via hooks, opening a browser-based editor where you can annotate, approve, or reject plans before the agent acts. The sharing feature lets you send a plan, including annotations, to a teammate as a URL. They can review it, add their own feedback, and import it back. Small markdown shares put compressed content in the URL fragment. Larger markdown and raw HTML shares can use encrypted short links backed by a paste service.

## Watch the Demo

<iframe width="100%" style="aspect-ratio: 16/9;" src="https://www.youtube-nocookie.com/embed/a_AT7cEN_9I" title="Plannotator Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

## The scenario

You're a junior developer. Claude Code just generated a plan to refactor the authentication module — new middleware, updated route guards, a migration script. It's a big change. You want a second opinion before you approve it.

With Plannotator, this is straightforward.

### 1. The plan lands in your browser

When Claude calls `ExitPlanMode`, Plannotator's hook intercepts it. Instead of a terminal prompt asking "Do you want to proceed?", a full review UI opens in your browser. You can read through the plan, see each section rendered as markdown, and start annotating.

### 2. You share the plan

You click **Export → Share → Copy Link**. Plannotator compresses the plan markdown and any annotations you've made into a URL hash fragment. The resulting link looks something like:

```
https://share.plannotator.ai/#eNqrVkrOz0nV...
```

You paste this in Slack and send it to your senior teammate.

### 3. Your senior reviews and annotates

Your senior clicks the link. The static share portal decompresses the URL fragment in the browser and renders the plan with your annotations. No backend stores this hash-share payload, although the portal host receives an ordinary page request. They can now add their own feedback:

- **Comment** on the migration script section: "Add a rollback step"
- **Comment** on the session handling approach: "Swap JWT for HTTP-only cookies"
- **Delete** the unnecessary logging middleware
- **Quick label** the auth endpoints with "Needs tests" and add a comment: "Document rate limiting here"

Each annotation is tied to the specific text it references.

### 4. You import their review

Your senior clicks **Export → Copy Link** to share their annotated version back. You click **Export → Import Review** and paste their URL. Plannotator merges their annotations into your session, deduplicating any overlapping feedback. Now you see both your notes and theirs, with author labels distinguishing who said what.

### 5. You send combined feedback to Claude

With the merged annotations in front of you, you click **Request Changes**. Plannotator formats the combined feedback — deletions, comments, global comments, quick labels, and "looks good" approvals — into structured markdown and sends it back to Claude Code through the hook system. Claude receives specific, actionable feedback and revises the plan.

## How the hook integration works

Plannotator plugs into Claude Code's `PermissionRequest` hook system. The configuration in `hooks.json` watches for `ExitPlanMode` events:

```json
{
  "hooks": {
    "PermissionRequest": [
      {
        "matcher": "ExitPlanMode",
        "hooks": [
          {
            "type": "command",
            "command": "plannotator",
            "timeout": 345600
          }
        ]
      }
    ]
  }
}
```

When the hook fires, Plannotator reads the plan content from stdin, starts a local HTTP server, and opens the review UI. The server exposes a `/api/plan` endpoint that the browser fetches, and `/api/approve` or `/api/deny` endpoints that resolve the hook's decision. Approving sends an `allow` decision back to Claude Code. Denying sends a `deny` decision with the formatted annotation feedback as the message.

The feedback that reaches Claude is structured — not a vague "make it better" but specific line-level annotations:

```markdown
## 1. Change this
**From:**
> JWT token stored in localStorage
**To:**
> HTTP-only cookie with secure flag

## 2. Feedback on: "logging middleware for all routes"
> This is unnecessary overhead. Only log auth-related routes.

## 3. Add this
> Add a database rollback step before the migration runs.
```

Claude can act on each item directly.

## Why URL-based sharing matters

For a small markdown share, no backend stores the shared payload. Here's what happens when you click "Copy Link":

1. The plan markdown and annotations are serialized into a compact JSON payload
2. The payload is compressed using the browser's native `CompressionStream` with `deflate-raw`
3. The compressed bytes are base64url-encoded
4. The result becomes the URL's hash fragment (the part after `#`)

Browsers do not include a URL fragment in HTTP requests. The share portal at `share.plannotator.ai` serves the static UI, then the browser reads and decompresses the fragment. The portal host still receives normal request metadata such as an IP address and user agent, and the UI makes Plannotator's release check against GitHub. Neither request includes the shared plan or annotations.

This means:

- **No accounts.** No sign-ups, no OAuth, no tokens.
- **No payload storage for small markdown shares.** Shared content stays in the URL fragment. It is compressed, not encrypted.
- **Client-encrypted short links.** When markdown is too large for a URL, or when you share raw HTML, the browser encrypts the payload with AES-256-GCM before uploading. The paste service stores ciphertext, while the decryption key stays in the URL fragment rather than the HTTP request. Hosted ciphertext expires after 7 days.
- **No Plannotator analytics or telemetry.** Functional cookies can remember settings and a dismissed update notice.
- **Self-hostable.** You can [self-host the portal](/docs/guides/self-hosting/) and point Plannotator at it with `PLANNOTATOR_SHARE_URL`.

The complete link contains either the readable compressed payload or the short-link decryption key. Anyone with the link can read the shared content. Slack, email, a ticketing system, or another delivery service can also retain the full URL, so use only a channel you trust with that content.

## When to use this

Not every plan needs a second pair of eyes. But some do:

- **Architectural changes** — refactors, new service boundaries, database migrations
- **Security-sensitive work** — auth flows, permission models, encryption changes
- **Onboarding** — a senior reviewing a junior's first few agent-assisted plans to build trust in the workflow
- **Compliance** — regulated industries where changes need documented review trails (combine with [plan saving](/docs/getting-started/configuration/) to disk)

The legacy sharing round-trip adds a review step without leaving the agent workflow. For ongoing team collaboration, Workspaces is the primary direction.

## Try it

Install Plannotator as a [Claude Code plugin](/docs/getting-started/installation/), trigger a plan, and click Export → Share. Send the link to a teammate. See what they think.
