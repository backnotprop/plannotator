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

## Two kinds of comment

You have exactly two shapes to choose from:

- **Inline comment** — pinned to a specific phrase in the plan. The matched phrase gets a yellow highlight in the rendered plan and the comment appears in the sidebar. Use this for feedback about a particular sentence, step, or block.
- **Global comment** — not tied to any phrase. Sidebar entry only. Use this for high-level feedback like "this plan is missing a rollback section" or "the ordering of steps 3 and 4 should be swapped."

## Posting an inline comment

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

\`originalText\` must be a verbatim substring of the plan body. Pick something unique enough that it appears once — longer is safer than shorter. If the substring doesn't match anything in the rendered plan, the comment silently falls back to sidebar-only.

## Posting a global comment

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "claude-code",
    "type": "GLOBAL_COMMENT",
    "text": "Missing a rollback section. Steps 3 and 4 should also be swapped."
  }'
\`\`\`

Both endpoints return \`201 {"ids": ["<uuid>"]}\` on success, \`400 {"error": "..."}\` on validation failure.

### Fields

| Field | Required | Notes |
|---|---|---|
| \`source\` | yes | Stable identifier for *you* (e.g. \`"claude-code"\`, \`"codex"\`, \`"my-linter"\`). Reuse the same value for every annotation you post — it lets you clean up your own later. Pick something specific enough that it won't collide with other tools running against the same session. |
| \`text\` | yes | The comment body the user will read. |
| \`type\` | yes | \`"COMMENT"\` for inline, \`"GLOBAL_COMMENT"\` for sidebar-only. |
| \`originalText\` | for \`COMMENT\` | A verbatim substring of the plan body. Required when \`type\` is \`"COMMENT"\`. Omit for \`"GLOBAL_COMMENT"\`. |
| \`author\` | no | Human-readable label shown next to the comment (e.g. \`"Claude Opus"\`). |

## Batching

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "annotations": [
      {"source": "claude-code", "type": "COMMENT", "text": "Missing error case.", "originalText": "open the file"},
      {"source": "claude-code", "type": "COMMENT", "text": "This assumes the cache is warm — flag it.", "originalText": "look up the user in the cache"},
      {"source": "claude-code", "type": "GLOBAL_COMMENT", "text": "Overall structure looks good. Add a rollback section."}
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
