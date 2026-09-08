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

You may append an optional PR URL:

```bash
PLANNOTATOR_ORIGIN=kiro-cli plannotator review <pr-url>
```

Or open the session against a specific base / diff mode (session-only, git-only; for a stacked branch, `--base <the branch below yours>` reviews just that layer):

```bash
PLANNOTATOR_ORIGIN=kiro-cli plannotator review --base <ref> [--diff-type <type>]
```
