# Standalone Spawn Mode

Decouple Plannotator from the Claude Code hook lifecycle so it can work as a standalone tool that spawns its own interactive Claude Code session to act on feedback.

## Problem

Plannotator's plan review is tightly coupled to the `ExitPlanMode` hook — it reads plan content from hook stdin and writes approve/deny decisions back via stdout. This means:

- You can't use plan mode without Plannotator intercepting every plan
- You must review synchronously within the hook's lifecycle
- Removing the hooks (to use plan mode freely) removes all Plannotator functionality

Users want to open Plannotator independently, review at their own pace, and fire the feedback into a new Claude Code session when ready.

## Solution

Add a `--spawn` flag (and `PLANNOTATOR_SPAWN` env var) across all modes, plus a new `plan` subcommand for non-hook plan review. When spawn mode is active, feedback spawns a new interactive `claude` session instead of writing hook JSON to stdout.

## New `plan` Subcommand

Non-hook entry point for plan review. Three input modes:

```bash
# From file
plannotator plan ./roadmap.md

# From archive (opens archive browser, user picks a plan)
plannotator plan --archive

# From stdin pipe
cat plan.md | plannotator plan -
```

- First positional arg is the file path (or `-` for stdin)
- `--archive` flag opens the existing archive browser. When the user selects a plan from the archive list, it opens in the plan review UI (same as normal plan review, but with the archived plan content). The user can then annotate and "Send to Claude".
- Server reuse: calls `startPlannotatorServer()` with the same options as the hook path, but plan content comes from file/stdin/archive. Origin set to `"standalone"`.

## `--spawn` Flag and `PLANNOTATOR_SPAWN` Env Var

### Detection

Detection lives in the CLI entry point (`apps/hook/server/index.ts`), not in the server packages. The CLI resolves the flag/env var and passes `spawn: boolean` as an option to the server:

```typescript
// In the CLI entry point
function isSpawnMode(): boolean {
  return process.argv.includes('--spawn') ||
    ['1', 'true'].includes(process.env.PLANNOTATOR_SPAWN?.toLowerCase() ?? '');
}

// Passed to server as an option
startPlannotatorServer({ plan, origin, spawn: isSpawnMode(), ... })
```

If `--spawn` is passed to a hook subcommand (default no-arg mode, `annotate-hook`, `review-hook`), it is ignored — hook subcommands always use the hook stdout path.

### Applies to All Modes

```bash
plannotator plan <source> --spawn        # plan review
plannotator review [PR-URL] --spawn      # code review
plannotator annotate <file.md> --spawn   # annotate
```

The env var `PLANNOTATOR_SPAWN` follows the same pattern as `PLANNOTATOR_REMOTE` — accepts `1` or `true`, case-insensitive.

### Behavior Change

When spawn mode is active, the post-decision handler changes. Instead of writing hook JSON to stdout (or printing feedback for slash commands), it spawns an interactive `claude` session. The existing hook paths are completely untouched — `--spawn` is only checked in the non-hook codepaths.

## Spawn Mechanics

When the user submits feedback and spawn mode is active:

1. Server receives the decision via `waitForDecision()`
2. Server shuts down
3. CLI constructs the full prompt (plan/diff/file content + exported annotations)
4. Writes the prompt to a temp file (avoids ARG_MAX limits for long plans)
5. Spawns `claude` interactively with a short prompt referencing the file:

```typescript
const feedbackPath = `/tmp/plannotator-spawn-${Date.now()}.md`
await Bun.write(feedbackPath, fullPrompt)

try {
  const proc = Bun.spawn(
    ["claude", `Read and act on the plan review feedback in ${feedbackPath}`],
    {
      cwd: projectRoot,
      stdin: "inherit",  // user gets full interactive control
      stdout: "inherit",
      stderr: "inherit",
    }
  )
  await proc.exited
} finally {
  await unlink(feedbackPath).catch(() => {})  // best-effort cleanup
}
```

### Prompt Content by Mode

- **Plan:** Full plan markdown + exported annotations + "Address the feedback in these annotations."
- **Review:** Summary of what's being reviewed (PR URL or git ref) + diff context + annotations + PR comment responses + "Address the review feedback."
- **Annotate:** File path + file content + annotations + "Address the annotations."

The temp file uses the same `exportAnnotations()` format that already exists for hook feedback, so the prompt is human-readable markdown that Claude can act on directly.

## PR Comment Integration (Review Mode)

When reviewing a PR URL with `plannotator review <PR-URL> --spawn`:

### Fetching Comments

The review server uses `gh api` to fetch PR review comments alongside the diff:

```bash
gh api repos/{owner}/{repo}/pulls/{number}/comments    # inline review comments
gh api repos/{owner}/{repo}/issues/{number}/comments    # top-level PR comments
```

### UI Presentation

Comments appear inline on the diff, positioned at the file/line they reference. Top-level PR comments appear in a separate section. Each comment shows author, timestamp, and body.

### Annotating Comments

The user can:
- Annotate diff lines as usual (existing behavior)
- Select/respond to specific PR comments — clicking a comment opens an annotation input tied to that comment's ID

### Data Model Extension

Annotations get an optional `prComment` field:

```typescript
interface Annotation {
  // ...existing fields...
  prComment?: {
    id: number;        // GitHub comment ID
    author: string;    // Comment author
    body: string;      // Comment text (for context in export)
    path?: string;     // File path (for inline comments)
    line?: number;     // Line number (for inline comments)
  };
}
```

### Export Format

When exporting feedback for the spawned session, PR comment responses include context:

```markdown
## PR Comment Responses

### @reviewer on src/auth.ts:42
> "Should we add rate limiting here?"

Response: Yes, I've annotated the specific approach below. Use a token bucket with 100 req/min.
```

This gives the spawned Claude session enough context to act on each comment without needing to re-fetch the PR.

## UI Changes in Spawn Mode

The server passes `spawn: boolean` in its options. The `/api/plan` and `/api/diff` GET endpoints include `spawn: true` when active.

### Button Labels

| Mode | Current buttons | Spawn mode buttons |
|------|----------------|-------------------|
| Plan review | "Approve" / "Request Changes" | "Send to Claude" / "Dismiss" |
| Code review | "Approve" / "Send Feedback" | "Send to Claude" / "Dismiss" |
| Annotate | "Send Annotations" | "Send to Claude" / "Dismiss" |

"Send to Claude" submits feedback and triggers the spawn. "Dismiss" closes the UI and cleanly exits the process without spawning a session (equivalent to the user deciding not to act on the review).

No structural UI changes. The annotation system, diff viewer, toolbar, settings all stay the same.

## File Organization

### New Files

- `packages/server/spawn.ts` — `isSpawnMode()` detection, `spawnClaudeSession(projectRoot, prompt)` helper, temp file management

### Modified Files

- `apps/hook/server/index.ts` — New `plan` subcommand (file/archive/stdin input), `--spawn` flag threading for `plan`, `review`, and `annotate` subcommands. Post-decision handler branches: hook stdout vs. spawn.
- `packages/server/index.ts` — Accept `spawn` option, include it in `/api/plan` response
- `packages/server/review.ts` — Accept `spawn` option, include it in `/api/diff` response. New endpoint for PR comment fetching (`/api/pr-comments`). PR comment data model additions.
- `packages/server/annotate.ts` — Accept `spawn` option, include it in `/api/plan` response
- `packages/ui/types.ts` — `prComment` field on `Annotation`, PR comment types
- `packages/editor/App.tsx` — Conditional button labels for plan review and annotate modes based on `spawn` flag (approve/deny buttons around lines 1158-1197)
- `packages/review-editor/App.tsx` — Conditional button labels for code review based on `spawn` flag (approve/feedback buttons around lines 1244-1309)
- `packages/review-editor/` — PR comment display components, comment annotation interaction
- `CLAUDE.md` — Document new `plan` subcommand, `--spawn` flag, `PLANNOTATOR_SPAWN` env var

### Not Modified

Hook paths (`hooks.json`, hook-stdin parsing, `annotate-hook`/`review-hook` subcommands) — completely untouched.

## Environment Variables (Updated)

| Variable | Description |
|----------|-------------|
| `PLANNOTATOR_SPAWN` | Set to `1` or `true` to enable spawn mode. Feedback spawns a new `claude` session instead of writing hook output. |

Added alongside existing `PLANNOTATOR_REMOTE`, `PLANNOTATOR_PORT`, `PLANNOTATOR_BROWSER`, `PLANNOTATOR_SHARE`, `PLANNOTATOR_SHARE_URL`, `PLANNOTATOR_PASTE_URL`.
