---
title: "Annotate"
description: "The /plannotator-annotate slash command for annotating markdown files, HTML files, URLs, and folders."
sidebar:
  order: 12
section: "Commands"
---

The `/plannotator-annotate` command opens files, URLs, or folders in the Plannotator annotation UI.

## What you can annotate

| Input | Command | What happens |
|-------|---------|--------------|
| Markdown file | `plannotator annotate README.md` | Opens the file directly |
| Plain-text file | `plannotator annotate config.yaml` | Opens the file directly, rendered as plain text |
| HTML file | `plannotator annotate docs/guide.html` | Renders the HTML directly |
| URL | `plannotator annotate https://docs.stripe.com/api` | Fetches the page, converts to markdown, then opens |
| Local app URL | `plannotator annotate http://localhost:5173` | Opens your running dev app live and annotates it in place |
| Folder | `plannotator annotate ./docs/` | Opens a file browser showing all supported files |

### Supported file types

Beyond `.md`, `.mdx`, `.txt`, `.html`, and `.htm`, annotate accepts common plain-text config and data formats: `.yaml`, `.yml`, `.json`, `.jsonc`, `.json5`, `.toml`, `.ini`, `.cfg`, `.conf`, `.properties`, `.csv`, `.tsv`, `.log`, `.xml`, and `.env.example`. These render exactly like `.txt` — as plain text you can select and annotate.

`.env` is deliberately not supported: it commonly holds secrets, and annotate's version history copies file contents into the data dir (`~/.plannotator/history/`). Use `.env.example` for the secret-free template. Source-code files (`.ts`, `.py`, …) are also excluded — use `plannotator review` for code.

### Slash command (inside an agent session)

```
/plannotator-annotate path/to/file.md
/plannotator-annotate https://docs.stripe.com/api
/plannotator-annotate ./specs/
```

The agent runs `plannotator annotate <arg>` under the hood. The annotation UI opens in the browser. When you submit, feedback is returned to the agent as structured output.

You do not have to pass a bare path. Extra words around a path are fine (`/plannotator-annotate look at docs/spec.md please` opens `docs/spec.md`), and a purely natural-language request (`/plannotator-annotate the aim doc`) hands off to the agent, which works out the file you mean and re-runs the command with a concrete target. If several of your words each name a real file, Plannotator errors and lists the candidates instead of guessing, so name exactly one target per invocation.

### Standalone CLI (outside an agent session)

```bash
plannotator annotate path/to/file.md
plannotator annotate index.html
plannotator annotate https://example.com/docs
plannotator annotate ./docs/
```

Starts a local server, opens the browser, and blocks until you submit. Formatted feedback is printed to stdout.

## Folders

When you pass a folder, Plannotator opens a file browser showing all markdown and HTML files in the directory tree. Click any file to open it in the annotation UI. This is useful for annotating a set of specs, documentation, or your Obsidian vault.

Build output directories like `_site/`, `public/`, `.docusaurus/`, and `node_modules/` are automatically excluded from the file browser.

## URLs

Fetching a URL converts the page to markdown before opening it in the annotation editor. Loopback `http` URLs are the exception: they open your running app live instead, covered in [Local apps](#local-apps) below.

### Jina Reader (default)

By default, URLs are fetched through [Jina Reader](https://jina.ai/reader/) (`r.jina.ai`). Jina handles JavaScript-rendered pages and returns clean, reader-mode markdown. This works well for documentation sites, blog posts, and API references.

Set `JINA_API_KEY` in your environment for higher rate limits (500 req/min vs 20 req/min unauthenticated). Free API keys are available from Jina.

### Direct fetch (`--no-jina`)

If you don't want to use Jina, pass `--no-jina`. Plannotator will fetch the HTML directly and convert it with Turndown. This is useful for pages behind authentication, internal docs, or when you just prefer not to route through a third-party service.

```bash
plannotator annotate https://internal.company.com/docs --no-jina
```

### .md and .mdx URLs

URLs ending in `.md` or `.mdx` are fetched as raw text with no conversion. If the server returns HTML instead (like GitHub's rendered markdown viewer), Plannotator falls through to Jina or Turndown automatically.

### Local and private URLs

URLs pointing to `localhost`, `127.x.x.x`, `10.x.x.x`, `192.168.x.x`, and other private or link-local addresses always use direct fetch. Jina is skipped automatically since it can't reach private networks.

Loopback `http` URLs are a special case: they open the running app live instead of converting it. See [Local apps](#local-apps) below.

### Configuring Jina

Three ways to disable Jina Reader, in priority order:

1. **CLI flag:** `--no-jina`
2. **Environment variable:** `PLANNOTATOR_JINA=0` or `PLANNOTATOR_JINA=false`
3. **Config file:** `~/.plannotator/config.json` with `{ "jina": false }`

If none of these are set, Jina is enabled by default.

## Local apps

Point annotate at a dev server and you annotate the running app itself, not a snapshot of it:

```bash
plannotator annotate http://localhost:5173
plannotator annotate http://localhost:3000/admin?tab=2
```

Plannotator probes the URL first (a 3 second `GET` asking for HTML). If the app answers with an HTML page, the session opens live: your app is served through a local reverse proxy and rendered full-viewport, with hot module reload and WebSockets passed through, so the app keeps working while you annotate it. Client-side navigation is supported within a single session, and each annotation records the page it was made on.

"Loopback" means `localhost`, `::1`, or a literal address in `127.0.0.0/8`. A hostname that merely looks local, such as `127.0.0.1.evil.example`, does not qualify.

### When it falls back

If the probe does not return an HTML page from the same loopback origin, Plannotator quietly falls back to converting the page, exactly as it always did. That covers an unreachable or slow server, a non-HTML response such as a JSON endpoint, a `5xx` status, and a redirect that leaves the app's own origin (an auth portal, or a different local port). A `404` or `401` that still returns HTML is live-eligible, so a login page opens live.

### `--static` and `--app`

| Flag | Effect |
|------|--------|
| `--static` | Skip the probe and convert the page, the classic behavior |
| `--app` | Require a live session, and fail loudly instead of falling back |

`--app` does not skip the probe. It turns each of the quiet fallbacks above into a clear error: a non-URL target, a non-loopback URL, an `https` URL, an unreachable app, an off-origin redirect, or a non-HTML response. These exit `1`, or `2` under a strict gate (`--require-approval` / `--result-file`), like any other annotate startup failure. The two flags are mutually exclusive.

Live app annotation runs on the standalone CLI, the Claude Code slash command, and the Pi extension's `/plannotator-annotate` command, with the same probe, flags, and fallbacks everywhere. On OpenCode, URL targets still convert to markdown.

### Annotating a live app

Live app and HTML sessions share one interaction model:

- The session opens with the pen **armed**, so a click pins the element under the cursor and a drag selects text to comment on.
- `Esc` steps back one rung at a time: it closes an open draft, then clears the hover outline, then drops you into **Interact** mode, where clicks, forms, links, and navigation reach the page normally.
- The pen button in the header (or `Cmd/Ctrl+Shift+A`) arms annotation again. Existing comment markers stay visible in both modes, and clicking one still opens it.
- Selecting text to comment works in **both** modes, so you can leave a note without arming the pen.
- These surfaces are comment-only: deletions and quick labels are markdown-only features.
- The eye button beside the pen hides every floating control over the page when you need an unobstructed view.

### Limits

Live sessions have no version history, no URL sharing, no portable HTML export, and no agent terminal, matching URL sessions. Drafts, feedback, approval, and gates all work normally. Live mode is unavailable in remote mode and in `--tailscale` sessions; use `--static` there. Apps that bust out of frames, pin absolute origins, or send you through an off-origin OAuth redirect will not stay inside the proxy.

## HTML files

Local `.html` and `.htm` files are read from disk and rendered as HTML by default. If you want Plannotator to convert the file to markdown first, pass `--markdown`.

```bash
plannotator annotate docs/guide.html --markdown
```

Markdown conversion uses [Turndown](https://github.com/mixmark-io/turndown) with GFM table support. `<script>`, `<style>`, and `<noscript>` tags are stripped before conversion.

HTML files must be within your current working directory. Files outside the project root return a 403 error.

### `--markdown`

For local HTML files, `--markdown` switches from raw HTML rendering to markdown conversion. In folder mode, the same setting applies when you open `.html` or `.htm` files from the file browser.

## Source badge

When annotating an HTML file or URL (not plain markdown), a small badge appears under the document title showing where the content came from. For URLs it shows the hostname (e.g. "stripe.com"). For HTML files it shows the filename (e.g. "guide.html").

## Annotate mode differences

The annotation UI in annotate mode works the same as plan review, with a few changes:

- The "Approve" button is hidden by default (there's nothing to approve for most use cases). Pass `--gate` to enable it as a review decision.
- "Send Feedback" becomes **"Send Annotations"**
- `Cmd/Ctrl+Enter` sends annotations instead of approving
- The completion screen says "Annotations Sent" instead of "Plan Approved"

All annotation types work identically: deletions, comments, global comments, quick labels, "looks good" approvals, and image attachments. HTML and live app surfaces are the exception: they are comment-only, so deletions and quick labels are unavailable there, though deletions saved earlier still restore.

## Flags

Three opt-in flags turn annotate into a review gate for hook integrations (spec-driven frameworks, turn-by-turn review, and so on). They compose: use any alone or combine them.

### `--gate`

Adds a third **Approve** button to the UI. The reviewer now has three exits:

- **Approve** — the artifact looks good; the agent should proceed.
- **Send Annotations** — changes requested; feedback goes back to the agent.
- **Close** — dismissed without deciding.

### `--json`

Switches stdout to a structured decision object so hooks can route programmatically:

```json
{ "decision": "approved" | "annotated" | "dismissed", "feedback": "..." }
```

`feedback` is present for `annotated` decisions, and for `approved` decisions when the reviewer approved with notes (`--gate --json` only). Approval notes are non-blocking guidance — they are not a request for another revision.

### `--hook`

Emits hook-native JSON that works directly with Claude Code and Codex PostToolUse/Stop hook protocols. Implies `--gate` (always three-button UX). Approve and Close emit empty stdout (hook passes), Send Annotations emits `{"decision":"block","reason":"<feedback>"}` (hook blocks with feedback).

This is the recommended flag for hook integrations. If both `--hook` and `--json` are passed, `--hook` wins.

### Stdout matrix

| Flags | UX | Approve | Close | Send Annotations |
|---|---|---|---|---|
| *(none)* | 2-button | n/a | empty | feedback (plaintext) |
| `--gate` | 3-button | `The user approved.` | empty | feedback (plaintext) |
| `--json` | 2-button | n/a | `{"decision":"dismissed"}` | `{"decision":"annotated","feedback":"..."}` |
| `--gate --json` | 3-button | `{"decision":"approved"}`, or `{"decision":"approved","feedback":"..."}` when approved with notes | `{"decision":"dismissed"}` | `{"decision":"annotated","feedback":"..."}` |
| `--hook` | 3-button | empty | empty | `{"decision":"block","reason":"..."}` |

**Key property:** `--gate` plaintext output is unambiguous across three decisions. Use `--json` when you want machine-readable decision objects. Use `--hook` when wiring into Claude Code or Codex hooks directly.

On OpenCode and Pi, `--json` and `--hook` are silently accepted because those harnesses write back into the session directly rather than via stdout. The `--gate` flag behaves identically across all three harnesses.

See [Hook integration recipes](/docs/guides/hook-integration/) for ready-to-use PostToolUse and Stop hook examples.

## Feedback format

When you send annotations, they're exported as structured markdown:

```markdown
# Plan Feedback

I've reviewed this plan and have 2 pieces of feedback:

## 1. Remove this
` ` `
the selected text
` ` `
> I don't want this in the plan.

## 2. Feedback on: "some highlighted text"
> This needs more detail about error handling.

---
```

The agent receives this and can act on each annotation.

## Server API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/plan` | GET | Returns `{ plan, mode: "annotate", filePath, sourceInfo, gate }` |
| `/api/feedback` | POST | Submit annotations |
| `/api/approve` | POST | Approve without feedback (`--gate` UX) |
| `/api/exit` | POST | Close session without feedback |
| `/api/image` | GET | Serve image by path |
| `/api/upload` | POST | Upload image attachment |
| `/api/draft` | GET/POST/DELETE | Auto-save annotation drafts |

## Environment variables

The annotate server respects the same environment variables as plan review, plus two specific to URL annotation:

| Variable | Default | Description |
|----------|---------|-------------|
| `PLANNOTATOR_JINA` | enabled | Set to `0` or `false` to disable Jina Reader for URL annotation. |
| `JINA_API_KEY` | (none) | Optional Jina Reader API key for higher rate limits (500 RPM vs 20 RPM). |

See the [environment variables reference](/docs/reference/environment-variables/) for all options.
