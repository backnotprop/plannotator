---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree, another directory, or a pull request URL, then act on the feedback that comes back.
allowed-tools: Bash(plannotator:*)
disable-model-invocation: true
---

# Plannotator Review

Arguments pass through to `plannotator review`: one directory or PR/MR URL, `--git` / `--gitbutler`, and the session-only open-state flags `--base <ref>` / `--diff-type <type>` (git-only; for a stacked branch, `--base <the branch below yours>` reviews just that layer).

For another repository or worktree, pass its path relative to this session or an absolute path, e.g. `/plannotator-review ../feature-worktree`. Quote paths containing spaces. Supply a target, not prose; feedback names the directory where changes belong.

## Code review feedback

!`plannotator review $ARGUMENTS`

## Your task

If the review above contains feedback or annotations, address them in the same conversation. If no changes were requested (an approval/LGTM-style result), acknowledge that review passed and continue.
