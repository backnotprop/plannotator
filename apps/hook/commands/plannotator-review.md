---
description: Open interactive code review for current changes or a PR URL
allowed-tools: Bash(plannotator:*)
disable-model-invocation: true
---

## Instructions

Run `plannotator review $ARGUMENTS` using the Bash tool with `run_in_background: true`. This starts a review server and opens the browser. The user will review code and submit feedback — this may take a long time.

**Wait for the background task to complete before proceeding.** Do not interrupt or take other actions while the user is reviewing.

## Your task

When the command finishes, read its output. If it contains feedback or annotations, address them. If no changes were requested, acknowledge and continue.
