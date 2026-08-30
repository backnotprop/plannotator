---
name: plannotator-markup
disable-model-invocation: true
description: >
  Answer with markup on the document instead of prose in chat. Opens the user's
  markdown, text, config, or HTML file in a live Plannotator annotate session and
  posts your response into it as inline comments and strikethrough edits pinned to
  the exact phrases they concern. Use when the user asks you to annotate, mark up,
  redline, or comment on a document they already have — anything where naming a
  section number ("as noted in 3.1") would force them to cross-reference your
  reply against the file by hand.
---

# Plannotator Markup

Your response becomes annotations on the user's document, not chat prose.

This skill is only the mechanics of driving Plannotator. What to say about the
document is decided by the request you were given, not here.

## When not to use this

- One or two remarks — just say them in chat; a browser session is heavier than the feedback.
- Source code — use `plannotator review` instead (`annotate` refuses code files).
- The user wants you to *edit* the file — edit it. This surface proposes; it does not write.

## Flow

1. Launch the session in the background.
2. Read the document back from the session.
3. POST your annotations.
4. Tell the user the session is open.
5. Wait for the process to exit and act on what it returns.

### 1. Launch in the background

```bash
plannotator annotate <path-or-url>
```

**Never run this in the foreground.** It blocks until the human decides, so a
foreground call leaves you unable to post anything into the session you just
started. In Claude Code, use Bash with `run_in_background: true`; elsewhere
append `&`.

**Browser session patience rule:** the session is driven by a human in a
browser and can stay open for minutes. Keep waiting until they submit, dismiss,
or tell you to stop. Do not kill, restart, or open a second copy because the UI
looks idle — a session that ends without a decision reads as no feedback.

### 2. Get the base URL

```bash
plannotator sessions 2>&1 | grep -oE 'http://[^[:space:]]+' | head -1
```

`plannotator sessions` writes to **stderr**, not stdout. Without `2>&1` you get
nothing. Do not set `PLANNOTATOR_PORT` to work around this; the port is already
discoverable.

With several sessions running, take the row whose second column is `annotate`,
then confirm you have the right one — `GET /api/plan` returns `filePath`:

```bash
curl -s "$BASE/api/plan" | jq -r .filePath
```

### 3. Read the document

```bash
curl -s "$BASE/api/plan" | jq -r .plan
```

Read it from the session, not from disk. Annotations are pinned by matching
`originalText` as a **verbatim substring of this text** — there are no line
numbers to reference. Copy phrases out of this output exactly; a single
character of drift and the annotation silently degrades to a sidebar entry with
no highlight.

### 4. POST the annotations

```bash
curl -s -X POST "$BASE/api/external-annotations" \
  -H 'Content-Type: application/json' \
  -d '{"annotations": [
    {"source": "claude-code", "author": "Claude", "type": "COMMENT",
     "originalText": "<verbatim phrase from the document>",
     "text": "<what you have to say about that phrase>"},
    {"source": "claude-code", "author": "Claude", "type": "DELETION",
     "originalText": "<verbatim phrase to strike through>",
     "text": "<ignored — see below>"},
    {"source": "claude-code", "author": "Claude", "type": "GLOBAL_COMMENT",
     "text": "<remark about the document as a whole>"}
  ]}'
```

Pick the longest unambiguous `originalText` you can. A short one may match
somewhere you did not intend; the match is plain substring search, first hit
wins.

`201 {"ids": [...]}` on success, `400 {"error": "..."}` on validation failure.
Each POST is live the instant it lands; there is no send step. Batch them in one
call rather than firing one request per remark.

| Field | Required | Notes |
|---|---|---|
| `source` | always | Stable identifier for you. Reuse the same value for every annotation in a session — it is how you clean up your own on a re-run. |
| `text` | always | Non-empty, or `400`. Ignored for `DELETION` (see below). |
| `type` | always | `COMMENT` (inline), `DELETION` (strikethrough), `GLOBAL_COMMENT` (sidebar only). |
| `originalText` | `COMMENT`, `DELETION` | Verbatim substring of the document. A `COMMENT` without it is `400`; use `GLOBAL_COMMENT` for remarks that belong to no phrase. |
| `author` | no | Label shown beside the annotation. |

**`DELETION` carries no message.** The exported feedback says "I don't want
this in the file" and drops your `text` entirely. It means *delete this*,
nothing more. To propose a replacement, post a `COMMENT` with the rewrite in
`text` — either instead of the `DELETION`, or alongside it on the same phrase
when you want both the strikethrough and the reasoning.

#### Referring to another section

To point at a different section from inside a comment, write `#` immediately
followed by that heading's text, copied verbatim:

```
#3.1 Single source of truth contradicts this.
```

The heading text becomes a link that scrolls the reader to it. Resolution is
exact match against the document's own headings, so a title you paraphrase or
misremember silently stays plain text — copy it from the `/api/plan` output like
any other quote. A heading whose text is used twice never resolves.

`#` with a space after it, a `#` welded to a word (`C#`), and anything that
matches no heading (`#fff`, `#123`) all stay plain text.

Prefer this over a bare number even when the document is numbered: the full
heading text still reads correctly if the link ever fails to resolve, and `3.1`
alone does not.

### 5. Hand it over and wait

Tell the user the session is open and where, in one line. Then wait for the
background process to exit and read its stdout:

- Empty — they closed the tab. No feedback; say so briefly and move on.
- Text — their reply, including any of your annotations they kept. Act on it.

Add `--json` at launch if you want `{"decision": "...", "feedback": "..."}`
instead of prose. An `approved` decision can still carry notes in `feedback`:
treat those as guidance, not a change request.

## Re-running on the same session

Delete your own annotations before reposting, or they accumulate:

```bash
curl -s -X DELETE "$BASE/api/external-annotations?source=claude-code"
```

Returns `{"ok": true, "removed": N}`. Scoped by `source`, so it never touches
the human's own annotations or another tool's. `PATCH ?id=<id>` edits one in
place if you only need to revise a single remark.

## Do not

- Do not run `plannotator annotate` in the foreground; you will not be able to post.
- Do not write a bare section number ("as noted in 3.1") in `text`. It is inert, and it hands the reader the cross-referencing work this surface exists to remove. Use a `#` reference instead (step 4).
- Do not put a suggested replacement in a `DELETION`'s `text`. It is discarded.
- Do not post into a session over a network — remote and `--tailscale` sessions expose this API to peers, and it has no authentication.
- Do not scrape the browser UI. `/api/plan`, `/api/external-annotations`, and the process stdout are the whole contract.
- Do not clear annotations without a `source` filter; a bare `DELETE` wipes the human's too.
