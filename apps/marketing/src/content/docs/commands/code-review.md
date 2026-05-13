---
title: "Code Review"
description: "The /plannotator-review slash command for reviewing local changes, comparing branches, or reviewing GitHub pull requests."
sidebar:
  order: 11
section: "Commands"
---

The `/plannotator-review` command opens an interactive code review UI for your local changes or a GitHub pull request.

## Usage

**Review local changes:**

```
/plannotator-review
```

**Review a GitHub pull request:**

```
/plannotator-review https://github.com/owner/repo/pull/123
```

PR review uses the `gh` CLI for authentication, so private repos work automatically if you're authenticated with `gh auth login`.

GitLab merge request URLs are also supported when the `glab` CLI is installed and authenticated.

## How it works

**Local review:**

```
User runs /plannotator-review
        ↓
Agent runs: plannotator review
        ↓
git diff captures changes
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → feedback sent to agent
Approve → configured approval prompt sent to agent
```

**PR review:**

```
User runs /plannotator-review <github-url>
        ↓
Agent runs: plannotator review <github-url>
        ↓
gh CLI fetches PR diff and metadata
        ↓
Review server starts, opens browser with diff viewer
        ↓
User annotates code, provides feedback
        ↓
Send Feedback → PR context included in feedback
Approve → configured approval prompt sent to agent
```

## Stacked PRs and MRs

When a PR or MR targets a non-default branch, Plannotator marks it as stacked in the review header. The default view remains **Layer**, which matches the platform diff and is the safe mode for posting inline review comments.

If Plannotator has a local checkout for the PR or MR, the header also offers **Full stack**. Full stack shows everything from the repository default branch through the current checked-out head, which helps you understand the whole chain before reviewing the current layer.

Platform posting is intentionally limited to **Layer** because GitHub and GitLab inline comments are anchored to the PR or MR's own diff. Use **Full stack** for comprehension and agent review, then switch back to **Layer** before posting to the platform.

## Switching diff types

By default the review opens showing uncommitted changes, but you can switch what you're comparing using the diff type dropdown in the toolbar. The available options are:

- **Uncommitted changes** - everything that differs from HEAD, including untracked files
- **Staged changes** - only what's in the staging area (what `git commit` would include)
- **Unstaged changes** - working tree changes that haven't been staged yet, plus untracked files
- **Last commit** - the diff introduced by the most recent commit
- **vs main** (or your default branch) - all committed changes on your branch compared to the base branch. This gives you the same view you'd see on a pull request, without needing to push or create one. Only appears when you're on a branch other than the default.

If you're working on a feature branch and want to see everything you've done before opening a PR, switch to the "vs main" option. It's a good way to do a self-review of your full branch diff.

You can also pick a specific commit as the diff base from the base branch picker. This lets you compare against any of the last 20 commits on your branch rather than just the branch tip.

### Jujutsu (jj) diff modes

In a jj workspace, the diff type picker shows jj-native options instead of git modes:

- **Current** - working-copy changes
- **Last** - the previous change
- **Line** - full line of work from the current change back to trunk
- **All** - all local changes not yet on the remote
- **Evolution** - amendment history for the current change (requires 2+ evolog entries)

## The diff viewer

The review UI shows your changes in a familiar diff format:

- **File tree sidebar** for navigating between changed files
- **Viewed tracking** to mark files as reviewed and track your progress
- **Unified diff** showing additions and deletions in context
- **Annotation tools** with the same annotation types as plan review (delete, comment, quick label, "looks good")

## Annotating code

Select any text in the diff to annotate it, just like in plan review. Your annotations are exported as structured feedback referencing specific lines and files.

## Ask AI

When an AI provider is available, the diff viewer includes inline AI chat. Select lines in the diff and choose "Ask AI" to ask questions about the code. Responses stream into a sidebar panel grouped by file.

### Supported providers

Plannotator supports multiple AI providers. Providers are auto-detected based on which CLI tools are installed on your system:

- **Claude** requires the `claude` CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code))
- **Codex** requires the `codex` CLI ([OpenAI Codex](https://github.com/openai/codex))
- **Pi** requires the `pi` CLI ([Pi](https://github.com/mariozechner/pi-coding-agent))
- **OpenCode** requires the `opencode` CLI ([OpenCode](https://opencode.ai))

All providers can be available simultaneously. Plannotator does not manage API keys, so you must be authenticated with each CLI independently (`claude` uses `~/.claude/` credentials, `codex` uses `OPENAI_API_KEY`, `pi` and `opencode` use their own local configuration).

### Choosing a provider

When multiple providers are available, set your default in **Settings → AI**. The AI tab shows all detected providers as selectable cards. Your choice persists across sessions.

If only one provider is installed, it's used automatically with no configuration needed.

## How review agents prompt the CLI

The review agents (Claude, Codex, Code Tour) shell out to external CLIs. Plannotator controls the user message and output schema; the CLI's own harness owns the system prompt. See the [Prompts reference](/docs/reference/prompts/) for the full breakdown of what each provider sends, how the pieces join, and which knobs you can tune per job.

## Submitting feedback

- **Send Feedback** formats your annotations and sends them to the agent
- **Approve** sends a review-approval prompt to the agent. By default this says no changes were requested, and you can override it in `~/.plannotator/config.json`.

After submission, the agent receives your feedback and can act on it, whether that's fixing issues, explaining decisions, or making the requested changes.

### Customizing the approval prompt

You can override the approval prompt in `~/.plannotator/config.json`.

```json
{
  "prompts": {
    "review": {
      "approved": "# Code Review\n\nCommit these changes now.",
      "runtimes": {
        "opencode": {
          "approved": "# Code Review\n\nNo further changes requested. Commit your work."
        }
      }
    }
  }
}
```

Resolution order:

1. `prompts.review.runtimes.<runtime>.approved`
2. `prompts.review.approved`
3. Plannotator's built-in default

Runtime keys use Plannotator's runtime identifiers. For code review, the current values are `claude-code`, `opencode`, `copilot-cli`, `pi`, and `codex`.

## Server API

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/diff` | GET | Returns diff data including `rawPatch`, `gitRef`, `origin`, `diffType`, `base`, `hideWhitespace`, `gitContext` |
| `/api/diff/switch` | POST | Switch diff type, base branch/commit, or whitespace mode |
| `/api/file-content` | GET | Full file content for expandable diff context |
| `/api/git-add` | POST | Stage or unstage a file |
| `/api/feedback` | POST | Submit review feedback |
| `/api/image` | GET | Serve image by path |
| `/api/upload` | POST | Upload image attachment |
| `/api/draft` | GET/POST/DELETE | Auto-save annotation drafts |
| `/api/ai/capabilities` | GET | Check available AI providers |
| `/api/ai/session` | POST | Create or fork an AI session |
| `/api/ai/query` | POST | Send prompt, stream SSE response |
| `/api/ai/abort` | POST | Abort current AI query |
| `/api/ai/permission` | POST | Respond to tool approval request |
| `/api/agents/capabilities` | GET | Check available agent providers |
| `/api/agents/jobs` | GET/POST/DELETE | Manage agent jobs (Code Tour, etc.) |
| `/api/pr-list` | GET | List PRs for the current repo |
| `/api/pr-switch` | POST | Switch to a different PR in-place |
