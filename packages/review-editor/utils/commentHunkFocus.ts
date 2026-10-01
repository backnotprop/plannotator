/**
 * Narrow a review comment's `diffHunk` to the lines around the comment.
 *
 * GitHub's `diffHunk` (and the Bitbucket equivalent cut from the PR diff)
 * runs from the enclosing hunk's header down to the commented line. The
 * collapsed preview clips from the top, so a comment far into a long hunk
 * (a new file, a big added block) showed the hunk's first lines instead of
 * the commented ones. This keeps a single commented line plus a few lines
 * before it, or a commented range as is (the range is the context), and
 * rewrites the `@@` header to match, so the preview opens on the right code.
 * "Show full context" still renders the full hunk.
 *
 * Returns the hunk unchanged whenever it cannot be parsed or the commented
 * line is not found in it.
 */

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export interface CommentHunkTarget {
  side: 'LEFT' | 'RIGHT' | null;
  line: number | null;
  startLine?: number | null;
}

export function focusCommentHunk(hunk: string, target: CommentHunkTarget, leading = 3): string {
  // CRLF hunks (GitHub keeps a file's line endings): match on the line
  // without its \r, and write the rewritten header back with one.
  const lines = hunk.split('\n');
  const bare = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  const headerIdx = lines.findIndex((l) => HUNK_HEADER.test(bare(l)));
  if (headerIdx < 0) return hunk;
  const header = bare(lines[headerIdx]).match(HUNK_HEADER)!;
  const eol = lines[headerIdx].endsWith('\r') ? '\r' : '';
  const prefix = lines.slice(0, headerIdx);
  const body = lines.slice(headerIdx + 1);
  // One hunk only: numbering does not restart at a second header.
  if (body.some((l) => HUNK_HEADER.test(bare(l)))) return hunk;

  // Old/new line number of every body line (null when not on that side).
  let oldNo = Number(header[1]);
  let newNo = Number(header[3]);
  const numbered = body.map((text) => {
    const kind = text[0];
    if (kind !== ' ' && kind !== '+' && kind !== '-') return { text, old: null, new: null, oldAt: oldNo, newAt: newNo };
    const entry = {
      text,
      old: kind !== '+' ? oldNo : null,
      new: kind !== '-' ? newNo : null,
      oldAt: oldNo,
      newAt: newNo,
    };
    if (kind !== '+') oldNo++;
    if (kind !== '-') newNo++;
    return entry;
  });

  let firstIdx: number;
  let lead = leading;
  let lastIdx = numbered.length - 1;
  while (lastIdx >= 0 && bare(numbered[lastIdx].text) === '') lastIdx--;
  if (lastIdx < 0) return hunk;

  if (target.side && target.line != null) {
    const key = target.side === 'LEFT' ? 'old' : 'new';
    const end = numbered.findIndex((e) => e[key] === target.line);
    if (end < 0) return hunk;
    const startNo = target.startLine != null && target.startLine < target.line ? target.startLine : target.line;
    const start = numbered.findIndex((e) => e[key] === startNo);
    firstIdx = start >= 0 && start <= end ? start : end;
    if (firstIdx < end) lead = 0;
    lastIdx = end;
  } else {
    // Outdated or unanchored: the hunk still ends on the commented line.
    firstIdx = lastIdx;
  }

  const from = Math.max(0, firstIdx - lead);
  if (from === 0 && lastIdx === numbered.length - 1) return hunk;
  const kept = numbered.slice(from, lastIdx + 1);
  const oldCount = kept.filter((e) => e.old !== null).length;
  const newCount = kept.filter((e) => e.new !== null).length;
  // Unified-diff convention: an empty side names the line before it.
  const oldStart = oldCount === 0 ? Math.max(0, kept[0].oldAt - 1) : kept[0].oldAt;
  const newStart = newCount === 0 ? Math.max(0, kept[0].newAt - 1) : kept[0].newAt;
  const newHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${header[5]}${eol}`;
  return [...prefix, newHeader, ...kept.map((e) => e.text)].join('\n');
}
