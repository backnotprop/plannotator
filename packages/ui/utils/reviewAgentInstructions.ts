/**
 * Builds the clipboard payload that teaches an external agent (Claude Code,
 * Codex, custom scripts, etc.) how to post annotations into a live Plannotator
 * **code-review** session via the /api/external-annotations HTTP API.
 *
 * The body is intentionally short so an agent can read it top-to-bottom and
 * start posting in under a minute. Edit freely — this file is the single source
 * of truth for the review agent-facing contract surface.
 *
 * The only dynamic value is `origin`, which is interpolated at click time from
 * `window.location.origin` so the agent gets the correct base URL whether the
 * server is running on a random local port or the fixed remote port (19432).
 */
export function buildReviewAgentInstructions(origin: string): string {
  return `# Plannotator — External Review Comments

You can submit review feedback on the user's current code-review session by POSTing annotations to a small HTTP API. The user will see them immediately — pinned inline to the relevant diff lines, plus entries in a sidebar — and can accept, edit, or delete them.

This is one-way submission. Any tool can post: linters, agents, scripts. The user does not see who you are unless you tell them via \`text\` or \`author\`.

## Base URL
${origin}

All endpoints below are relative to that base. No authentication.

## Workflow
1. Read the diff so you know what to comment on.
2. POST your annotations (single or batch).
3. Optionally clean up your previous annotations before reposting on a re-run.

There is no "send" or "done" step — each POST is live the moment it lands.

## Reading the diff

\`\`\`sh
curl -s ${origin}/api/diff | jq -r .rawPatch
\`\`\`

This returns the unified diff (\`rawPatch\`) the user is reviewing. Comment line numbers come straight from the diff's hunk headers:

\`\`\`
@@ -<oldStart>,<oldLen> +<newStart>,<newLen> @@
\`\`\`

- For added or unchanged context lines, count from \`newStart\` and post with \`"side": "new"\`.
- For removed lines, count from \`oldStart\` and post with \`"side": "old"\`.

Use the **file line number**, not the line's position within the diff. \`side\` defaults to \`"new"\` — only set \`"old"\` when commenting on a deleted line.

## Three kinds of comment (\`scope\`)

- **Line comment** (\`scope: "line"\`, the default) — pinned to a specific line range in one file. Requires \`filePath\`, \`lineStart\`, \`lineEnd\`. Use for feedback about specific code.
- **File comment** (\`scope: "file"\`) — pinned to a whole file, shown as a banner in that file's header. Requires \`filePath\`; no line numbers. Use for feedback about the file as a whole.
- **General comment** (\`scope: "general"\`) — not tied to any file. Sidebar entry only. Use for review-level feedback like "the error handling is inconsistent across these changes."

## Posting a line comment

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "claude-code",
    "scope": "line",
    "filePath": "src/server/auth.ts",
    "lineStart": 42,
    "lineEnd": 42,
    "side": "new",
    "text": "This reads the token before checking it exists — guard against undefined."
  }'
\`\`\`

## Posting a suggestion (proposed replacement code)

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "claude-code",
    "type": "suggestion",
    "filePath": "src/server/auth.ts",
    "lineStart": 42,
    "lineEnd": 44,
    "text": "Guard against a missing token.",
    "suggestedCode": "const token = req.headers.authorization;\\nif (!token) return res.status(401).end();"
  }'
\`\`\`

## Posting a file comment

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "claude-code",
    "scope": "file",
    "filePath": "src/server/auth.ts",
    "text": "This module mixes parsing and validation — consider splitting them."
  }'
\`\`\`

## Posting a general comment

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "source": "claude-code",
    "scope": "general",
    "text": "Error handling is inconsistent across these files — some throw, some return null."
  }'
\`\`\`

All endpoints return \`201 {"ids": ["<uuid>"]}\` on success, \`400 {"error": "..."}\` on validation failure.

### Fields

| Field | Required | Notes |
|---|---|---|
| \`source\` | yes | Stable identifier for *you* (e.g. \`"claude-code"\`, \`"codex"\`, \`"my-linter"\`). Reuse the same value for every annotation you post — it lets you clean up your own later. Pick something specific enough that it won't collide with other tools running against the same session. |
| \`scope\` | no | \`"line"\` (default), \`"file"\`, or \`"general"\`. |
| \`filePath\` | for \`line\` / \`file\` | Repo-relative path exactly as it appears in the diff (e.g. \`"src/server/auth.ts"\`). |
| \`lineStart\` | for \`line\` | File line number where the comment starts. |
| \`lineEnd\` | for \`line\` | File line number where the comment ends. Use the same value as \`lineStart\` for a single line. |
| \`side\` | no | \`"new"\` (default) for added/context lines, \`"old"\` for deleted lines. |
| \`type\` | no | \`"comment"\` (default), \`"suggestion"\`, or \`"concern"\`. |
| \`text\` | yes* | The comment body the user will read. |
| \`suggestedCode\` | no | Proposed replacement code, rendered as a suggestion block. *Either \`text\` or \`suggestedCode\` is required. |
| \`author\` | no | Human-readable label shown next to the comment (e.g. \`"Claude Opus"\`). |

A \`scope: "line"\` annotation must carry \`lineStart\` and \`lineEnd\` — a line comment missing its line numbers is rejected, not silently downgraded. If a line isn't present in the current diff view, the comment still appears in the sidebar but won't pin inline.

## Batching

\`\`\`sh
curl -s ${origin}/api/external-annotations \\
  -H 'Content-Type: application/json' \\
  -d '{
    "annotations": [
      {"source": "claude-code", "filePath": "src/server/auth.ts", "lineStart": 42, "lineEnd": 42, "text": "Guard against undefined token."},
      {"source": "claude-code", "scope": "file", "filePath": "src/server/auth.ts", "text": "Consider splitting parsing from validation."},
      {"source": "claude-code", "scope": "general", "text": "Overall the changes look solid. Add tests for the 401 path."}
    ]
  }'
\`\`\`

Batches are atomic: if any item fails validation, the whole batch is rejected with an error like \`annotations[2] missing required "lineStart" field\`.

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
- The diff can change underneath you. If the user switches diff type, base branch, or PR, refetch \`/api/diff\` — your prior line numbers may no longer match.
- No idempotency. Posting the same annotation twice creates two entries.
- This API is local to the user's machine. Treat it as a UI surface, not a public service.
`;
}
