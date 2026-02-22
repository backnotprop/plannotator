---
title: "Plannotator Meets Pi"
description: "Plannotator now supports Pi, the minimal terminal coding agent. File-based plan mode, bash safety gating, progress tracking — all with the same browser review UI."
date: 2026-02-21
author: "backnotprop"
tags: ["pi", "integration", "plan-mode"]
---

**Plannotator now supports [Pi](https://github.com/badlogic/pi-mono), the minimal terminal coding agent from Mario Zechner.** Install it as a Pi extension and you get file-based plan mode, visual plan review, code review, and markdown annotation — all through the same browser UI that Claude Code and OpenCode users already know.

## Watch the Demo

<iframe width="100%" style="aspect-ratio: 16/9;" src="https://www.youtube.com/embed/XqFun9XCXPw?si=BbjywvxWPONkLRij" title="Plannotator for Pi" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

## Why Pi

Pi ships with four tools — `read`, `write`, `edit`, and `bash` — and nothing else. No sub-agents, no plan mode, no built-in review system. That's by design. Pi's philosophy is: extend it with what you need, don't carry what you don't. Features that other tools bake in are built as extensions, skills, or third-party packages.

This is a good fit for Plannotator. Instead of being a hook that intercepts a built-in plan mode (like the Claude Code integration), the Pi extension *is* the plan mode. It registers the tools, manages the state machine, gates the permissions, and handles the browser UI — all as a single extension.

## Install

```bash
pi install npm:@plannotator/pi-extension
```

Or try it without installing:

```bash
pi -e npm:@plannotator/pi-extension
```

## How it works

The extension manages a three-phase state machine: **idle** → **planning** → **executing** → **idle**.

### Planning phase

Start plan mode with `pi --plan` or toggle it mid-session with `/plannotator` or `Ctrl+Alt+P`. The extension immediately restricts the agent's available tools:

- **Read-only access** — `read`, `grep`, `find`, `ls` all work normally
- **Bash is gated** — every command is checked against a safety allowlist before execution. `cat`, `git status`, `ls`, `find`, `rg` pass. `rm`, `git commit`, `npm install`, `sudo` don't. The allowlist is pattern-based, not a simple command list — it catches destructive commands even in pipes or subshells.
- **Writes restricted to the plan file** — the agent can write to `PLAN.md` (or a custom path via `--plan-file`) but nowhere else. Edits to other files are blocked.
- **`exit_plan_mode` tool available** — this is how the agent signals the plan is ready for review.

The agent explores your codebase using read-only tools, drafts a plan as a markdown checklist in `PLAN.md`, and calls `exit_plan_mode` when ready. The planning prompt instructs the agent to work iteratively — explore, update the plan, ask questions, repeat — rather than dumping a fully-formed plan in one shot.

Because the plan lives on disk as a regular file, you can open it in your editor alongside the terminal. Git tracks it. Your team can read it in a PR.

### Review phase

When the agent calls `exit_plan_mode`, the extension reads `PLAN.md` from disk, starts a local HTTP server, and opens the Plannotator browser UI. You see the rendered plan with all the annotation tools — comments, deletions, replacements, insertions.

Three outcomes:

- **Approve** — the extension transitions to the executing phase. The agent gets full tool access.
- **Approve with notes** — same transition, but the annotation feedback is included in the tool response as implementation guidance. The agent sees your notes and incorporates them.
- **Deny with annotations** — the extension stays in planning. The agent receives your structured feedback and is told to use `edit` (not `write`) to make targeted revisions, then call `exit_plan_mode` again.

This loop continues until you approve. Each round, the agent refines the plan based on your specific annotations rather than vague instructions.

### Executing phase

Once approved, the extension unlocks full tool access (`read`, `bash`, `edit`, `write`) and tracks progress. If the plan contains markdown checkboxes:

```markdown
- [ ] Add validation to the login form
- [ ] Write tests for the new validation logic
- [ ] Update error messages in the UI
```

The extension parses them into a checklist and monitors the agent's responses for `[DONE:n]` markers. When the agent completes step 2, it includes `[DONE:2]` in its response. The extension updates a terminal widget showing completed vs remaining steps, and sets a status line indicator with the count.

When all steps are marked done, the extension posts a completion message, resets to idle, and restores normal tool access.

### State persistence

The phase and plan file path persist across session restarts via Pi's `appendEntry` API. If you close the terminal mid-execution and come back, the extension restores the executing phase, re-reads `PLAN.md` from disk, re-parses the checklist, and scans prior messages for `[DONE:n]` markers to reconstruct progress. You pick up where you left off.

## The Node.js constraint

Pi loads extensions via [jiti](https://github.com/unjs/jiti), which runs in Node.js — not Bun. The shared Plannotator server code in `packages/server/` uses `Bun.serve()`, which doesn't work here.

The Pi extension includes its own server implementation using `node:http`. It's a stripped-down version of the shared server — same API endpoints, same HTML payloads, same behavior — but built on `createServer` instead of Bun's API. The plan review server exposes `/api/plan`, `/api/approve`, and `/api/deny`. The code review server exposes `/api/diff`, `/api/diff/switch`, and `/api/feedback`. The annotate server exposes `/api/plan` (in annotate mode) and `/api/feedback`.

Each server picks a random port, serves the pre-built HTML (copied from `apps/hook/dist/` during build), and blocks until the user submits a decision. The git operations use `execSync` instead of Bun's `$` shell.

## Code review and annotation

The Pi extension includes the same `/plannotator-review` and `/plannotator-annotate` commands as the Claude Code and OpenCode integrations:

- **`/plannotator-review`** — captures `git diff HEAD`, opens the diff viewer in your browser. You annotate lines, switch between diff types (uncommitted, last commit, vs default branch), and submit feedback. The extension sends the formatted feedback back to the agent as a user message via `pi.sendUserMessage()`.

- **`/plannotator-annotate <file.md>`** — opens any markdown file in the annotation UI. Useful for reviewing design docs or specs with the agent. Feedback goes back as a user message referencing the file path.

Both commands reuse the same pre-built HTML as the plan review UI. The only difference is the API endpoints the browser calls.

## Third agent, same UI

Plannotator now supports three coding agents — Claude Code, OpenCode, and Pi — each with a different integration model:

| | Claude Code | OpenCode | Pi |
|---|---|---|---|
| **Integration type** | PermissionRequest hook | Plugin with tools + events | Extension with tools + events |
| **Plan mode** | Built into Claude Code | Built into OpenCode | Provided by the extension |
| **Review trigger** | `ExitPlanMode` hook event | `submit_plan` tool call | `exit_plan_mode` tool call |
| **Server runtime** | Bun | Bun | Node.js (via jiti) |
| **Feedback delivery** | stdout JSON decision | `session.prompt()` API | `sendUserMessage()` API |
| **Tool gating** | Not needed (Claude Code handles it) | Not needed (OpenCode handles it) | Extension manages tool restrictions |
| **Progress tracking** | Not included | Not included | `[DONE:n]` markers + terminal widget |

The review UI is identical across all three. The `origin` field (`"claude-code"`, `"opencode"`, or `"pi"`) lets the frontend adapt where needed, but the core experience — annotating plans, reviewing diffs, sending structured feedback — is the same everywhere.

## Try it

```bash
pi install npm:@plannotator/pi-extension
pi --plan
```

Ask the agent to build something. Review the plan in your browser. Approve when it's right.
