export interface AnnotateAgentInstructionsContext {
  source: 'file' | 'message' | 'folder';
  filePath?: string;
}

function describeTarget(context: AnnotateAgentInstructionsContext): string {
  if (context.source === 'message') {
    return 'the agent message open in this Annotate session';
  }
  if (context.filePath) {
    return `${context.source === 'folder' ? 'the selected folder document' : 'the open document'} at ${JSON.stringify(context.filePath)}`;
  }
  return context.source === 'folder'
    ? 'the document currently selected in this folder session'
    : 'the document open in this Annotate session';
}

export function buildAnnotateAgentInstructions(
  origin: string,
  context: AnnotateAgentInstructionsContext,
): string {
  const target = describeTarget(context);

  if (context.source === 'folder') {
    return `# Plannotator — External Annotate Feedback

You can submit feedback to a specific live Plannotator Annotate session over HTTP.

## Session
Base URL: ${origin}
Target: ${target}

This URL is the session identity. Do not post to a different Plannotator URL or guess another port.

First verify the target:

\`\`\`sh
curl -s ${origin}/api/plan | jq '{mode, filePath, projectRoot}'
\`\`\`

Continue only when \`mode\` is \`"annotate-folder"\`. If it is not, stop and ask the user for the correct session.

## Folder-session limitation

External annotations are session-scoped and cannot currently bind an inline highlight to the linked document selected in a folder session. Submit sidebar-only feedback and name the exact file in the comment text. Do not submit \`COMMENT\` annotations in this mode.

## Posting feedback

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "gpt-live",
    "type": "GLOBAL_COMMENT",
    "text": "File: path/to/document.md\\n\\nDescribe the finding here."
  }'
\`\`\`

Use a stable, specific \`source\` value for this conversation. POSTing is live; there is no send or done step. Do not call \`/api/feedback\`, \`/api/approve\`, or \`/api/exit\`.

Before replacing your findings, delete only annotations created by your own source:

\`\`\`sh
curl -s -X DELETE "${origin}/api/external-annotations?source=gpt-live"
\`\`\`

Never clear all annotations. The API has no authentication and is intended for tools with access to the user's local Plannotator session.
`;
  }

  return `# Plannotator — External Annotate Feedback

You can review ${target} and submit feedback to this specific live Plannotator Annotate session over HTTP. The user sees each annotation immediately and can edit or delete it before sending feedback.

## Session
Base URL: ${origin}
Target: ${target}

This URL is the session identity. Do not post to a different Plannotator URL or guess another port.

## Verify and read the document

\`\`\`sh
curl -s ${origin}/api/plan | jq '{mode, filePath, renderAs}'
curl -s ${origin}/api/plan | jq -r 'if .renderAs == "html" then .rawHtml else .plan end'
\`\`\`

Continue only when \`mode\` is \`"annotate"\` or \`"annotate-last"\`. If it is not, stop and ask the user for the correct session.

## Annotation shapes

- **Inline comment:** highlights an exact phrase and appears in the sidebar. Use \`type: "COMMENT"\` with \`originalText\`.
- **Global comment:** appears only in the sidebar. Use \`type: "GLOBAL_COMMENT"\` without \`originalText\`.

Line numbers are not supported. For an inline comment, copy \`originalText\` verbatim from the document and choose a phrase that occurs only once.

### Inline comment

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "gpt-live",
    "type": "COMMENT",
    "originalText": "exact text copied from the document",
    "text": "Describe the finding here."
  }'
\`\`\`

### Global comment

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "gpt-live",
    "type": "GLOBAL_COMMENT",
    "text": "Describe the document-level finding here."
  }'
\`\`\`

To post several findings atomically, send \`{"annotations": [...]}\`. A successful POST returns \`201 {"ids": ["<uuid>"]}\`.

Use a stable, specific \`source\` value for this conversation. POSTing is live; there is no send or done step. Do not call \`/api/feedback\`, \`/api/approve\`, or \`/api/exit\`.

## Verify and revise your findings

\`\`\`sh
curl -s ${origin}/api/external-annotations | jq
curl -s -X DELETE "${origin}/api/external-annotations?source=gpt-live"
\`\`\`

Delete only annotations created by your own source before reposting. Never clear all annotations.

The document can change during the session. Refetch \`/api/plan\` before a new review pass. The API has no authentication and is intended for tools with access to the user's local Plannotator session.
`;
}
