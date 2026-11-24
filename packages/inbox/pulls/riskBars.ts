/**
 * The risk bars (approval "review-risk-bars"): where a High or Medium judgment's places put a mark on the PR page.
 * Exactly two placements: once before each named file's icon in the file tree, and once in the diff at the right
 * edge of each named range, on its first line. Read from the judgment the page already holds: no request of its own.
 *
 * A range whose lines the diff on screen does not draw (on its side, inside one hunk) gets no mark in the diff: its
 * file keeps its tree mark, and nothing points at lines that may say something else. Low, a judgment with no places
 * (one made before Medium named places, too), or no named file in the diff: nothing at all.
 */
import { isLineRangeInPatch } from '@plannotator/core/diff-files';
import type { InboxPullRiskJudgment } from '@plannotator/core/inbox-types';

export type RiskBarsLevel = 'high' | 'medium';

/** What the risk check said about one place: its reason, and the person's rule it touches when it named one. */
export interface RiskBarsNote {
  why: string;
  rule?: string;
}

/** One mark in the diff: a named range, drawn at its first line. */
export interface RiskBarsRange {
  /** The mark's id on the page (`riskBarsMarkId`). */
  id: string;
  file: string;
  side: 'old' | 'new';
  line: number;
  /** The reasons of the places that start on this line, in the judgment's order (two places on one line are one mark). */
  notes: RiskBarsNote[];
}

export interface RiskBars {
  level: RiskBarsLevel;
  /** The named files the diff shows: each one's tree row gets the mark. */
  files: ReadonlySet<string>;
  /** One per named range the diff draws (two that start on the same line are one mark). */
  ranges: RiskBarsRange[];
  /** A place's own mark id to the mark it shares, when that is another (an unchanged line named by its old number). */
  moved: ReadonlyMap<string, string>;
}

/** A file of the diff as the page draws it. */
export interface RiskBarsFile {
  path: string;
  patch: string;
}

export const riskBarsWord: Record<RiskBarsLevel, string> = { high: 'High risk', medium: 'Medium risk' };

/** The diff mark's id for a place's first line: the stepper finds a place's card by it. */
export function riskBarsMarkId(file: string, side: 'old' | 'new', line: number): string {
  return `risk\u0000${file}\u0000${side}\u0000${line}`;
}

/**
 * The judgment whose places may be drawn on a diff read at `head`: one made at that head. The window holds the last
 * risk answer across a failed read, so after a push the judgment it holds can be the earlier head's, and its lines
 * may say something else now: nothing is drawn then. A judgment from a server from before `head` was sent cannot be
 * told apart, and is drawn as before (on a diff at the head the list shows).
 */
export function riskJudgedAt(judgment: InboxPullRiskJudgment | null | undefined, head: string | null | undefined): InboxPullRiskJudgment | null {
  if (!judgment || !head) return null;
  return judgment.head === undefined || judgment.head === head ? judgment : null;
}

/**
 * The new side's number of the unchanged line at `old` on the old side, or null when that old line is not an unchanged
 * one in the file's patch.
 */
export function unchangedNewLine(patch: string, old: number): number | null {
  let at: { old: number; new: number } | null = null;
  for (const line of patch.split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) at = { old: Number(hunk[1]), new: Number(hunk[2]) };
    else if (line.startsWith('diff ')) at = null;
    else if (!at) continue;
    else if (line.startsWith(' ')) {
      if (at.old === old) return at.new;
      at.old++;
      at.new++;
    } else if (line.startsWith('-')) at.old++;
    else if (line.startsWith('+')) at.new++;
  }
  return null;
}

/**
 * The mark a place's card is on (`riskBarsMarkId` of its first line, or the mark it shares: see `riskBarsOf`), for the
 * places stepper.
 */
export function riskBarsMarkFor(bars: RiskBars | null, file: string, side: 'old' | 'new', line: number): string {
  const own = riskBarsMarkId(file, side, line);
  return bars?.moved.get(own) ?? own;
}

export function riskBarsOf(judgment: InboxPullRiskJudgment | null | undefined, files: readonly RiskBarsFile[]): RiskBars | null {
  if (!judgment || (judgment.level !== 'high' && judgment.level !== 'medium')) return null;
  const patches = new Map(files.map((file) => [file.path, file.patch] as const));
  const named = new Set<string>();
  const drawn = (judgment.where ?? []).filter((place) => {
    const patch = patches.get(place.file);
    if (patch === undefined) return false;
    named.add(place.file);
    return isLineRangeInPatch(patch, place.lines[0], place.lines[1], place.side);
  });
  // An unchanged line is one row in the unified view, under both its numbers: a place naming it by its old number
  // shares the mark of a place naming it by its new one, so the row has one bar and its card says both.
  const newStarts = new Set(drawn.filter((place) => place.side === 'new').map((place) => riskBarsMarkId(place.file, 'new', place.lines[0])));
  const ranges: RiskBarsRange[] = [];
  const moved = new Map<string, string>();
  for (const place of drawn) {
    const start = place.lines[0];
    const unchanged = place.side === 'old' ? unchangedNewLine(patches.get(place.file)!, start) : null;
    const shared = unchanged !== null && newStarts.has(riskBarsMarkId(place.file, 'new', unchanged));
    const side = shared ? 'new' : place.side;
    const line = shared ? unchanged! : start;
    const id = riskBarsMarkId(place.file, side, line);
    if (shared) moved.set(riskBarsMarkId(place.file, place.side, start), id);
    const note: RiskBarsNote = { why: place.why.trim(), ...(place.rule?.trim() ? { rule: place.rule.trim() } : {}) };
    const same = ranges.find((range) => range.id === id);
    if (same) same.notes.push(note);
    else ranges.push({ id, file: place.file, side, line, notes: [note] });
  }
  return named.size > 0 ? { level: judgment.level, files: named, ranges, moved } : null;
}
