/**
 * Compose the per-message "changes under review" preamble for Ask AI.
 *
 * `reviewContext` is the server-built changeset description (from the shared
 * agent-review prompt machine — the same text the launchable review jobs get).
 * It is either a short git command to run, or a pasted diff for view modes git
 * can't reproduce (stacked-PR full-stack, hide-whitespace, untracked, workspace).
 *
 * On the first message — and whenever the user switches what they're viewing
 * mid-chat, so the context string changes — we inject the full block so the
 * agent always sees exactly the on-screen changeset. On an unchanged follow-up
 * we avoid re-pasting a large diff (the conversation history already carries it)
 * and emit only a short reminder; a short command-based context is cheap enough
 * to restate every turn, which keeps the agent oriented.
 */
export function buildReviewContextPreamble(
  reviewContext: string | null | undefined,
  opts: { changed: boolean },
): string {
  const ctx = reviewContext?.trim();
  if (!ctx) return '';
  if (opts.changed) return ctx;
  // Unchanged follow-up. A pasted diff (fenced code block) must NOT be repeated
  // every turn; a command-based context is short, so restating it is fine.
  const isPasted = ctx.includes('```');
  return isPasted
    ? '[Still reviewing the same changes shown earlier in this conversation.]'
    : ctx;
}

const MAX_IDENTITY_FILES = 30;

/**
 * The code-review context for "Ask this session". The agent that opened the
 * review wrote (or can read) the changes, so it gets the diff's identity —
 * which comparison, against which base, which files — and never the patch
 * itself, which would land permanently in its context window.
 */
export function buildSessionReviewIdentity(review: {
  diffType?: string | null;
  base?: string | null;
  patch?: string | null;
}): string {
  const files: string[] = [];
  for (const match of (review.patch ?? '').matchAll(/^diff --git a\/.+? b\/(.+)$/gm)) {
    files.push(match[1]);
  }
  const lines: string[] = [];
  if (review.diffType) {
    lines.push(`Diff on screen: ${review.diffType}${review.base ? ` (against ${review.base})` : ''}`);
  } else if (review.base) {
    lines.push(`Diff on screen: against ${review.base}`);
  }
  if (files.length > 0) {
    const shown = files.slice(0, MAX_IDENTITY_FILES).join(', ');
    const more = files.length > MAX_IDENTITY_FILES ? ` (+${files.length - MAX_IDENTITY_FILES} more)` : '';
    lines.push(`Changed files (${files.length}): ${shown}${more}`);
  }
  return lines.join('\n');
}
