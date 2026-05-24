---
title: AI Features
description: "How to use Plannotator's AI chat during plan review, annotate, and code review — provider setup, model selection, and how it works."
sidebar:
  order: 25
section: "Guides"
---

Plannotator embeds an AI chat sidebar directly in live review sessions. In plan review and annotate, you can ask a general question about the current plan or document, or select text, open the comment popover, and choose **Ask AI**. In code review, you can select lines in a diff and ask questions about the code.

The AI sees the relevant review context automatically: the current plan and previous plan version for plan review, the active document and source metadata for annotate, or the full diff for code review. AI chat history stays separate from approve, deny, and send-annotations output unless you manually copy text into normal feedback.

## Supported providers

### Claude (via Claude Agent SDK)

Requires the `claude` CLI installed and authenticated. Uses Claude Code's full system prompt, so the AI has the same capabilities as a Claude Code session — file reading, search, web access — plus the diff context.

**Models:**

- Sonnet 4.6 (default)
- Opus 4.6
- Haiku 4.5

### Codex (via Codex SDK)

Requires the `codex` CLI installed and authenticated. The AI operates in a sandboxed read-only mode with the diff context injected as a system prompt prefix.

**Models:**

- GPT-5.4 (default)
- GPT-5.4 Mini
- GPT-5.3 Codex
- GPT-5.3 Codex Spark
- GPT-5.2 Codex
- GPT-5.2

### Pi (via RPC subprocess)

Requires the `pi` CLI installed and configured. Plannotator spawns `pi --mode rpc` and communicates over JSONL/stdio. Models are discovered dynamically from your Pi installation — whatever models you've configured in Pi are available here.

No API keys are managed by Plannotator — Pi uses its own local configuration.

### OpenCode (via OpenCode SDK)

Requires the `opencode` CLI installed and authenticated. Plannotator spawns `opencode serve` and communicates via HTTP + SSE. Models are discovered dynamically from your connected providers.

OpenCode supports session forking, resuming, and runtime permission approvals — the richest capability set of all four providers.

## Configuration

Provider and model selection is available in **Settings > AI**. These persist via cookies across sessions.

By default, Plannotator prefers the provider that matches the detected agent origin: Claude Code uses Claude, Codex uses Codex, OpenCode uses OpenCode, and Pi uses Pi when those providers are available. GitHub Copilot CLI and Gemini CLI do not have dedicated Ask AI providers yet, so they fall back to your saved provider or the server default.

You can also override the provider and model per-session using the config bar at the bottom of the AI sidebar. Changing the provider or model starts a new session — old messages stay visible but the conversation resets.

## How it works

A session is created lazily on your first question. Until then, no resources are used.

**Claude sessions** use `{ preset: "claude_code" }` with the review context appended. This means the AI has full Claude Code capabilities (tool use, file reading, search) plus the diff. If the code review was launched from a Claude Code session, the AI can fork from the parent session, preserving conversation history.

**Codex sessions** inject the review context as a system prompt prefix. The AI has Codex's built-in capabilities plus the diff. Codex sessions are always standalone — fork support is not available.

**Pi sessions** inject the review context as a system prompt prefix, similar to Codex. Pi uses its full default toolset (read, bash, edit, write). Pi sessions are always standalone — fork and resume are not available.

**OpenCode sessions** pass the review context via the `system` field on the prompt API. OpenCode supports forking from a parent session and resuming previous sessions. Permission requests work the same as Claude — approval cards appear inline.

**Context handling:** Large plans, documents, and diffs are truncated to stay within context limits. When you ask from a selection, the selected text or selected code is always sent alongside the question regardless of truncation. In folder annotation mode, Ask AI is scoped to the currently opened document only.

## Permission requests

When using Claude, the AI may request permission to use tools like Read, Glob, Grep, or WebSearch. When this happens, an approval card appears inline in the chat. You can approve or deny each request individually.

Codex sessions run in a sandboxed read-only mode, so permission requests do not apply.

OpenCode supports the same permission approval flow as Claude — tool calls that need approval appear as inline cards. You can approve or deny each request.

Pi does not expose a permission approval gate over RPC, so tool execution is handled entirely by Pi's own runtime.

## Reasoning effort

Codex supports a reasoning effort setting with four levels: **Low**, **Medium**, **High**, and **Max**. This is available in the config bar at the bottom of the AI sidebar. Higher effort means slower but more thorough responses.

This setting only applies to Codex — Claude, Pi, and OpenCode do not expose a reasoning effort control.

## Available settings

| Setting | Description | Provider |
|---------|-------------|----------|
| Provider | Claude, Codex, Pi, or OpenCode | All |
| Model | Model selection per provider | All |
| Reasoning effort | Low / Medium / High / Max | Codex only |
| Default tools | Read, Glob, Grep, WebSearch | Claude only |
| Sandbox mode | Read-only | Codex only |
| Permission mode | Default | Claude only |
| Max turns | 99 | Claude, Codex |
