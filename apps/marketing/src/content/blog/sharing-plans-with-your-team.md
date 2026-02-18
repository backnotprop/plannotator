---
title: "Sharing Plans With Your Team"
description: "How Plannotator's URL-based sharing lets teammates review and annotate agent plans together — with zero backend, zero accounts, and full privacy."
date: 2026-02-18
author: "backnotprop"
tags: ["sharing", "collaboration", "privacy"]
---

**Plannotator is an open-source plan review UI for AI coding agents.** It intercepts plan mode via hooks, opening a browser-based editor where you can annotate, approve, or reject plans before the agent acts. The sharing feature lets you send a plan — annotations included — to a teammate as a URL. They can review it, add their own feedback, and import it back. No backend stores anything. All data lives in the URL itself.

## Watch the Demo

<iframe width="100%" style="aspect-ratio: 16/9;" src="https://www.youtube.com/embed/a_AT7cEN_9I" title="Plannotator Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

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

Your senior clicks the link. The share portal — a static page with no backend — decompresses the URL hash and renders the plan with your annotations. They can now add their own feedback:

- **Comment** on the migration script section: "Add a rollback step"
- **Replace** the session handling approach: swap JWT for HTTP-only cookies
- **Delete** the unnecessary logging middleware
- **Insert** a note about rate limiting on the new auth endpoints

Each annotation is tied to the specific text it references.

### 4. You import their review

Your senior clicks **Export → Copy Link** to share their annotated version back. You click **Export → Import Review** and paste their URL. Plannotator merges their annotations into your session, deduplicating any overlapping feedback. Now you see both your notes and theirs, with author labels distinguishing who said what.

### 5. You send combined feedback to Claude

With the merged annotations in front of you, you click **Request Changes**. Plannotator formats the combined feedback — deletions, replacements, comments, insertions — into structured markdown and sends it back to Claude Code through the hook system. Claude receives specific, actionable feedback and revises the plan.

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

The sharing system uses no backend. Here's what actually happens when you click "Copy Link":

1. The plan markdown and annotations are serialized into a compact JSON payload
2. The payload is compressed using the browser's native `CompressionStream` with `deflate-raw`
3. The compressed bytes are base64url-encoded
4. The result becomes the URL's hash fragment (the part after `#`)

The hash fragment of a URL is never sent to a server in HTTP requests — that's part of the HTTP specification. The share portal at `share.plannotator.ai` is a static page. It serves the UI, then the browser reads and decompresses the hash client-side. The server sees nothing.

This means:

- **No accounts.** No sign-ups, no OAuth, no tokens.
- **No storage.** Nothing is persisted anywhere. Close the tab and the data exists only in the URL you copied.
- **No tracking.** The share portal has no analytics, no cookies, no telemetry.
- **Self-hostable.** If even a static page hosted by someone else isn't acceptable, you can [self-host the portal](/docs/guides/self-hosting/) and point Plannotator at it with `PLANNOTATOR_SHARE_URL`.

For teams working on proprietary code, this is meaningful. The plan content — which may describe internal architecture, security measures, or business logic — never leaves the URL bar. You share it over whatever channel you already trust (Slack, email, a DM) and the recipient decompresses it locally.

## When to use this

Not every plan needs a second pair of eyes. But some do:

- **Architectural changes** — refactors, new service boundaries, database migrations
- **Security-sensitive work** — auth flows, permission models, encryption changes
- **Onboarding** — a senior reviewing a junior's first few agent-assisted plans to build trust in the workflow
- **Compliance** — regulated industries where changes need documented review trails (combine with [plan saving](/docs/getting-started/configuration/) to disk)

The sharing round-trip adds a review step without leaving the agent workflow. The junior doesn't need to copy-paste a plan into a Google Doc. The senior doesn't need to context-switch into a different tool. It all happens within the same Plannotator session that the hook opened.

## Try it

Install Plannotator as a [Claude Code plugin](/docs/getting-started/installation/), trigger a plan, and click Export → Share. Send the link to a teammate. See what they think.
