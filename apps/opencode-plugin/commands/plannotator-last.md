---
description: Annotate the last assistant message
---

Run `plannotator last $ARGUMENTS` with Bash, in the foreground, and wait for it to finish. Send no message before running it: the command targets the latest rendered assistant response, so a preamble becomes the thing being annotated.

Relay its stdout to the user and carry any returned feedback into your next response. An approval can still carry notes; treat those as guidance, not a change request.

Do not ask the user to run the command themselves.
