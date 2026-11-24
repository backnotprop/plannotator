import { useEffect, useRef, useState, type ReactNode } from 'react';
import { claimRevealOnce } from '../reveal';
import { newUuid } from '../uuid';
import { swarmTipAfterMs } from './swarmBadgeMotion';

/**
 * The Swarm tip (the owner, 2026-11-24): the first time the Swarm badge appears, a small card hangs from it saying what
 * turning it on gives. Once for the person on any window or phone (the Inbox keeps it: `POST /api/inbox/reveal`
 * `id: "swarm_tip"`, packages/shared/inbox/swarm-tip.ts), then never. It is claimed once the badge has settled off,
 * and goes at the badge's press, Escape, a press anywhere else, or when the badge goes.
 *
 * Its form and words follow the designer's round 3 (take A). A row is here only for what the owner approved for it:
 * the ghost thread and the shared task list add their rows once their words are approved.
 */
const TOGETHER = 'M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5';

export const SWARM_TIP_ROWS: readonly { key: string; path: string; words: string }[] = [{ key: 'together', path: TOGETHER, words: 'Agents work together' }];
export const SWARM_TIP_HEAD = 'Turn on for';

/** This page claimed it already (shown or not): no second claim from another New message. */
let spent = false;

export function useSwarmTip(badgeShown: boolean): { node: ReactNode; close: () => void } {
  const [open, setOpen] = useState(false);
  const key = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!badgeShown) {
      setOpen(false);
      return;
    }
    if (spent) return;
    let live = true;
    const timer = setTimeout(() => {
      spent = true;
      key.current ??= newUuid();
      claimRevealOnce('swarm_tip', key.current).then(
        (answer) => live && answer.show && setOpen(true),
        () => {},
      );
    }, swarmTipAfterMs());
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [badgeShown]);

  useEffect(() => {
    if (!open) return;
    // A note, not a menu: the Escape that closes it goes on to New message, so one Escape still closes that.
    const key = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    const press = (event: PointerEvent) => {
      if (!card.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointerdown', press, true);
    return () => {
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointerdown', press, true);
    };
  }, [open]);

  const node = open ? (
    <div ref={card} className="ib-sw-tip" role="note" aria-label="What Swarm turns on" data-swarm-tip="">
      <div className="ib-sw-tip-h">{SWARM_TIP_HEAD}</div>
      {SWARM_TIP_ROWS.map((row) => (
        <div key={row.key} className="ib-sw-tip-r">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
            <path d={row.path} />
          </svg>
          <span>{row.words}</span>
        </div>
      ))}
    </div>
  ) : null;
  return { node, close: () => setOpen(false) };
}

/** Tests: a fresh page. */
export function resetSwarmTipForTests(): void {
  spent = false;
}
