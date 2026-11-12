export type LineSelectionSource = 'range-gesture' | 'gutter-comment-action';

export type LineSelectionBehavior = 'preserve-selection' | 'open-composer';

interface ResolveLineSelectionBehaviorOptions {
  readonly source: LineSelectionSource;
  readonly compactTouchLayout: boolean;
}

export function resolveLineSelectionBehavior({
  source,
  compactTouchLayout,
}: ResolveLineSelectionBehaviorOptions): LineSelectionBehavior {
  if (compactTouchLayout && source === 'range-gesture') {
    return 'preserve-selection';
  }
  return 'open-composer';
}
