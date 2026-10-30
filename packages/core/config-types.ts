export type DefaultDiffType = 'since-base' | 'local-vs-remote' | 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all';
/** The diff types a Jujutsu review can open on by default. */
export type JjDefaultDiffType = 'jj-current' | 'jj-last' | 'jj-line' | 'jj-evolog' | 'jj-all';

/**
 * Saved review defaults for a VCS other than Git, keyed by VCS id (today:
 * `jj`). Git keeps its original `diffOptions.defaultDiffType`.
 */
export type ReviewDefaults = Record<string, { defaultDiffType?: string }>;
export type DiffLineBgIntensity = 'subtle' | 'normal' | 'strong';

/**
 * The user's appearance choice: a palette for the light half, a palette for
 * the dark half, and which of them the mode selects. `system` follows the OS,
 * so the two halves swap with `prefers-color-scheme`.
 */
export interface ThemeConfig {
  mode?: 'light' | 'dark' | 'system';
  light?: string;
  dark?: string;
}

export interface DiffOptions {
  diffStyle?: 'split' | 'unified';
  overflow?: 'scroll' | 'wrap';
  diffIndicators?: 'bars' | 'classic' | 'none';
  lineDiffType?: 'word-alt' | 'word' | 'char' | 'none';
  showLineNumbers?: boolean;
  showDiffBackground?: boolean;
  fontFamily?: string;
  fontSize?: string;
  tabSize?: number;
  hideWhitespace?: boolean;
  expandUnchanged?: boolean;
  defaultDiffType?: DefaultDiffType;
  lineBgIntensity?: DiffLineBgIntensity;
}
