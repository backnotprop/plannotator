/**
 * The risk bars in the diff (approval "review-risk-bars"): one mark at the right edge of each named range's first
 * line, drawn by the line itself through review-editor's host line marks (`hostLineMarks.ts`), so it never covers
 * code. The tree's mark is review-editor's `RISK_BARS_PARTS`: the same three bars.
 *
 * The bars: 2px wide, 2px apart, 6, 9 and 12px tall, standing on one baseline, whole pixels so they stay sharp at 1x
 * and 2x; High fills all three, Medium two with the third faint (the shape still reads "2 of 3"). Tone: review-editor's
 * `riskBarsTone.ts`, an orange-red from the theme.
 */
import { RISK_TONE, RISK_TONE_FAINT } from '@plannotator/review-editor/components/riskBarsTone';
import type { GuideLineMark } from '../guide/types';
import { riskBarsWord, type RiskBars, type RiskBarsLevel } from './riskBars';

const bar = (color: string) => `linear-gradient(${color}, ${color})`;
// The bars' top, whole pixels down from the line's: the 12px group centred in the line.
const TOP = 'round(down, (1lh - 12px) / 2, 1px)';
const PLAIN_TOP = '4px';

/** The bars' CSS for the mark's box (`LINE_MARK_WIDTH` 24px × one line): 6px in, 8px clear of the right edge. */
export function riskBarsPaint(level: RiskBarsLevel): string {
  const third = level === 'high' ? RISK_TONE : RISK_TONE_FAINT;
  const at = (top: string) => `6px calc(${top} + 6px), 10px calc(${top} + 3px), 14px ${top}`;
  return [
    `background-image: ${bar(RISK_TONE)}, ${bar(RISK_TONE)}, ${bar(third)};`,
    'background-size: 2px 6px, 2px 9px, 2px 12px;',
    `background-position: ${at(PLAIN_TOP)};`,
    `background-position: ${at(TOP)};`,
  ].join(' ');
}

/** Each named range the diff draws, as a mark on its first line. */
export function riskBarsLineMarks(bars: RiskBars | null): GuideLineMark[] {
  if (!bars) return [];
  const paint = riskBarsPaint(bars.level);
  return bars.ranges.map((range) => ({ filePath: range.file, side: range.side, line: range.line, label: riskBarsWord[bars.level], paint }));
}
