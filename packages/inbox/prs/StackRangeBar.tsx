/**
 * The stack page's range bar while the person chooses a range (approval "inbox-pr-dashboard", round 7's words): how
 * many layers it holds, its name once both ends are picked, Open as one diff, and Clear. It sticks at the top while
 * the layers scroll.
 */
import type { InboxPullStack } from '@plannotator/core/inbox-types';
import { rangeName, rangeOf, type StackRange } from './stackRange';

export function StackRangeBar({ stack, picked, onOpen, onClear }: { stack: InboxPullStack; picked: readonly string[]; onOpen: (range: StackRange) => void; onClear: () => void }) {
  const range = picked.length === 2 ? rangeOf(stack, picked[0]!, picked[1]!) : null;
  const count = range ? range.layers.length : picked.length;
  return (
    <div className="ib-prst-range" data-pr-stack-range={range ? 'ready' : 'picking'}>
      <span className="ib-prst-range-n" aria-live="polite">
        {count} of {stack.layers.length} layers
      </span>
      {range && (
        <span className="ib-prst-range-name" data-pr-stack-range-name="">
          {rangeName(stack, range)} as one diff
        </span>
      )}
      <span className="ib-prst-range-end">
        {range && (
          <button type="button" className="ib-prs-btn" data-primary="" onClick={() => onOpen(range)} data-pr-stack-range-open="">
            Open as one diff
          </button>
        )}
        <button type="button" className="ib-prs-btn" onClick={onClear} data-pr-stack-range-clear="">
          Clear
        </button>
      </span>
    </div>
  );
}
