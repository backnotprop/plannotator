---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree or a pull request URL, then act on the feedback that comes back.
disable-model-invocation: true
---

# Plannotator Review

Use this skill when the user wants to review current code changes in Plannotator instead of reading a diff inline.

Run:

```bash
PLANNOTATOR_ORIGIN=antigravity plannotator review [--base <ref>] [--diff-type <type>] [optional-pr-url]
```

Reviewing one layer of a stacked branch? Pass `--base <the branch immediately below yours>` so the review shows only what this layer adds, instead of everything since `main`. Both flags are session-only (the reviewer can change either in the UI; nothing is persisted) and git-only.

Behavior:

1. Run the command in the workspace directory using `run_command`. Set `PLANNOTATOR_ORIGIN=antigravity` for this invocation. The examples use Bash; in PowerShell use `$env:PLANNOTATOR_ORIGIN="antigravity"`, or in CMD use `set "PLANNOTATOR_ORIGIN=antigravity"` before the command.
2. Wait for it to finish.
3. If it returns feedback or annotations, address them in the same conversation.
4. If it returns an approval/LGTM-style message, acknowledge that review passed and continue.

Do not ask the user to copy shell commands into chat. Run the command yourself.
