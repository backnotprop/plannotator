import type { InboxDiffStyle } from './api';

/**
 * How diffs are drawn (config.json `diffOptions`, shared with code review), by
 * the wire's names: each null when never chosen. Hide whitespace is code
 * review's alone.
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
  /** The code font (empty: the theme's) and its size (`13px`; empty: the theme's). Absent from an older Inbox. */
  font_family?: string | null;
  font_size?: string | null;
  /** Power Up (code review's Settings › Semantic diffs): off, the Inbox never asks a provider either. Absent from an older Inbox. */
  power_up?: boolean | null;
  /** How Power Up's notes arrive. Absent from an older Inbox. */
  power_up_motion?: 'stream' | 'still' | null;
}
