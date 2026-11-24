import type { InboxDiffStyle } from './api';

/**
 * How diffs are drawn (config.json `diffOptions`, shared with code review), by
 * the wire's names: each null when never chosen. Hide whitespace and the
 * fonts are code review's alone.
 */
export interface InboxDiffOptions {
  diff_style: InboxDiffStyle | null;
  overflow: 'scroll' | 'wrap' | null;
  indicators: 'bars' | 'classic' | 'none' | null;
  line_diff_type: 'word-alt' | 'word' | 'char' | 'none' | null;
  line_numbers: boolean | null;
  background: boolean | null;
  background_intensity: 'subtle' | 'normal' | 'strong' | null;
  tab_size: number | null;
  semantic: boolean | null;
  expand_unchanged: boolean | null;
}
