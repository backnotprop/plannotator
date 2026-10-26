/**
 * Decision mode's ways in and its pill (approval "inbox-decision-mode"; experimental).
 * The sidebar's "Decide N" row and the list header's button show only while
 * two or more decisions wait (brief §11 question 7); one decision is answered
 * in its thread as before.
 */
import { useLayoutEffect, useState } from 'react';
import { formatCount } from '../format';

/** The ways in show from two decisions up. */
export const DECIDE_ENTRY_MIN = 2;

export function decideEntryShown(count: number): boolean {
  return count >= DECIDE_ENTRY_MIN;
}

/** "Decide 5". */
export function decideLabel(count: number): string {
  return `Decide ${formatCount(count)}`;
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
export function DecisionPill({ left, paused, onResume }: { left: number; paused?: number; onResume: () => void }) {
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
        <b>Decisions</b> · {left === 0 ? 'nothing left' : `${formatCount(left)} left`}
        {(paused ?? 0) > 0 && <span data-decision-pill-paused=""> · {paused === 1 ? 'a reply waits' : `${formatCount(paused!)} replies wait`}</span>}
      </span>
      <button type="button" className="ib-btn ib-pri ib-sm" data-decision-resume="" onClick={onResume}>
        Resume
      </button>
    </div>
  );
}
