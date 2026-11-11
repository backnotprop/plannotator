/** Compose the per-message "changes under review" preamble for Ask AI. */
export function buildReviewContextPreamble(
  reviewContext: string | null | undefined,
  opts: { changed: boolean },
): string {
  const ctx = reviewContext?.trim();
  if (!ctx) return '';
  if (opts.changed) return ctx;
  // A pasted diff (fenced code block) must NOT be repeated every turn; a command-based context is
  // short, so restating it is fine.
  const isPasted = ctx.includes('```');
  return isPasted
    ? '[Still reviewing the same changes shown earlier in this conversation.]'
    : ctx;
}

const MAX_IDENTITY_FILES = 30;

/** The code-review context for "Ask this session". */
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
