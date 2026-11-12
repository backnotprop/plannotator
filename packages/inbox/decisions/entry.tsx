import { useLayoutEffect, useState } from 'react';
import { formatCount } from '../format';
import { Tip } from '../components/Tip';
import { markDecisionPill } from '../pageMarks';

export const DECIDE_ENTRY_MIN = 2;

export function decideEntryShown(count: number): boolean {
  return count >= DECIDE_ENTRY_MIN;
}

export function decideThreadLabel(count: number, listed: number): string {
  return count === listed ? `Decide these ${formatCount(count)}` : `Decide ${formatCount(count)} one at a time`;
}

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
    const timer = setInterval(read, 300);
    window.addEventListener('resize', read);
    return () => {
      clearInterval(timer);
      window.removeEventListener('resize', read);
    };
  }, []);
  return bottom;
}

export function DecisionPill({
  left,
  paused,
  thread = null,
  onResume,
}: {
  left: number;
  paused?: number;
  thread?: string | null;
  onResume: () => void;
}) {
  const bottom = usePillBottom();
  return (
    <div
      ref={markDecisionPill}
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
