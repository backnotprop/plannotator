# Plannotator for Antigravity CLI

Interactive plan review, code review, and markdown annotation strictly for Google Antigravity CLI (`agy`) terminal workflows.

> **Note on Desktop 2.0 & IDE**: Antigravity 2.0 Desktop and Antigravity IDE feature their own built-in planning mode and native UI review tools. Plannotator operates specifically within Antigravity CLI terminal sessions.

## Overview

The Antigravity plugin enables:
1. **Interactive Plan Review**: Intercepts implementation plan creation (`.agents/plans/<plan>.md` and `<artifactDirectoryPath>/implementation_plan.md`), opening a visual browser review before code changes execute.
2. **Code Review**: Interactive side-by-side git diff review via `/plannotator:plannotator-review`.
3. **Document Annotation**: Markdown and web document visual feedback via `/plannotator:plannotator-annotate`.

## Structure

```text
plugins/plannotator/
├── plugin.json       # Plugin manifest
├── hooks.json        # PreToolUse gating hook
├── rules/
│   └── AGENTS.md     # In-context planning protocol for the agent
└── skills/
    ├── plannotator-plan/       # /plannotator:plannotator-plan
    ├── plannotator-review/     # /plannotator:plannotator-review
    └── plannotator-annotate/   # /plannotator:plannotator-annotate
```

## How It Works

- When the agent produces an implementation plan, the `PreToolUse` hook pauses execution and opens Plannotator in the browser.
- **Approve**: Tool execution proceeds and approved plans are saved to `.agents/plans/<plan>.md`.
- **Deny**: Plannotator blocks tool execution and injects user line annotations into the conversation for the agent to revise.
