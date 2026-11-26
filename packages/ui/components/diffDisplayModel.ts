/**
 * What the diff gear (`DiffDisplayOptions.tsx`) and Settings → Reviews
 * (`settings/ReviewSettingsPage.tsx`) both say and both enforce, from one
 * place so the two can never drift: each row's name, the tab-size range, and
 * when Background strength is offered. The option lists live beside the gear
 * (their icons are JSX).
 */

export const DIFF_DISPLAY_LABELS = {
  wrap: 'Wrap long lines',
  lineNumbers: 'Line numbers',
  backgrounds: 'Backgrounds',
  backgroundStrength: 'Background strength',
  minimap: 'Minimap',
  changeMarks: 'Change marks',
  changedWords: 'Changed words',
  tabSize: 'Tab size',
  decreaseTabSize: 'Decrease tab size',
  increaseTabSize: 'Increase tab size',
  wholeFile: 'Whole file',
  hideWhitespace: 'Hide whitespace',
  moved: 'Show moved & renamed code',
} as const;

export const DIFF_TAB_SIZE_MIN = 1;
export const DIFF_TAB_SIZE_MAX = 8;

/** A tab size the diffs can draw: a whole number from 1 to 8. */
export function clampDiffTabSize(n: number): number {
  return Math.max(DIFF_TAB_SIZE_MIN, Math.min(DIFF_TAB_SIZE_MAX, Math.round(n)));
}

/** Background strength means something only while backgrounds are drawn. */
export function offersBackgroundStrength(showBackground: boolean): boolean {
  return showBackground;
}
