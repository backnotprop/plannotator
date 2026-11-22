/**
 * The risk bars' tone (approval "review-risk-bars"): an orange-red mixed from the theme, the same in the file tree
 * (treeRows' `RISK_BARS_PARTS`) and the diff (the Inbox's riskBarsMarks.ts). No imports: the Inbox's strict
 * typecheck reads it.
 */
export const RISK_TONE = 'color-mix(in oklch, var(--destructive) 60%, var(--warning))';
/** Medium's third bar: there, faint, so the mark still reads "2 of 3". */
export const RISK_TONE_FAINT = `color-mix(in srgb, ${RISK_TONE} 30%, transparent)`;
