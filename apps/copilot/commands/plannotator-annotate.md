---
description: Open interactive annotation UI for a markdown file
allowed-tools: shell(plannotator:*)
---

## Markdown Annotations

!`plannotator annotate $ARGUMENTS`

## Your task

The output above will be one of:

1. The exact text `The user approved.`, OR a JSON object with `"decision": "approved"`. The user approved the markdown file. Acknowledge with a single sentence ("Approved.") and stop. Do not begin any work.
2. Empty, OR a JSON object with `"decision": "dismissed"`. The user closed the session without requesting changes. Acknowledge with a single sentence ("Annotation session closed.") and stop. Do not begin any work.
3. Plaintext annotation feedback, OR a JSON object with `"decision": "annotated"` and a `"feedback"` field. Address the feedback. The user has reviewed the markdown file and provided specific annotations and comments.
