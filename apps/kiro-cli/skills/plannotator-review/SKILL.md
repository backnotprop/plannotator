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

You may also append the tripwire flags, whose stdout is captured back to you:
`--tripwires` (or `-t`) prints a slop-free-zone scan report for the current diff
(no UI opens), and `--add-tripwire <glob>` returns a snippet to apply (it does
not write the file). Tripwire rules merge a private, auto-created global file at
`~/.plannotator/tripwires/<project-key>.json` with an optional committed
`.plannotator/tripwires.json` at the repo root.
