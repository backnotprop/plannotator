---
name: plannotator-archive
description: Browse saved plan decisions in Plannotator's read-only archive UI in the browser.
disable-model-invocation: true
---

# Plannotator Archive

Use this skill when the user wants to browse their saved plan decisions in Plannotator's read-only archive UI.

Run:

```bash
plannotator archive
```

Behavior:

1. Launch the command with Bash.
2. Wait for the browser archive session to finish (the archive is read-only, so no feedback is returned).
3. When the session closes, acknowledge that the user finished browsing the archive and continue.

Run the command yourself rather than telling the user to invoke shell syntax manually.
