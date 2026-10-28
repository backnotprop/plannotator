---
name: plannotator-review
description: Open Plannotator's browser-based code review UI for the current worktree, another directory, or a pull request URL, then act on the feedback that comes back.
disable-model-invocation: true
---

# Plannotator Review (Qwen Code)

Use this skill when the user wants to review current code changes in Plannotator instead of reading a diff inline.

Run:

```bash
plannotator review [--base <ref>] [--diff-type <type>] [directory-or-pr-url]
```

Run it with the shell tool's `is_background: true`, and no trailing `&`. The command waits until the person finishes the review in the browser, which often takes longer than the shell tool's foreground limit (2 minutes by default, 10 at most); a foreground run would be stopped and the review lost. Then end your turn without stopping the task. When the task finishes, read its output (the tool result names the output file) and act on it.

Reviewing one layer of a stacked branch? Pass `--base <the branch immediately below yours>` so the review shows only what this layer adds, instead of everything since `main`. Both flags are session-only (the reviewer can change either in the UI; nothing is persisted) and git-only.

To review another repository or worktree, pass its directory (relative to the current session or absolute), e.g. `plannotator review ../feature-worktree`. Quote paths containing spaces. Feedback names the selected directory; apply changes there.

Behavior:

1. If it returns feedback or annotations, address them in the same conversation.
2. If it returns an approval/LGTM-style message, acknowledge that review passed and continue.
3. If the session closes without feedback (the output is "Review session closed without feedback." or empty), acknowledge it in one sentence and stop. Do not begin any work: closing the session is not approval.

Do not ask the user to copy shell commands into chat. Run the command yourself.
