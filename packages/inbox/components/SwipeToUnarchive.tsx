/**
 * A phone's archived row: a swipe to the left unarchives it (approval "inbox-archived-group"), with "Unarchive" under
 * the row as it slides. Only a leftward swipe is taken: a rightward one (the system's Back from the screen's edge) and
 * an up or down one (the list's scroll, pull to refresh) are left alone, and a finger held still opens the row's menu
 * as on every row. Past a third of the row (at least 88 px) it unarchives on release; short of that it goes back.
 * Under reduced motion nothing slides back or away: the row returns or goes at once.
 */
import { useRef, type ReactNode } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { Icon } from '../icons';

/** How far a finger moves before the gesture is a swipe or a scroll. */
const DECIDE_PX = 10;
const COMMIT_MIN_PX = 88;

const reduced = () => typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

export function SwipeToUnarchive({ row, onUnarchive, children }: { row: InboxListRow; onUnarchive: (row: InboxListRow) => void; children: ReactNode }) {
  const wrap = useRef<HTMLDivElement>(null);
  const face = useRef<HTMLDivElement>(null);
  const gesture = useRef<{ id: number; x: number; y: number; mode: 'maybe' | 'swipe' | 'scroll'; dx: number } | null>(null);
  /** A swipe just ended: the click it makes opens nothing. */
  const swiped = useRef(false);
  const slide = (dx: number, animate: boolean) => {
    const el = face.current;
    if (!el) return;
    el.style.transition = animate && !reduced() ? 'transform 220ms cubic-bezier(0.23, 1, 0.32, 1)' : 'none';
    el.style.transform = dx === 0 ? '' : `translateX(${dx}px)`;
    wrap.current?.toggleAttribute('data-swiping', dx !== 0);
    if (dx === 0) wrap.current?.removeAttribute('data-armed');
  };
  const threshold = () => Math.max(COMMIT_MIN_PX, (wrap.current?.offsetWidth ?? 0) / 3);
  const end = (commit: boolean) => {
    const g = gesture.current;
    gesture.current = null;
    if (!g || g.mode !== 'swipe') return;
    swiped.current = true;
    setTimeout(() => (swiped.current = false), 0);
    if (commit && -g.dx >= threshold()) {
      slide(-(wrap.current?.offsetWidth ?? 0), true);
      onUnarchive(row);
    } else slide(0, true);
  };
  return (
    <div
      ref={wrap}
      className="ib-arcswipe"
      data-swipe-row={row.thread_id}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        gesture.current = { id: event.pointerId, x: event.clientX, y: event.clientY, mode: 'maybe', dx: 0 };
      }}
      onPointerMove={(event) => {
        const g = gesture.current;
        if (!g || g.id !== event.pointerId || g.mode === 'scroll') return;
        const dx = event.clientX - g.x;
        const dy = event.clientY - g.y;
        if (g.mode === 'maybe') {
          if (Math.abs(dy) > DECIDE_PX && Math.abs(dy) >= Math.abs(dx)) {
            g.mode = 'scroll';
            return;
          }
          if (dx > DECIDE_PX) {
            g.mode = 'scroll';
            return;
          }
          if (dx >= -DECIDE_PX) return;
          g.mode = 'swipe';
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }
        g.dx = Math.min(0, dx);
        slide(g.dx, false);
        wrap.current?.toggleAttribute('data-armed', -g.dx >= threshold());
      }}
      onPointerUp={() => end(true)}
      onPointerCancel={() => end(false)}
      onClickCapture={(event) => {
        if (!swiped.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <div className="ib-arcswipe-under" aria-hidden="true">
        <Icon name="archive" size={16} />
        Unarchive
      </div>
      <div ref={face} className="ib-arcswipe-face">
        {children}
      </div>
    </div>
  );
}
