export type LineSelectionSource = 'range-gesture' | 'gutter-comment-action';

export type LineSelectionBehavior = 'preserve-selection' | 'open-composer';

interface ResolveLineSelectionBehaviorOptions {
  readonly source: LineSelectionSource;
  readonly compactTouchLayout: boolean;
}

/**
 * Keep mobile range acquisition separate from writing, matching DiffsHub.
 * Desktop retains its incumbent selection-to-composer flow, while the
 * contextual gutter action always represents an explicit writing intent.
 */
export function resolveLineSelectionBehavior({
  source,
  compactTouchLayout,
}: ResolveLineSelectionBehaviorOptions): LineSelectionBehavior {
  if (compactTouchLayout && source === 'range-gesture') {
    return 'preserve-selection';
  }
  return 'open-composer';
}
