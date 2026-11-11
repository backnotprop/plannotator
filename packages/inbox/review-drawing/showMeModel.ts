import { shapeHtmlMarks, type ShapeCodeTarget } from '@plannotator/core/shape';
import { guideDiagramIsDrawn } from '@plannotator/core/guide-format';
import type { GuideOverviewDiagram } from '@plannotator/core/guide';

export function baseName(path: string): string {
  return path.slice(path.lastIndexOf('/') + 1);
}

export function overviewPicture(diagram: GuideOverviewDiagram | undefined): GuideOverviewDiagram | null {
  return diagram?.kind === 'html' && guideDiagramIsDrawn(diagram) ? diagram : null;
}

type Place = { file: string | null; lines: readonly [number, number] | null };

/** The same file with the selection inside the asked lines, or sharing at least half of the lines the two cover together. */
export function showMeSamePlace(asked: Place & { part?: unknown }, place: Place): boolean {
  if (asked.part) return false;
  if (place.file === null || place.lines === null) return asked.file === null && asked.lines === null;
  if (asked.file !== place.file || !asked.lines) return false;
  const [a0, a1] = asked.lines;
  const [p0, p1] = place.lines;
  if (p0 >= a0 && p1 <= a1) return true;
  const shared = Math.min(a1, p1) - Math.max(a0, p0) + 1;
  const together = Math.max(a1, p1) - Math.min(a0, p0) + 1;
  return shared > 0 && shared * 2 >= together;
}

interface ShowMeTurn {
  id: string;
  kind?: 'show_me';
  show_me?: { review: string | null; file: string | null; lines: [number, number] | null; part?: { board: string } };
  shape?: string;
  answer?: string;
  stopped?: boolean;
  failure?: string;
}

export function waitingShowMe<T extends ShowMeTurn>(turns: readonly T[], reviewId: string, place: Place, running: string | null, live: string | null): T | undefined {
  return turns
    .filter((turn) => turn.kind === 'show_me' && turn.show_me?.review === reviewId && showMeSamePlace(turn.show_me, place))
    .filter((turn) => !turn.shape && turn.answer === undefined && !turn.stopped && turn.failure === undefined)
    .filter((turn) => turn.id === running || turn.id === live)
    .at(-1);
}

export function chapterOf(chapters: readonly { diffs: readonly { file: string }[] }[], path: string): number | null {
  const at = chapters.findIndex((chapter) => chapter.diffs.some((ref) => ref.file === path));
  return at < 0 ? null : at;
}

export function targetLines(target: ShapeCodeTarget): [number, number] {
  return [target.line, target.lineEnd ?? target.line];
}

export { partName } from '@plannotator/ui/components/shape/partName';

export function markOf(el: Element): string | null {
  return el.closest('[data-mark]')?.getAttribute('data-mark') ?? null;
}

export function changedMarks(before: readonly string[], after: readonly string[]): Set<string> {
  const was = new Map<string, string>();
  for (const html of before) for (const mark of shapeHtmlMarks(html)) if (!was.has(mark.id)) was.set(mark.id, mark.text);
  const out = new Set<string>();
  const seen = new Set<string>();
  for (const html of after) {
    for (const mark of shapeHtmlMarks(html)) {
      if (seen.has(mark.id)) continue;
      seen.add(mark.id);
      if (was.get(mark.id) !== mark.text) out.add(mark.id);
    }
  }
  return out;
}

export function newSideLines(patch: string): Map<number, string> {
  const out = new Map<number, string>();
  let line = 0;
  let inHunk = false;
  for (const raw of patch.split('\n')) {
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) {
      line = Number(hunk[1]);
      inHunk = true;
      continue;
    }
    if (!inHunk || raw === '' || raw.startsWith('-') || raw.startsWith('\\')) continue;
    if (raw.startsWith('+') || raw.startsWith(' ')) {
      out.set(line, raw.slice(1));
      line += 1;
    } else {
      inHunk = false;
    }
  }
  return out;
}

export interface PartAnchor {
  now: ShapeCodeTarget;
  changed: boolean;
}

export function anchorPart(target: ShapeCodeTarget, before: ReadonlyMap<number, string> | undefined, after: ReadonlyMap<number, string> | undefined): PartAnchor {
  const [start, end] = targetLines(target);
  const block: string[] = [];
  for (let n = start; n <= end; n++) {
    const text = before?.get(n);
    if (text === undefined) return { now: target, changed: false };
    block.push(text);
  }
  const matchesAt = (at: number) => block.every((text, i) => after?.get(at + i) === text);
  if (matchesAt(start)) return { now: target, changed: false };
  const moved = [...(after?.keys() ?? [])].sort((a, b) => Math.abs(a - start) - Math.abs(b - start)).find(matchesAt);
  if (moved !== undefined) return { now: { ...target, line: moved, ...(target.lineEnd !== undefined ? { lineEnd: moved + (end - start) } : {}) }, changed: false };
  return { now: target, changed: true };
}

export function anchorLines(
  lines: readonly [number, number],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): [number, number] | null {
  for (let n = lines[0]; n <= lines[1]; n++) if (before?.get(n) === undefined) return null;
  const anchor = anchorPart({ path: '', line: lines[0], ...(lines[1] > lines[0] ? { lineEnd: lines[1] } : {}) }, before, after);
  return anchor.changed ? null : targetLines(anchor.now);
}

/** Null whenever unknown: a fresh Show me is always safe, an old picture on other code is not. */
export function shiftLines(
  lines: readonly [number, number],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): [number, number] | null {
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

function guideLines(before: ReadonlyMap<number, string>, after: ReadonlyMap<number, string>): [number, number][] {
  const once = (side: ReadonlyMap<number, string>) => {
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
  // A line that moved past others is no guide.
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

export function earlierLinesNow(
  lines: readonly [number, number],
  before: ReadonlyMap<number, string> | undefined,
  after: ReadonlyMap<number, string> | undefined,
): [number, number] | null {
  return anchorLines(lines, before, after) ?? shiftLines(lines, before, after);
}

export type ReviewLines = ReadonlyMap<string, ReadonlyMap<number, string>>;

export function reviewLines(files: readonly { path: string; patch: string }[]): ReviewLines {
  return new Map(files.filter((file) => file.patch.includes('@@')).map((file) => [file.path, newSideLines(file.patch)] as const));
}

export function reviewDrawnOn(
  through: string | null | undefined,
  messages: readonly { id: string; created_at?: string; guide?: { review?: unknown } | null }[],
  askedOn: string | undefined,
  at?: string,
): string | null {
  for (let i = through ? messages.findIndex((message) => message.id === through) : -1; i >= 0; i -= 1) {
    if (messages[i]!.guide?.review) return messages[i]!.id;
  }
  if (askedOn) return askedOn;
  const stored = at ? Date.parse(at) : NaN;
  const before = messages.filter((message) => message.guide?.review && message.created_at && Date.parse(message.created_at) <= stored);
  return before.at(-1)?.id ?? null;
}

export function partLanding(target: ShapeCodeTarget, now: ReviewLines, earlier?: { lines: ReviewLines | undefined } | null): [number, number] | 'changed' | null {
  const after = now.get(target.path);
  if (!after) return null;
  if (after.size === 0) return 'changed';
  if (earlier === null) return null;
  const asked = targetLines(target);
  const numbers = Array.from({ length: asked[1] - asked[0] + 1 }, (_, i) => asked[0] + i);
  if (!earlier) return numbers.some((n) => after.has(n)) ? asked : null;
  if (!earlier.lines) return 'changed';
  const before = earlier.lines.get(target.path);
  if (!numbers.every((n) => before?.has(n))) return null;
  return earlierLinesNow(asked, before, after) ?? 'changed';
}

export function showMeEnded(turn: { answer?: string; stopped?: boolean; shape?: string } | undefined, now: { running: boolean; busy: boolean }): boolean {
  return !now.running && !now.busy && !turn?.shape && !turn?.stopped && turn?.answer === undefined;
}

export function boardParents(turns: readonly { shape?: string; show_me?: { part?: { board: string } } }[]): Map<string, string> {
  const parents = new Map<string, string>();
  for (const turn of turns) {
    const child = turn.shape;
    const parent = turn.show_me?.part?.board;
    if (!child || !parent || child === parent || parents.has(child)) continue;
    let up: string | undefined = parent;
    while (up && up !== child) up = parents.get(up);
    if (up === child) continue;
    parents.set(child, parent);
  }
  return parents;
}

export interface BoardRow {
  id: string;
  title: string;
  depth: number;
  parent: string | null;
}

export function boardRows(boards: readonly { id: string; title: string }[], parents: ReadonlyMap<string, string>): BoardRow[] {
  const ids = new Set(boards.map((board) => board.id));
  const order = [...boards].sort((a, b) => a.id.localeCompare(b.id));
  const under = new Map<string | null, typeof order>();
  for (const board of order) {
    const from = parents.get(board.id);
    const key = from && ids.has(from) ? from : null;
    under.set(key, [...(under.get(key) ?? []), board]);
  }
  const rows: BoardRow[] = [];
  const walk = (parent: string | null, depth: number) => {
    for (const board of under.get(parent) ?? []) {
      rows.push({ id: board.id, title: board.title, depth, parent });
      walk(board.id, depth + 1);
    }
  };
  walk(null, 0);
  return rows;
}

export function boardPressWaits(box: { words: string; turn: string | null } | null, posting: boolean): 'wait' | 'go' {
  if (box?.turn || posting) return 'wait';
  return box && box.words.trim() ? 'wait' : 'go';
}
