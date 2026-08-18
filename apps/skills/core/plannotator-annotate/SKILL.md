---
name: plannotator-annotate
description: Open Plannotator's annotation UI for a markdown file, plain-text config file (.yaml, .json, .toml, .ini, .csv, .log, …), HTML file, URL, or folder and then respond to the returned annotations.
disable-model-invocation: true
---

# Plannotator Annotate

Use this skill when the user wants to annotate a document in Plannotator instead of reviewing it inline in chat.

Run:

```bash
plannotator annotate <path-or-url>
```

Behavior:

1. Launch the command with Bash.
2. Wait for the browser review to finish.
3. If annotations are returned, address them directly.
4. If the session closes without feedback, say so briefly and continue.
5. An approval may still carry notes — a `"decision": "approved"` result with a
   `"feedback"` field. Read those notes and carry them into subsequent work, but
   do not revise the document over them: they are guidance, not a change request.
6. If the command reports that the arguments could not be resolved to a file,
   URL, or folder, work out which target the user means and re-run the command
   yourself with that concrete path or URL.

Do not ask the user to paste a shell command into the chat. Run the command yourself.
