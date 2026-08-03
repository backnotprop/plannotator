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
the detected VCS provider captures changes
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

By default the review opens showing **all changes since your base branch** — everything a pull request would show if you committed and pushed right now: committed work, uncommitted edits, and untracked files, compared against the merge base with `main` (or your default branch). You can switch what you're comparing using the diff type dropdown in the toolbar. The available options are:

- **All changes** (since main) - committed + uncommitted + untracked, vs the merge base with your base branch. The default, and the diff behind the Git status panel view.
- **Uncommitted changes** - everything that differs from HEAD, including untracked files
- **Staged changes** - only what's in the staging area (what `git commit` would include)
- **Unstaged changes** - working tree changes that haven't been staged yet, plus untracked files
- **Last commit** - the diff introduced by the most recent commit
- **vs main** (or your default branch) - all committed changes on your branch compared to the base branch. Only appears when you're on a branch other than the default.

The first time you open a review, a setup dialog lets you choose your default view and diff type; you can change both later in **Settings → Git** or reopen the dialog from the review header menu. On repos where the base branch can't be resolved, the review falls back to uncommitted changes.

If the base branch has moved on GitHub since your last fetch, a "Baseline is behind" banner offers a one-click fetch so you're reviewing against the real base.

You can also pick a specific commit as the diff base from the base branch picker. This lets you compare against any of the last 20 commits on your branch rather than just the branch tip.

### Jujutsu (jj) diff modes

In a jj workspace, the diff type picker shows jj-native options instead of git modes:

- **Current** - working-copy changes
- **Last** - the previous change
- **Line** - full line of work from the current change back to trunk
- **All** - all local changes not yet on the remote
- **Evolution** - amendment history for the current change (requires 2+ evolog entries)

### GitButler diff modes

Plannotator automatically recognizes an active GitButler workspace when the checked-out ref is `gitbutler/workspace` (or the legacy `gitbutler/integration` ref) and the repository has GitButler's local target-ref configuration. GitButler CLI **0.21.0 or newer** must be available as `but` on `PATH`. Use `--gitbutler` to require this provider explicitly, or `--git` to inspect the repository through Plannotator's ordinary Git provider instead.

The picker keeps GitButler's different change models separate:

- **Workspace** - every applied committed change plus all assigned, unassigned, and untracked working-tree changes, compared with GitButler's reported merge base. This is the default.
- **Stack** - committed changes for a complete multi-branch stack, from the workspace merge base through the stack tip.
- **Branch** - committed changes introduced by one branch layer in a stack.

Stack and branch views are intentionally **committed-only**. GitButler currently has no authoritative one-shot diff that combines a stack's committed history with its assigned working-tree hunks; composing those independent hunks can produce an invalid patch when stacked branches edit the same lines. Assigned and unassigned changes remain visible in the Workspace view.

GitButler assignment is also not Git's staging index: a change can be assigned per hunk to one of several lanes. Plannotator therefore keeps assignment read-only and does not show Git stage/unstage controls in a GitButler review. Git-status sections, the commit rail, and base-fetch controls remain Git-only. Nested multi-repository reviews support the aggregate Workspace view but not GitButler stack or branch drill-down.

The rendered patch and expanded file contents are authoritative for Stack and Branch views. Plannotator disables “Open in editor,” code navigation, semantic diff, and VS Code editor annotations there because those features resolve against the live combined GitButler workspace rather than the selected committed layer. Agent filesystem tools can still see later branch layers or other applied stacks, so review prompts explicitly preserve the on-screen patch as the source of truth.

The standalone GitButler CLI installer supports macOS and Linux. On Windows, install GitButler Desktop and make `but.exe` available on `PATH`. GitButler edit mode (`gitbutler/edit`) is not treated as a virtual-branch workspace.

## The diff viewer

The review UI shows your changes in a familiar diff format:

- **Left panel views** — a `Git status | Tree | Commits` toggle in the header (see below)
- **Viewed tracking** to mark files as reviewed and track your progress
- **Unified diff** showing additions and deletions in context
- **Annotation tools** with the same annotation types as plan review (delete, comment, quick label, "looks good")

### Panel views

The left panel has three views. The header toggle is session-scoped — glancing at another view never changes your saved default (that's a Settings / setup-dialog decision).

- **Git status** (default) — your changes grouped the way `git status` groups them: **Committed / Changes / Untracked**. Each row shows viewed state, a stage/unstage button, the change-type letter, and +/- counts. Only available with the "All changes" diff.
- **Tree** — the classic file tree over whichever diff type you've selected.
- **Commits** — a linear history rail of your branch, newest first, with an "In origin/main" divider where your work meets the base. Clicking a commit opens that commit's own diff (vs its parent), headed by the full commit message. Local git sessions only; a commit is never saved as your opening view.

## Annotating code

Select any text in the diff to annotate it, just like in plan review. Your annotations are exported as structured feedback referencing specific lines and files.

## Ask AI

When an AI provider is available, the diff viewer includes inline AI chat. Select lines in the diff and choose "Ask AI" to ask questions about the code. Responses stream into a sidebar panel grouped by file.

### Supported providers

Plannotator supports multiple AI providers. Providers are auto-detected based on which CLI tools are installed on your system:

- **Claude** requires the `claude` CLI ([Claude Code](https://docs.anthropic.com/en/docs/claude-code))
- **Codex** requires the `codex` CLI ([OpenAI Codex](https://github.com/openai/codex))
- **Pi** requires the `pi` CLI ([Pi](https://github.com/earendil-works/pi))
- **OpenCode** requires the `opencode` CLI ([OpenCode](https://opencode.ai))

All providers can be available simultaneously. Plannotator does not manage API keys, so you must be authenticated with each CLI independently (`claude` uses `~/.claude/` credentials, `codex` uses `OPENAI_API_KEY`, `pi` and `opencode` use their own local configuration).

### Choosing a provider

When multiple providers are available, set your default in **Settings → AI**. The AI tab shows all detected providers as selectable cards. Your choice persists across sessions.

If only one provider is installed, it's used automatically with no configuration needed.

## Guided Review

A Guided Review turns the changeset into an ordered, chaptered walkthrough: an agent organizes the diff into sections — the heart of the change first, consequences next, glue last — each pairing a prose overview and per-file summaries with the live, annotatable diffs it covers. Annotations made inside a guide are the same annotations as everywhere else and export in the same feedback.

Open it with the **Guide** button in the review header (or `Mod+Shift+G`), pick an agent and model, and generate. Sections track a per-section "reviewed" state so you can work through a large change in order. Guides run on Claude or Codex natively, and on Cursor, OpenCode, Pi, or GitHub Copilot CLI when those binaries are installed.

## How review agents prompt the CLI

The review agents (Claude, Codex, Code Tour, Guided Review) shell out to external CLIs — Claude and Codex natively, plus Cursor, OpenCode, Pi, and GitHub Copilot CLI as additional engines for review and guide jobs. Plannotator controls the user message and output schema; the CLI's own harness owns the system prompt. See the [Prompts reference](/docs/reference/prompts/) for the full breakdown of what each provider sends, how the pieces join, and which knobs you can tune per job.

## Submitting feedback

- **Send Feedback** formats your annotations and sends them to the agent
- **Approve** sends a review-approval prompt to the agent. By default this says no changes were requested, and you can override it in `~/.plannotator/config.json`.

After submission, the agent receives your feedback. By default, Plannotator tells it to verify each submitted finding against the code, discuss its verdicts before changing code, and not review the rest of the diff for additional issues. You can replace this suffix with `prompts.review.denied` in `~/.plannotator/config.json`.

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
| `/api/diff` | GET | Returns diff data including `rawPatch`, `gitRef`, `origin`, `diffType`, `base`, `hideWhitespace`, `gitContext`, plus the git-status `sections` and commit-metadata sidecars |
| `/api/diff/switch` | POST | Switch diff type (including `commit:<sha>`), base branch/commit, or whitespace mode |
| `/api/diff/fresh` | GET | Cheap staleness probe backing the "Diff out of date" notice |
| `/api/commits` | GET | One page of the branch's linear history for the Commits panel |
| `/api/fetch-base` | POST | Fetch the base branch's remote tracking ref ("Baseline is behind" banner) |
| `/api/semantic-diff` | GET | Semantic diff for the active patch, when available |
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
| `/api/agents/jobs` | GET/POST/DELETE | Manage agent jobs (review, Code Tour, Guided Review) |
| `/api/guide/:jobId` | GET | Fetch a completed Guided Review (sections, summaries, file refs) |
| `/api/guide/:jobId/reviewed` | PUT | Persist per-section reviewed state |
| `/api/code-nav/resolve` | POST | Find symbol definitions/references for code navigation |
| `/api/code-nav/file` | GET | Read a working-tree file for code-nav preview |
| `/api/pr-list` | GET | List PRs for the current repo |
| `/api/pr-switch` | POST | Switch to a different PR in-place |
| `/api/pr-diff-scope` | POST | Switch between Layer and Full-stack diff scope |
