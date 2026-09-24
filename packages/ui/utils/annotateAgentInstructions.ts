/**
 * Builds the clipboard payload that teaches an external agent how to post
 * annotations into a live Plannotator **annotate** session via
 * /api/external-annotations. The annotate twin of `planAgentInstructions.ts`:
 * same endpoint and wire shape (annotate servers run the plan-mode
 * validator, `transformPlanInput` in `@plannotator/core/external-annotation`),
 * but it talks about a document instead of a plan, carries no deny/resubmit
 * loop, and adds one short section for the surface the session is showing.
 *
 * Only document what the validator accepts: POST takes `source`, `type`,
 * `text`, `originalText`, `author`, and a `diagramAnchor`; an element anchor
 * (`htmlAnchor`) is accepted by PATCH only.
 */

export type AnnotateInstructionsSurface =
  /** Markdown / plain-text file, URL, or converted HTML. */
  | 'markdown'
  /** Raw HTML file rendered as the page. */
  | 'html'
  /** A running local app mirrored through the live proxy. */
  | 'live-app'
  /** A whole-file Mermaid / Graphviz source rendered as one diagram. */
  | 'diagram'
  /** A folder session (file browser, one document open at a time). */
  | 'folder'
  /** annotate-last: the agent's own message. */
  | 'message';

interface SurfaceSection {
  /** The one command that fetches what the user is looking at. */
  read: (origin: string) => string;
  /** Surface-specific targeting rules, printed after the read command. */
  notes: (origin: string) => string;
}

const SURFACES: Record<AnnotateInstructionsSurface, SurfaceSection> = {
  markdown: {
    read: (origin) => `curl -s ${origin}/api/plan | jq -r .plan`,
    notes: () => `\`originalText\` is matched against the rendered text, so leave out markdown syntax such as \`**\` or \`#\`.`,
  },

  message: {
    read: (origin) => `curl -s ${origin}/api/plan | jq -r .plan`,
    notes: () => `The document is an agent message. \`originalText\` is matched against the rendered message text.`,
  },

  html: {
    read: (origin) => `curl -s ${origin}/api/plan | jq -r .rawHtml`,
    notes: (origin) => `The document is an HTML page rendered as a real web page. Quote its **visible text**, never markup: \`originalText\` is found by a text search of the rendered page.

To pin a comment to an element instead of a phrase, POST it first, then attach an element anchor with PATCH (POST ignores \`htmlAnchor\`):

\`\`\`sh
curl -s -X PATCH "${origin}/api/external-annotations?id=<uuid>" \\
  -H 'Content-Type: application/json' \\
  -d '{"htmlAnchor": {"selector": "#pricing > h2", "tagName": "h2", "text": "Pricing"}}'
\`\`\`

\`selector\` must match exactly one element; \`text\`, when given, is that element's visible text and is checked when the marker is restored.`,
  },

  'live-app': {
    read: (origin) => `curl -s ${origin}/api/plan | jq -r .targetUrl   # the running app; open or fetch it`,
    notes: () => `The user is annotating a running local app, so there is no document text in the API. Quote **visible text** from the app: it is highlighted wherever it is found on the page the user has open. A comment you post shows on every page; to tie it to one route, PATCH \`{"pageUrl": "/settings?tab=2"}\` (path plus query). Prefer \`GLOBAL_COMMENT\` for anything not about specific on-screen text.`,
  },

  diagram: {
    read: (origin) => `curl -s ${origin}/api/plan | jq -r .plan`,
    notes: () => `The document is one Mermaid or Graphviz diagram (the source above). To comment on a node, edge, or cluster, add a \`diagramAnchor\` naming it by its id in the source; \`originalText\` is the part's label:

\`\`\`json
{"source": "claude-code", "type": "COMMENT", "text": "Rename this step.",
 "originalText": "Start", "diagramAnchor": {"v": 1, "family": "flowchart", "kind": "node", "id": "A", "label": "Start"}}
\`\`\`

\`family\` is one of flowchart, state, class, er, requirement, sequence, other, graphviz; \`kind\` is node, edge (use \`from\` + \`to\` instead of \`id\`), cluster, or diagram (the whole diagram, no id). A malformed anchor is a 400; one that names no part of the diagram lists as unanchored.`,
  },

  folder: {
    read: (origin) => `curl -s "${origin}/api/doc?path=<path-relative-to-folder>" | jq -r .markdown`,
    notes: (origin) => `The user browses a folder (\`curl -s ${origin}/api/plan | jq -r .filePath\`) and opens one document at a time. No API tells you which document is open.

External comments cannot target a specific document. Every comment you post is a session-level entry: it lists in the annotations panel whichever document is open (or none), is **not** highlighted inline in folder documents, and is included in the feedback the user sends. Name the file in \`text\` and prefer \`GLOBAL_COMMENT\`.`,
  },
};

export function buildAnnotateAgentInstructions(
  origin: string,
  surface: AnnotateInstructionsSurface = 'markdown',
): string {
  const section = SURFACES[surface];
  return `# Plannotator — External Annotations (annotate session)

You can leave review comments on the document the user is annotating by POSTing to a small HTTP API. They appear immediately in the user's annotations panel (and as highlights where the quoted text is found). The user decides what to send back to their agent; there is no approve, deny, or submit endpoint for you.

## Base URL
${origin}

All endpoints below are relative to that base. No authentication.

## Read the document

\`\`\`sh
${section.read(origin)}
\`\`\`

Line numbers do not apply. Inline comments are pinned by quoting a verbatim phrase in \`originalText\`. ${section.notes(origin)}

## Post comments

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "annotations": [
      {"source": "claude-code", "type": "COMMENT", "text": "This claim needs a source.", "originalText": "adoption doubled last year"},
      {"source": "claude-code", "type": "GLOBAL_COMMENT", "text": "The intro and summary contradict each other."}
    ]
  }'
\`\`\`

A single annotation can be posted without the \`annotations\` wrapper. Returns \`201 {"ids": [...]}\`, or \`400 {"error": "..."}\` (batches are all-or-nothing).

| Field | Required | Notes |
|---|---|---|
| \`source\` | yes | Stable identifier for you (e.g. \`"claude-code"\`); reuse it so you can clean up later. |
| \`text\` | yes | The comment body. |
| \`type\` | yes | \`"COMMENT"\` (pinned to \`originalText\`) or \`"GLOBAL_COMMENT"\` (panel only). |
| \`originalText\` | for \`COMMENT\` | A verbatim phrase from the document. If it is not found, the comment stays in the panel without a highlight. |
| \`author\` | no | Label shown next to the comment. |

## List, edit, delete

\`\`\`sh
curl -s ${origin}/api/external-annotations | jq                            # list
curl -s -X PATCH "${origin}/api/external-annotations?id=<uuid>" \\
  -H 'Content-Type: application/json' -d '{"text": "Reworded."}'           # edit
curl -s -X DELETE "${origin}/api/external-annotations?source=claude-code"  # remove yours before re-posting
\`\`\`

## Notes
- Posting the same comment twice creates two entries; delete by \`source\` before a re-run.
- The document can change while the session is open; re-read it before re-posting.
- This API is local to the user's machine. Treat it as a UI surface, not a public service.
`;
}

/** Which surface section an annotate session's instructions carry. A folder
 *  session is a folder whatever file type is open (the scoping rule is what
 *  the agent needs to know); a live app wins over its HTML render. */
export function resolveAnnotateInstructionsSurface(input: {
  liveApp: boolean;
  annotateSource: 'file' | 'message' | 'folder' | null;
  renderAs: string;
}): AnnotateInstructionsSurface {
  if (input.liveApp) return 'live-app';
  if (input.annotateSource === 'folder') return 'folder';
  if (input.annotateSource === 'message') return 'message';
  if (input.renderAs === 'html') return 'html';
  if (input.renderAs === 'mermaid' || input.renderAs === 'graphviz') return 'diagram';
  return 'markdown';
}
