import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { claimRevealOnce } from '../reveal';
import { newUuid } from '../uuid';
import { swarmTipAfterMs } from './swarmBadgeMotion';
import { swarmTipSide, type SwarmTipSide } from './swarmTipPlace';

/**
 * The Swarm tip (the owner, 2026-11-24): the first time the Swarm badge appears, a small card hangs from it saying what
 * turning it on gives. Once for the person on any window or phone (the Inbox keeps it: `POST /api/inbox/reveal`
 * `id: "swarm_tip"`, packages/shared/inbox/swarm-tip.ts), then never. It is claimed once the badge has settled off,
 * and goes at the badge's press, Escape, a press anywhere else, when the badge goes, or for good when Swarm is turned
 * on (typing `/swarm` too); turned on before it shows, it never shows.
 *
 * Its form and words follow the designer's round 3 (take A, approved 2026-11-25): "Turn on for", then one plain line
 * per thing it gives. Only the lines true today show (`SWARM_TIP_SHOWN`); the shared task list's line is drawn and
 * worded already, and comes in by adding `'tasks'` there once the task list is built.
 */
const STROKE = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round', strokeLinejoin: 'round' } as const;
const icon = (body: ReactNode) => (
  <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
    {body}
  </svg>
);

export const SWARM_TIP_LINES = {
  together: { words: 'Agents work together', icon: icon(<path {...STROKE} d="M7.5 21 3 16.5m0 0L7.5 12M3 16.5h13.5m0-13.5L21 7.5m0 0L16.5 12M21 7.5H7.5" />) },
  ghost: {
    words: 'Ghost thread',
    icon: icon(
      <>
        <path {...STROKE} strokeWidth={1.6} d="M5 20.5V10.5a7 7 0 0 1 14 0v10l-2.33-2-2.34 2L12 18.5l-2.33 2-2.34-2L5 20.5Z" />
        <circle cx="9.6" cy="10.6" r="1.15" fill="currentColor" />
        <circle cx="14.4" cy="10.6" r="1.15" fill="currentColor" />
      </>,
    ),
  },
  tasks: {
    words: 'Shared task list',
    icon: icon(
      <path
        {...STROKE}
        d="M8.25 6.75h12M8.25 12h12m-12 5.25h12M3.75 6.75h.007v.008H3.75V6.75Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0ZM3.75 12h.007v.008H3.75V12Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Zm-.375 5.25h.007v.008H3.75v-.008Zm.375 0a.375.375 0 1 1-.75 0 .375.375 0 0 1 .75 0Z"
      />,
    ),
  },
} as const;

/** The lines the tip shows today, in order. */
export const SWARM_TIP_SHOWN: readonly (keyof typeof SWARM_TIP_LINES)[] = ['together', 'ghost'];
export const SWARM_TIP_HEAD = 'Turn on for';

/** This page claimed it already (shown or not): no second claim from another New message. */
let spent = false;

export function useSwarmTip(badgeShown: boolean, swarmOn: boolean): { node: ReactNode; close: () => void } {
  const [open, setOpen] = useState(false);
  const onNow = useRef(swarmOn);
  onNow.current = swarmOn;
  useEffect(() => {
    if (swarmOn) setOpen(false);
  }, [swarmOn]);
  const key = useRef<string | null>(null);
  const card = useRef<HTMLDivElement>(null);
  // A computer: beside the badge, else above, else under it (swarmTipPlace.ts); measured before it is painted. A phone: CSS.
  const [side, setSide] = useState<SwarmTipSide | undefined>(undefined);
  useLayoutEffect(() => {
    if (!open) return setSide(undefined);
    const place = () => {
      const note = card.current;
      const badge = note?.parentElement;
      if (!note || !badge || note.closest('[data-phone]')) return setSide(undefined);
      const { width, height } = note.getBoundingClientRect();
      setSide(swarmTipSide({ badge: badge.getBoundingClientRect(), note: { width, height }, window: { width: window.innerWidth, height: window.innerHeight } }));
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
  }, [open]);

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
        (answer) => live && answer.show && !onNow.current && setOpen(true),
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
    <div ref={card} className="ib-sw-tip" role="note" aria-label="What Swarm turns on" data-swarm-tip="" data-side={side}>
      <div className="ib-sw-tip-h">{SWARM_TIP_HEAD}</div>
      {SWARM_TIP_SHOWN.map((key) => (
        <div key={key} className="ib-sw-tip-r" data-swarm-tip-line={key}>
          {SWARM_TIP_LINES[key].icon}
          <span>{SWARM_TIP_LINES[key].words}</span>
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
