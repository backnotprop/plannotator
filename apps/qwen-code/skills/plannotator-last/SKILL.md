---
name: plannotator-last
description: Open Plannotator on the latest rendered assistant message and use the returned annotations to revise that message or continue.
disable-model-invocation: true
---

# Plannotator Last (Qwen Code)

Use this skill when the user wants to annotate the latest assistant response in Plannotator.

Do not send a commentary/status message before running the command. The command
targets the latest rendered assistant response, so a preamble can mistakenly become the
thing being annotated.

Run:

```bash
plannotator last
```

Run it with the shell tool's `is_background: true`, and no trailing `&`. The command waits until the person finishes in the browser, which often takes longer than the shell tool's foreground limit (2 minutes by default, 10 at most); a foreground run would be stopped and the annotations lost. Then end your turn without stopping the task. When the task finishes, read its output (the tool result names the output file) and act on it.

Behavior:

1. If feedback is returned, incorporate it into the follow-up response.
2. If the session closes without feedback (the output is empty, or a JSON object with `"decision": "dismissed"`), acknowledge it in one sentence and stop. Do not begin any work: closing the session is not approval.
3. An approval may still carry notes — a `"decision": "approved"` result with a
   `"feedback"` field. Read those notes and carry them into subsequent work, but
   do not redo the message over them: they are guidance, not a change request.

Run the command yourself rather than telling the user to invoke shell syntax manually.
