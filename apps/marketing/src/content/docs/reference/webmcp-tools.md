---
title: "WebMCP Tools"
description: "The in-page tools Plannotator offers a browser-integrated agent during plan review and annotate sessions."
sidebar:
  order: 60
section: "Reference"
---

Plan review and annotate sessions expose a small set of WebMCP tools to a browser-integrated agent. WebMCP is the W3C WebML Community Group proposal that lets a page register client-side functions (a name, a description, a JSON Schema, and a callback) that the browser's agent can discover and call instead of scraping the DOM. Plannotator is the page the agent is looking at while you review, so its tools give the agent the document, your comments, and a way to comment back, in one structured call each.

## The rule: decisions are human

There is no tool that approves a plan, requests changes, sends feedback, closes the session, stages a file, or marks anything as viewed. The agent reads, comments, and points; you decide from the page, exactly as before. That single rule is why the tools need no confirmation dialogs: nothing an agent can do through them is consequential, and everything it does is visible in the annotations panel and removable.

The agent may edit or remove only the comments it created in the current session. Your comments, and comments posted by other tools, answer `forbidden`.

## What is registered

All tools are registered under the `plannotator.` prefix.

| Tool | What it does |
|---|---|
| `read_document` | The whole situation in one call: the session (mode, whether you are editing, whether you already decided), the document text (windowed at 16,000 characters, cut at a block boundary, with `nextOffset` to continue), an outline with per-section comment counts, every comment with its quote, surrounding context and whether it is new since the agent last read, the other documents you are active on in a folder session, and nudges. Marked read-only and untrusted-content. |
| `add_comments` | One to twenty comments in one call. Each anchors on an exact quote from the text (with a section id to disambiguate), on a section heading, as a reply to an existing comment, or as a document-level note. Returns the created comments with their resolved anchors. Idempotent by `requestId`. |
| `update_comment` | Reword a comment the agent created. |
| `remove_comments` | Withdraw comments the agent created, in batch. |
| `reveal` | Scroll your view to a comment or a section, and in folder sessions open another document first. Returns no content. |
| `nudge_user` | Show you one short, transient message in the page (280 characters), for example "Finished: two comments, nothing blocking, ready for your approval." Not saved, not part of the feedback, dismissible. |
| `list_documents` | Folder sessions only: the document tree with per-document comment counts and what changed since the agent last read each one. |

Every response carries `nudges`: short machine-readable notices computed from state the page already holds, such as `annotations_new` (you added or edited comments since the last read), `replies_new`, `annotations_removed` (you deleted one of the agent's comments, which the agent should treat as resolved), `composer_open` (you are typing right now), `source_stale`, `document_edited`, `page_changed`, `other_document_active`, `truncated`, `pending_unsent`, and `session_decided`.

Comments the agent creates appear in the annotations panel like any other external-tool comment, labeled `browser-agent`. A reply threads under the comment it answers and is exported nested under it, so the coding agent reads the exchange in order.

## Turning the tools off

Settings, General tab, "Agent tools". The row appears only in a browser that exposes WebMCP, and switching it off unregisters every tool for that browser. The choice is stored as a cookie only when you opt out; the default leaves nothing behind.

A small "Agent" marker appears in the header after the first successful tool call in a session, so you know an agent has acted. Nothing appears merely because the browser supports the API.

## Testing locally

The API is in an origin trial in Chrome and Edge. Origin-trial tokens are bound to an origin, and a Plannotator session runs on a random localhost port, so no token can cover it. For local use enable `chrome://flags/#enable-webmcp-testing`, or launch Chrome with `--enable-features=WebMCPTesting`. Agent-embedded browsers ship the API without a flag.

From the page's own console you can inspect what is registered and call a tool the way an agent would:

```js
const tools = await document.modelContext.getTools();
const read = tools.find((t) => t.name === 'plannotator.read_document');
JSON.parse(await document.modelContext.executeTool(read, {}));
```

## What a browser without WebMCP sees

Nothing. Feature detection is one check when the page mounts; when `document.modelContext` is absent, no tool is registered, no interface element is added, no request or timer is created, and no cookie is written. The phase-1 pull request proved this by loading the same session on the previous release and on the new build in a browser without the API and comparing the rendered DOM, the network requests, the console output, the timer registrations, and the cookie jar.

## Security boundaries

Plannotator never registers tools inside the frames it does not own. The raw-HTML annotate viewer keeps its `sandbox="allow-scripts"` iframe with no `allow` attribute, and the live-app iframe delegates no `tools` permission, so a page under review cannot register or impersonate Plannotator's tools; in Chrome both frames answer `NotAllowedError` for `getTools` and `registerTool`. Tool descriptions and nudge messages are fixed strings; document and comment text travel only as data.
