---
title: "Local Diff Review for Coding Agents"
description: "How Plannotator's /plannotator-review command gives you a browser-based diff viewer to annotate agent-generated code changes and send structured feedback back to the session."
date: 2026-02-19
author: "backnotprop"
tags: ["code-review", "diff", "hooks"]
---

**Plannotator is an open-source review UI for AI coding agents.** Beyond plan review, it includes a full code review workflow. Run `/plannotator-review` and a browser-based diff viewer opens with your uncommitted changes — file tree, split or unified diffs, line-level annotations. When you're done, your feedback goes directly back to the agent session as structured markdown. No copy-pasting. No context switching.

## Watch the Demo

<iframe width="100%" style="aspect-ratio: 16/9;" src="https://www.youtube.com/embed/a_AT7cEN_9I" title="Plannotator Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

## The scenario

You asked Claude Code to add input validation to your API endpoints. It ran for a few minutes, touched eight files, and now you have a pile of uncommitted changes. You could scroll through `git diff` in the terminal. But the output is flat — no file navigation, no way to comment on specific lines, and if you want to tell the agent "this part is wrong", you're typing freeform into the chat.

With Plannotator, you run a slash command instead.

### 1. You run the command

Type `/plannotator-review` in your Claude Code session. Behind the scenes, the slash command calls `plannotator review`, which does three things: captures `git diff HEAD` (all uncommitted changes), starts a local HTTP server, and opens a review UI in your browser.

### 2. The diff viewer opens

The browser loads a full diff interface. On the left, a file tree shows every changed file with `+`/`-` line counts. On the right, the diff renders with syntax highlighting — split view (old and new side-by-side) or unified view (interleaved), your choice.

You can navigate files by clicking, or use `j`/`k` keys to move through the list. Each file has a "viewed" checkbox you can tick as you go, with a progress indicator showing how many files you've reviewed.

### 3. You switch diff types

The file tree includes a dropdown to change what you're looking at. The default is "Uncommitted changes" (`git diff HEAD`), but you can switch to:

- **Last commit** — `git diff HEAD~1..HEAD` if the agent already committed
- **vs main** — `git diff main..HEAD` to see everything on the branch

The server runs the new `git diff` on demand and sends back the updated patch. The UI re-parses and re-renders without a page reload.

### 4. You annotate specific lines

Click a line number, or drag across a range of lines. A toolbar appears. Type your feedback — maybe "This regex doesn't handle unicode" or "Missing error case for 404." You can also add suggested code: click "Add suggested code" and write the replacement directly.

Each annotation attaches to the exact lines you selected, on the side you selected (additions or deletions). The annotation appears inline below the code, GitHub-style, and shows up in the review panel on the right.

### 5. Feedback goes back to the agent

Click **Send Feedback**. Plannotator formats your annotations into structured markdown — grouped by file, sorted by line number — and sends it to the `/api/feedback` endpoint. The server resolves the blocking promise, outputs the feedback to stdout, and the slash command captures it. Claude Code receives something like:

```markdown
# Code Review Feedback

## src/middleware/validate.ts

### Line 12 (new)
This regex doesn't handle unicode characters in usernames.

**Suggested code:**
```
const USERNAME_REGEX = /^[\p{L}\p{N}_-]{3,32}$/u;
```

### Lines 28-31 (new)
Missing error case — what happens when the request body is empty?

## src/routes/users.ts

### Line 45 (new)
The 404 response should use the standard error format from errorHandler.
```

The agent can act on each annotation directly. Specific file, specific lines, specific feedback.

## How the command integration works

The `/plannotator-review` slash command is defined in a markdown file that Claude Code loads as a plugin command:

```markdown
---
description: Open interactive code review for current changes
allowed-tools: Bash(plannotator:*)
---

## Code Review Feedback

!`plannotator review`

## Your task

Address the code review feedback above.
```

The `!` syntax executes `plannotator review` as a bash command, and Claude Code captures the stdout. The `allowed-tools` restriction ensures only the plannotator binary runs — nothing else.

When `plannotator review` executes, the entry point in `apps/hook/server/index.ts` handles it:

1. **Git context** — `getGitContext()` detects the current branch, the default branch (main/master), and builds the list of available diff types. If you're on a feature branch, "vs main" appears as an option. If you're on main, it doesn't.

2. **Initial diff** — `runGitDiff("uncommitted")` runs `git diff HEAD` and captures the raw unified patch as a string.

3. **Server** — `startReviewServer()` spins up a Bun HTTP server on a random port (or a fixed port in remote/SSH mode). It serves the review UI as a single embedded HTML file and exposes API endpoints: `/api/diff` to serve the patch, `/api/diff/switch` to change diff types on the fly, and `/api/feedback` to receive the review.

4. **Blocking wait** — The process calls `server.waitForDecision()`, which returns a promise that only resolves when the user submits feedback or approves. The process blocks here — no polling, no timeout (well, 96 hours). When it resolves, the server shuts down and the feedback string prints to stdout.

The diff itself stays local. The server runs on `localhost`. Nothing is sent to any external service. The raw patch flows from git to the Bun server to the browser, all on your machine.

## What the diff viewer actually renders

The review UI uses the `@pierre/diffs` library to render unified diffs. The raw patch from git is parsed client-side into per-file chunks by splitting on `diff --git` headers. Each chunk becomes a `DiffFile` object:

```typescript
{
  path: "src/middleware/validate.ts",
  patch: "diff --git a/src/middleware/validate.ts...",
  additions: 24,
  deletions: 8,
}
```

The `PatchDiff` component renders each file's patch with:

- **Split view** — old code on the left, new code on the right. Context lines appear on both sides. Deletions are left-only, additions are right-only.
- **Unified view** — single column with `+`/`-` prefixed lines interleaved, like `git diff` but with syntax highlighting and selectable lines.
- **Line selection** — click or drag across line numbers. Annotations anchor to the last line of the selection range.
- **Hover utility** — a `+` button appears when you hover over a line gutter, for quick single-line comments.

Annotations render inline as collapsible comment blocks with author, timestamp, comment text, and optional suggested code. They're also mirrored in the ReviewPanel sidebar, grouped by file.

## When to use this

The `/plannotator-review` command fits a specific moment in the agent workflow: the agent has made changes, and you want to review them before moving on. Some situations where this is more useful than scrolling through terminal output:

- **Multi-file changes** — the file tree gives you orientation. You can see at a glance which files were touched, how many lines changed, and work through them systematically with viewed-file tracking.
- **Line-level precision** — "fix line 34 in validate.ts" is more useful to the agent than "the validation logic seems off." Suggested code is even better.
- **Before committing** — review uncommitted changes, send feedback, let the agent fix things, then review again. The diff updates live because the server re-runs `git diff` when you switch types.
- **After committing** — switch to "Last commit" to review what just went in, or "vs main" to see the full branch diff.

## Try it

Install Plannotator as a [Claude Code plugin](/docs/getting-started/installation/), let the agent make some changes, and run `/plannotator-review`. Navigate the files, annotate what needs fixing, and send it back.
