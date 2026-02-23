---
title: "Plan Diff: See What Changed Between Iterations"
description: "When your coding agent revises a plan, Plannotator now shows exactly what changed. Visual diffs, raw markdown diffs, and version history — across Claude Code, OpenCode, and Pi."
date: 2026-02-22
author: "backnotprop"
tags: ["plan-diff", "plan-mode", "version-history"]
---

**Plannotator is an open-source review UI for AI coding agents.** The latest release adds Plan Diff — a way to see exactly what changed when your agent revises a plan after feedback.

## Watch the Demo

<!-- TODO: Replace with actual YouTube embed -->
<iframe width="100%" style="aspect-ratio: 16/9;" src="https://www.youtube.com/embed/PLACEHOLDER" title="Plan Diff Demo" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>

## The problem

You're reviewing a plan after instructing the agent to revise it. You have no idea what actually changed. With long plans, you're re-reading the whole thing. This was one of the most [requested features](https://github.com/backnotprop/plannotator/issues/138) from the community — a way to skip the guesswork and go straight to what's different.

## How it works

When the agent resubmits a plan you've already reviewed, a `+N/-M` badge appears below the document card showing how many lines were added and removed. Click it to toggle into diff view.

### Two view modes

- **Rendered diff**: the plan renders as usual, but with color-coded left borders. Green for added sections, red with strikethrough for removed content, and yellow for modified lines. You can scan the plan visually and immediately spot where the changes landed.

- **Raw diff**: a monospace, git-style view with `+` and `-` prefixed lines. Useful when you want precise, line-level detail about what changed in the markdown source.

Toggle between the two with a single click. Both views work from the same underlying diff. The engine computes line-level changes and groups consecutive add/remove pairs into "modified" blocks so you see intent, not noise.

### Version history

Every time a plan arrives, Plannotator automatically saves it to disk. Plans are versioned sequentially: first submission is version 1, the revision after your feedback is version 2, and so on. Same plan heading on the same day means same plan being iterated on.

From the sidebar, you can open the Version Browser and select any previous version to diff against. The default comparison is always against the immediately prior version, but you can jump back further if the plan has gone through several rounds.

### Coming soon: cross-plan comparison

Right now, diffs are scoped to versions of the same plan. A future release will let you compare across different plans in the same project, useful when the agent takes a fundamentally different approach and you want to see how two strategies differ.

## Works everywhere

Plan Diff is available across all three supported agents: Claude Code, OpenCode, and Pi. The diff UI is the same regardless of which agent you're using. If your agent submits a revised plan, you'll see the badge.

## This is v1

This is the first release of Plan Diff. The version matching relies on plan headings and dates to group iterations together, which works well for typical workflows but may have rough edges with unusual plan titles or long-running sessions. If something feels off (wrong versions being compared, diffs not appearing when expected), [open an issue](https://github.com/backnotprop/plannotator/issues). This feature was built directly from community requests ([#138](https://github.com/backnotprop/plannotator/issues/138), [#111](https://github.com/backnotprop/plannotator/issues/111)), and feedback will shape where it goes next.

## Try it

Update to the latest version:

```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

Start a planning session, deny a plan with some annotations, and let the agent resubmit. The diff badge will appear automatically.

## Plannotator: plan review for coding agents

Plannotator is a free, open-source plan review UI for AI coding agents. Annotate plans visually, review code diffs, share with your team, and now see exactly what changed between iterations with Plan Diff. Coding agents like Claude Code don't show you how a plan changed after revision — Plannotator does. Works with Claude Code, OpenCode, and Pi. Install it in under a minute and start reviewing plans in your browser instead of the terminal.
