/**
 * Decision mode's way in and its pill (approval "inbox-decision-mode"; experimental).
 * Thread only (owner, 2026-10-27: "I thought decides were gonna be integrated
 * to the thread, not a whole global thing"): the one way in is "Decide these N"
 * in a thread's open-questions list, shown only while two or more of that
 * thread's decisions wait; one decision is answered on its card as before.
 * No global entry: no sidebar row, no list-header button, and a Stopped
 * notification opens its thread.
 */
import { useLayoutEffect, useState } from 'react';
import { formatCount } from '../format';
import { Tip } from '../components/Tip';

/** The way in shows from two decisions (in the thread) up. */
export const DECIDE_ENTRY_MIN = 2;

export function decideEntryShown(count: number): boolean {
  return count >= DECIDE_ENTRY_MIN;
}

/**
 * The thread's way in: "Decide these 5" when the queue holds exactly the
 * questions the list shows; "Decide 5 one at a time" when it holds more (the
 * thread's open action items ride the queue too, and the list leaves them out).
 */
export function decideThreadLabel(count: number, listed: number): string {
  return count === listed ? `Decide these ${formatCount(count)}` : `Decide ${formatCount(count)} one at a time`;
}

/**
 * How far above the window's bottom edge the pill sits: clear of the open
 * thread's foot (Reply, Send, the reply box, whatever its height), else 18 px
 * plus the safe area (the CSS default). Read while the pill shows, since the
 * thread behind it loads after the tuck and its foot grows as the person writes.
 */
function usePillBottom(): number | null {
  const [bottom, setBottom] = useState<number | null>(null);
  useLayoutEffect(() => {
    if (typeof window === 'undefined') return;
    const read = () => {
      const foot = document.querySelector<HTMLElement>('section.ib-pane .ib-pfoot');
      const box = foot?.getBoundingClientRect();
      const next = box && box.height > 0 && box.top < window.innerHeight ? Math.round(window.innerHeight - box.top) + 10 : null;
      setBottom((current) => (current === next ? current : next));
    };
    read();
    // The foot comes and goes (the thread loads, a file opens) and grows (the reply box): a cheap read
    // a few times a second rather than an observer per element that may not exist yet.
    const timer = setInterval(read, 300);
    window.addEventListener('resize', read);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', read);
    };
  }, []);
  return bottom;
}

/**
 * Open the thread tucks decision mode into this pill at the bottom of the
 * window, the thread behind it ("Decisions · 9 left · Resume"). Replies whose
 * Hold was running wait while it is tucked: they go on once the dialog is back.
 */
export function DecisionPill({
  left,
  paused,
  thread = null,
  onResume,
}: {
  left: number;
  paused?: number;
  /**
   * The sitting's thread, by its subject, while the screen shows another thread
   * or the list (a sitting is one thread's): "Decisions · <subject> · 3 left".
   * Null: the thread on screen is the sitting's, so the pill names none.
   */
  thread?: string | null;
  onResume: () => void;
}) {
  const bottom = usePillBottom();
  return (
    <div
      className="ib-dm-pill"
      role="region"
      aria-label="Decision mode"
      data-decision-pill=""
      style={bottom !== null ? { bottom: `${bottom}px` } : undefined}
    >
      <span>
        <b>Decisions</b> ·{' '}
        {thread && (
          <>
            {/* Cut to its room; the whole subject in a component tooltip when cut. */}
            <Tip content={thread} cut>
              <span className="ib-dm-pill-thread" dir="auto" data-decision-pill-thread="">
                {thread}
              </span>
            </Tip>{' '}
            ·{' '}
          </>
        )}
        {left === 0 ? 'nothing left' : `${formatCount(left)} left`}
        {(paused ?? 0) > 0 && <span data-decision-pill-paused=""> · {paused === 1 ? 'a reply waits' : `${formatCount(paused!)} replies wait`}</span>}
      </span>
      <button type="button" className="ib-btn ib-pri ib-sm" data-decision-resume="" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
