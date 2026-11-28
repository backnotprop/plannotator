/** A starred list row's marks (InboxList.tsx's rows). */
import { Icon } from '../icons';
import { starPopping } from '../starPop';

/**
 * A pinned thread's small pin in its list row (approval "inbox-pinned-threads"): always on the right, beside the
 * counts (the owner, 2026-10-31: "just like the questions, just like the action items"), never right after a short
 * preview. A three-line or phone row has it on line 3 before the badge and the counts; a wide row in a column of its
 * own just left of the open counts' column. For the eye only: the row's name ends with ", pinned" (`PinnedWords`).
 */
export function PinMark({ threadId, press = false }: { threadId: string; press?: boolean }) {
  return (
    <span className="ib-pinmark" data-pin-mark="" data-star-press={press ? '' : undefined} data-pop={starPopping(threadId) ? '' : undefined} aria-hidden="true">
      <Icon name="star" size={13} />
    </span>
  );
}

/** The end of a pinned row's accessible name. */
export function PinnedWords() {
  return <span className="ib-sr">, starred</span>;
}
