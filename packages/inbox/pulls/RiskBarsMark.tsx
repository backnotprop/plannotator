/**
 * The risk bars in the diff (approval "review-risk-bars"): a line note of no height under a named range's first line,
 * its mark drawn up into that line at the column's right edge. Drawn through review-editor's host line notes (the
 * PR page's own seam, before forge threads so it sits right under the code line); the tree's mark is
 * review-editor's `RISK_BARS_PARTS`.
 */
import type { GuideLineNote } from '../guide/types';
import { riskBarsWord, type RiskBars, type RiskBarsLevel } from './riskBars';

/** Three small bars: all filled for High, two for Medium. */
export function RiskBarsMark({ level }: { level: RiskBarsLevel }) {
  const word = riskBarsWord[level];
  return (
    <span className="ib-riskbars" role="img" aria-label={word} title={word} data-risk-bars={level}>
      <svg width="8" height="8" viewBox="0 0 8 8" aria-hidden="true">
        <rect x="0" y="5" width="2" height="3" rx=".5" />
        <rect x="3" y="2.5" width="2" height="5.5" rx=".5" />
        <rect x="6" y="0" width="2" height="8" rx=".5" opacity={level === 'high' ? 1 : 0.28} />
      </svg>
    </span>
  );
}

/** Each named range the diff draws, as a line note under its first line. */
export function riskBarsLineNotes(bars: RiskBars | null, scope: string): GuideLineNote[] {
  if (!bars) return [];
  return bars.ranges.map((range) => ({
    id: range.id,
    filePath: range.file,
    line: range.line,
    side: range.side,
    key: `${scope}|${bars.level}`,
    render: () => (
      <div className="ib-riskbars-row" data-risk-bars-line={`${range.file}#${range.side}${range.line}`}>
        <RiskBarsMark level={bars.level} />
      </div>
    ),
  }));
}
