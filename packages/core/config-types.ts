export type DefaultDiffType = 'since-base' | 'local-vs-remote' | 'uncommitted' | 'unstaged' | 'staged' | 'merge-base' | 'all';
export type JjDefaultDiffType = 'jj-current' | 'jj-last' | 'jj-line' | 'jj-evolog' | 'jj-all';

export type ReviewDefaults = Record<string, { defaultDiffType?: string }>;
export type DiffLineBgIntensity = 'subtle' | 'normal' | 'strong';

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
