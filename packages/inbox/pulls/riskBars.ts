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

/** One mark in the diff: a named range, drawn at its first line. */
export interface RiskBarsRange {
  id: string;
  file: string;
  side: 'old' | 'new';
  line: number;
}

export interface RiskBars {
  level: RiskBarsLevel;
  /** The named files the diff shows: each one's tree row gets the mark. */
  files: ReadonlySet<string>;
  /** One per named range the diff draws (two that start on the same line are one mark). */
  ranges: RiskBarsRange[];
}

/** A file of the diff as the page draws it. */
export interface RiskBarsFile {
  path: string;
  patch: string;
}

export const riskBarsWord: Record<RiskBarsLevel, string> = { high: 'High risk', medium: 'Medium risk' };

export function riskBarsOf(judgment: InboxPullRiskJudgment | null | undefined, files: readonly RiskBarsFile[]): RiskBars | null {
  if (!judgment || (judgment.level !== 'high' && judgment.level !== 'medium')) return null;
  const patches = new Map(files.map((file) => [file.path, file.patch] as const));
  const named = new Set<string>();
  const ranges: RiskBarsRange[] = [];
  const seen = new Set<string>();
  for (const place of judgment.where ?? []) {
    const patch = patches.get(place.file);
    if (patch === undefined) continue;
    named.add(place.file);
    const [start, end] = place.lines;
    const key = `${place.file}\u0000${place.side}\u0000${start}`;
    if (seen.has(key) || !isLineRangeInPatch(patch, start, end, place.side)) continue;
    seen.add(key);
    ranges.push({ id: `risk:${ranges.length}`, file: place.file, side: place.side, line: start });
  }
  return named.size > 0 ? { level: judgment.level, files: named, ranges } : null;
}
