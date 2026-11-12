const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)$/;

export interface CommentHunkTarget {
  side: 'LEFT' | 'RIGHT' | null;
  line: number | null;
  startLine?: number | null;
}

export function focusCommentHunk(hunk: string, target: CommentHunkTarget, leading = 3): string {
  const lines = hunk.split('\n');
  const bare = (l: string) => (l.endsWith('\r') ? l.slice(0, -1) : l);
  const headerIdx = lines.findIndex((l) => HUNK_HEADER.test(bare(l)));
  if (headerIdx < 0) return hunk;
  const header = bare(lines[headerIdx]).match(HUNK_HEADER)!;
  const eol = lines[headerIdx].endsWith('\r') ? '\r' : '';
  const prefix = lines.slice(0, headerIdx);
  const body = lines.slice(headerIdx + 1);
  if (body.some((l) => HUNK_HEADER.test(bare(l)))) return hunk;

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
    firstIdx = lastIdx;
  }

  const from = Math.max(0, firstIdx - lead);
  if (from === 0 && lastIdx === numbered.length - 1) return hunk;
  const kept = numbered.slice(from, lastIdx + 1);
  const oldCount = kept.filter((e) => e.old !== null).length;
  const newCount = kept.filter((e) => e.new !== null).length;
  const oldStart = oldCount === 0 ? Math.max(0, kept[0].oldAt - 1) : kept[0].oldAt;
  const newStart = newCount === 0 ? Math.max(0, kept[0].newAt - 1) : kept[0].newAt;
  const newHeader = `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@${header[5]}${eol}`;
  return [...prefix, newHeader, ...kept.map((e) => e.text)].join('\n');
}
