export type SideLines = ReadonlyMap<number, string>;

function sideLines(patch: string, side: 'old' | 'new'): Map<number, string> {
  const out = new Map<number, string>();
  const skip = side === 'new' ? '-' : '+';
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(side === 'new' ? hunk[2] : hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw === '' || raw.startsWith(skip) || raw.startsWith('\\')) continue;
    if (raw.startsWith('+') || raw.startsWith('-') || raw.startsWith(' ')) {
      out.set(line, raw.slice(1));
      line += 1;
    } else {
      inHunk = false;
    }
  }
  return out;
}

export function newSideLines(patch: string): Map<number, string> {
  return sideLines(patch, 'new');
}

export function oldSideLines(patch: string): Map<number, string> {
  return sideLines(patch, 'old');
}

export function findBlock(start: number, end: number, before: SideLines | undefined, after: SideLines | undefined): { at: number; moved: boolean } | null {
  const block: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = before?.get(n);
    if (text === undefined) return null;
    block.push(text);
  }
  const matchesAt = (at: number) => block.every((text, i) => after?.get(at + i) === text);
  if (matchesAt(start)) return { at: start, moved: false };
  const moved = [...(after?.keys() ?? [])].sort((a, b) => Math.abs(a - start) - Math.abs(b - start)).find(matchesAt);
  return moved === undefined ? null : { at: moved, moved: true };
}

export function anchorLines(lines: readonly [number, number], before: SideLines | undefined, after: SideLines | undefined): [number, number] | null {
  const found = findBlock(lines[0], lines[1], before, after);
  return found ? [found.at, found.at + (lines[1] - lines[0])] : null;
}

export function shiftLines(lines: readonly [number, number], before: SideLines | undefined, after: SideLines | undefined): [number, number] | null {
  if (!before || !after) return null;
  const [first, last] = lines;
  for (let n = first; n <= last; n++) if (before.get(n) === undefined) return null;
  const kept = guideLines(before, after);
  const guide = new Map(kept);
  const above = kept.filter(([n]) => n < first).at(-1);
  const below = kept.find(([n]) => n > last);
  if (!above || !below) return null;
  const unchanged = (from: number, to: number, count: number) => {
    for (let i = 0; i < count; i++) {
      const text = before.get(from + i);
      if (text === undefined || after.get(to + i) !== text) return false;
    }
    return true;
  };
  const startFound = guide.get(first);
  const start = startFound ?? above[1] + (first - above[0]);
  if (startFound === undefined && !unchanged(above[0] + 1, above[1] + 1, first - above[0] - 1)) return null;
  const endFound = guide.get(last);
  const end = endFound ?? below[1] - (below[0] - last);
  if (endFound === undefined && !unchanged(last + 1, end + 1, below[0] - last - 1)) return null;
  if ((startFound === undefined || endFound === undefined) && end - start !== last - first) return null;
  if (start <= above[1] || end >= below[1] || start > end) return null;
  for (let n = start; n <= end; n++) if (after.get(n) === undefined) return null;
  return [start, end];
}

function guideLines(before: SideLines, after: SideLines): [number, number][] {
  const once = (side: SideLines) => {
    const seen = new Map<string, number | null>();
    for (const [n, text] of side) if (text.trim()) seen.set(text, seen.has(text) ? null : n);
    return seen;
  };
  const now = once(after);
  const pairs: [number, number][] = [];
  for (const [text, n] of once(before)) {
    const m = now.get(text);
    if (n !== null && m !== undefined && m !== null) pairs.push([n, m]);
  }
  pairs.sort((a, b) => a[0] - b[0]);
  const tails: number[] = [];
  const prev: number[] = [];
  for (let i = 0; i < pairs.length; i++) {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (pairs[tails[mid]!]![1] < pairs[i]![1]) lo = mid + 1;
      else hi = mid;
    }
    prev[i] = lo > 0 ? tails[lo - 1]! : -1;
    tails[lo] = i;
  }
  const kept: [number, number][] = [];
  for (let i = tails.length ? tails[tails.length - 1]! : -1; i >= 0; i = prev[i]!) kept.unshift(pairs[i]!);
  return kept;
}

export function earlierLinesNow(lines: readonly [number, number], before: SideLines | undefined, after: SideLines | undefined): [number, number] | null {
  return anchorLines(lines, before, after) ?? shiftLines(lines, before, after);
}
