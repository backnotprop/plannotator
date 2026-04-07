/**
 * Builds the clipboard payload that teaches an external agent (Claude Code,
 * Codex, custom scripts, etc.) how to post annotations into a live Plannotator
 * **plan-review** session via the /api/external-annotations HTTP API.
 *
 * Plan mode and code-review mode have different annotation shapes (plan uses
 * `originalText` for inline highlighting; review uses `filePath` + line ranges
 * + severity), so each mode owns its own instructions module. The
 * code-review counterpart will live alongside this file when it's added.
 *
 * The body is intentionally short (~110 lines of markdown) so an agent can read
 * it top-to-bottom and start posting in 30 seconds. Edit freely — this file is
 * the single source of truth for the agent-facing contract surface.
 *
 * The only dynamic value is `origin`, which is interpolated at click time from
 * `window.location.origin` so the agent gets the correct base URL whether the
 * server is running on a random local port or the fixed remote port (19432).
 */
export function buildPlanAgentInstructions(origin: string): string {
  return `# Plannotator — External Annotations

You can submit review feedback on the user's current plan-review session by POSTing annotations to a small HTTP API. The user will see them immediately — inline highlights on the plan and entries in a sidebar — and can accept, edit, or delete them.

This is one-way submission. Any tool can post: linters, agents, scripts. The user does not see who you are unless you tell them via \`text\` or \`author\`.

## Base URL
${origin}

All endpoints below are relative to that base. No authentication.

## Workflow
1. Read the plan so you know what to comment on.
2. POST your annotations (single or batch).
3. Optionally clean up your previous annotations before reposting on a re-run.

There is no "send" or "done" step — each POST is live the moment it lands.

## Reading the plan

\`\`\`sh
curl -s ${origin}/api/plan | jq -r .plan
\`\`\`

**Line numbers do not apply and cannot be referenced.** The renderer pins your comments to the plan by matching the \`originalText\` field as a verbatim substring of the rendered text. Quote the exact phrase, never say "line 12."

## Posting an annotation

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "claude-code",
    "type": "COMMENT",
    "text": "This step needs error handling.",
    "originalText": "open the file and parse it"
  }'
\`\`\`

Response on success: \`201 {"ids": ["<uuid>"]}\`. On validation failure: \`400 {"error": "..."}\`.

### Fields

| Field | Required | Notes |
|---|---|---|
| \`source\` | yes | Stable identifier for *you* (e.g. \`"claude-code"\`, \`"codex"\`, \`"my-linter"\`). Reuse the same value for every annotation you post — it lets you clean up your own later. Pick something specific enough that it won't collide with other tools running against the same session. |
| \`text\` | yes | The comment body the user will read. |
| \`type\` | no | \`"COMMENT"\`, \`"DELETION"\`, or \`"GLOBAL_COMMENT"\`. Defaults to \`"GLOBAL_COMMENT"\`. |
| \`originalText\` | depends | A verbatim substring of the plan body. **Required** for \`"DELETION"\`. **Optional** for \`"COMMENT"\` — including it turns on inline highlighting, omitting it gives you a sidebar-only entry. **Not used** for \`"GLOBAL_COMMENT"\` — leave it out. |
| \`author\` | no | Human-readable label shown next to the comment (e.g. \`"Claude Opus"\`). |

### Choosing a type

- **\`COMMENT\` with \`originalText\`** — yellow inline highlight on the matched phrase + sidebar entry. Use for specific feedback tied to a particular phrase.
- **\`COMMENT\` without \`originalText\`** — sidebar only. Use when the comment doesn't pin to one phrase.
- **\`DELETION\` with \`originalText\`** — strikethrough on the matched phrase + sidebar entry. Use to suggest removing wording. \`originalText\` is mandatory here.
- **\`GLOBAL_COMMENT\`** — sidebar only, not tied to any phrase. Use for high-level feedback like "this plan is missing a rollback section."

If \`originalText\` doesn't match anything in the rendered plan, the annotation silently degrades to sidebar-only. Pick substrings that are unique — longer is safer than shorter.

## Batching

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "annotations": [
      {"source": "claude-code", "type": "COMMENT", "text": "Missing error case.", "originalText": "open the file"},
      {"source": "claude-code", "type": "DELETION", "text": "Dead code.", "originalText": "legacy fallback path"},
      {"source": "claude-code", "type": "GLOBAL_COMMENT", "text": "Overall structure looks good."}
    ]
  }'
\`\`\`

Batches are atomic: if any item fails validation, the whole batch is rejected with an error like \`annotations[2] missing required "text" field\`.

## Listing and deleting

\`\`\`sh
# List everything (yours and others')
curl -s ${origin}/api/external-annotations | jq

# Delete one annotation by id — works on any source, including the user's
curl -s -X DELETE "${origin}/api/external-annotations?id=<uuid>"

# Delete all annotations from one source — the standard cleanup before reposting
curl -s -X DELETE "${origin}/api/external-annotations?source=claude-code"

# Delete everything in the session
curl -s -X DELETE ${origin}/api/external-annotations
\`\`\`

You have full delete authority. Use it responsibly.

## Cleaning up on a re-run

If you re-run on the same session, your previous annotations are still there. POSTing again will create duplicates. Standard pattern:

\`\`\`sh
curl -s -X DELETE "${origin}/api/external-annotations?source=claude-code"
curl -s ${origin}/api/external-annotations -H 'Content-Type: application/json' -d '{ ...fresh annotations... }'
\`\`\`

This is why \`source\` matters. Pick a stable identifier and stick with it.

## Notes
- The plan can change underneath you. If the user denies and resubmits, refetch \`/api/plan\` — your prior \`originalText\` substrings may no longer match.
- No idempotency. Posting the same annotation twice creates two entries.
- This API is local to the user's machine. Treat it as a UI surface, not a public service.
`;
}
