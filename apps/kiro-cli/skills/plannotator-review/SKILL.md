---
name: plannotator-review
disable-model-invocation: true
description: Open Plannotator's browser-based code review UI and address the returned feedback.
---

# Plannotator Review (Kiro)

Run:

```bash
PLANNOTATOR_ORIGIN=kiro-cli plannotator review
```

You may append one directory or PR URL:

```bash
PLANNOTATOR_ORIGIN=kiro-cli plannotator review <pr-url>
PLANNOTATOR_ORIGIN=kiro-cli plannotator review ../feature-worktree
```

Directory paths are relative to the current session or absolute. Quote paths containing spaces. Feedback names the directory where changes belong.

Or open the session against a specific base / diff mode (session-only, git-only; for a stacked branch, `--base <the branch below yours>` reviews just that layer):

```bash
PLANNOTATOR_ORIGIN=kiro-cli plannotator review --base <ref> [--diff-type <type>]
```
