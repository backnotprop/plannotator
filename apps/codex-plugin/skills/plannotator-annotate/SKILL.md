---
name: plannotator-annotate
description: Open a markdown file, a folder of documents, or a URL in Plannotator so the user can annotate it, then act on the feedback. Use when the user asks to annotate, review, or mark up a document in Plannotator.
---

# Annotate with Plannotator

Use the `annotate` tool from the Plannotator MCP server. Do not run the
`plannotator` shell command for this; the tool returns the user's feedback to
you directly.

1. Work out the target from the user's request: a file path (`.md`, `.mdx`,
   `.txt`, `.html`, and other plain-text formats), a folder path, or an
   `http(s)` URL. Pass an absolute path. If you only have a relative path,
   also pass your current working directory as `cwd`.
2. Call `annotate` with `{ "target": "<path or URL>" }`. Add `"gate": true`
   only when the user wants to explicitly approve or reject the document.
3. The call blocks while the user reviews in the browser. That can take a
   long time. Wait for it; do not start other work or call it again.
4. Act on the result:
   - Feedback text: address every annotation. Make the requested edits, then
     summarize what you changed.
   - `The user approved.`: continue with the work the document describes.
   - The user closed Plannotator without feedback: stop and ask what they
     want. Do not guess at changes.
   - An error (for example `File not found`): report it and ask for the
     correct path.
