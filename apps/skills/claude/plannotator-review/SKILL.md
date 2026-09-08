---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree or a pull request URL, then act on the feedback that comes back.
allowed-tools: Bash(plannotator:*)
disable-model-invocation: true
---

# Plannotator Review

Arguments pass through to `plannotator review`: a PR/MR URL, `--git` / `--gitbutler`, and the session-only open-state flags `--base <ref>` / `--diff-type <type>` (git-only; for a stacked branch, `--base <the branch below yours>` reviews just that layer).

## Code review feedback

!`plannotator review $ARGUMENTS`

## Your task

If the review above contains feedback or annotations, address them in the same conversation. If no changes were requested (an approval/LGTM-style result), acknowledge that review passed and continue.
