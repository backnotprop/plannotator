/**
 * The list's own "↓ N new" pill (the owner's pick, variant "A · Pill" of the design "new below"): the list holds
 * still, so the only sign of news is the "N new · Show" line at its top, and a reader scrolled down sees nothing
 * arrive. While that line is out of view, news shows the thread's pill (`.ib-npill`, Thread.tsx `NewPill`) at the
 * list's edge: the bottom edge when the row will land below the view, else the top edge. A press is Show.
 *
 * It counts the news of one burst, not everything that waits: it stays `LIST_NEW_PILL_MS`, each further arrival
 * adding to its count and starting that time again, then fades and is over; news after that starts a pill at its
 * own count (the owner: "show for five seconds and it would like queue up. If more appear below, it would just add
 * up to it"). The pointer or focus on it holds it. It leaves at once when the reader scrolls the line into view.
 * News that lands in Quiet or Sent shows none. The list never moves by itself.
 *
 * State: what waits is the held list's (`heldNews`, the threads "N new" counts); the only thing kept here is which
 * of those the reader has already been shown (`seen`). Where things are comes from one IntersectionObserver on the
 * list's scroll box, never from a timer.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { InboxListGroupId } from '@plannotator/core/inbox-types';
import type { HeldNews } from '../held';
import { Icon } from '../icons';
import { prefersReducedMotion } from '../settle';

/** How long the pill stays whole after the last arrival, and how long its fade then takes (inbox.css `data-fading`). */
export const LIST_NEW_PILL_MS = 5000;
export const LIST_NEW_PILL_FADE_MS = 1800;

/** Groups whose news shows no pill: nothing there waits on the person. */
const NO_PILL: ReadonlySet<InboxListGroupId> = new Set(['quiet', 'sent']);
/** The share of the "N new" line, or of a group's header, that must show for it to count as in view. */
const IN_VIEW = 0.6;
const NONE: ReadonlySet<string> = new Set();

type Edge = 'top' | 'bottom';
interface Where {
  /** The "N new · Show" line is in view. */
  sign: boolean;
  /** The list's edge nearest to where the first row will land. */
  edge: Edge;
}

/**
 * The header of the group a row lands in, which is where Show will put it (news is the newest row of its group).
 * A group with no row yet is not drawn: the next one drawn stands in. Null with `edge`: List has no groups and
 * news lands at its top; past the last group drawn, it lands at the list's end.
 */
function landing(body: HTMLElement, lands: InboxListGroupId, order: readonly string[]): { band: Element | null; edge: Edge } {
  if (body.querySelector('[data-flat-list]')) return { band: null, edge: 'top' };
  for (const id of order.slice(Math.max(0, order.indexOf(lands)))) {
    const band = body.querySelector(`.ib-group[data-section-id="${id}"] > .ib-band`);
    if (band) return { band, edge: 'top' };
  }
  return { band: null, edge: 'bottom' };
}

/** Where the "N new" line and the landing place are in the list's scroll box; null until the browser has said. */
function useWhere(body: RefObject<HTMLElement | null>, lands: InboxListGroupId | null, order: string, layout: string): Where | null {
  const [where, setWhere] = useState<Where | null>(null);
  // After the commit's refs are set: the list's scroll box is a later sibling of the pill.
  useEffect(() => {
    const root = body.current;
    const sign = root?.querySelector('[data-inbox-notice]');
    if (!root || !sign || lands === null || typeof IntersectionObserver === 'undefined') {
      setWhere(null);
      return;
    }
    // Another landing place (news now lands higher up) keeps what is known until the browser reports on it, so a
    // pill on screen does not blink.
    const target = landing(root, lands, order.split(','));
    const now: Where = { sign: false, edge: target.edge };
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const inView = entry.intersectionRatio >= IN_VIEW;
          if (entry.target === sign) now.sign = inView;
          // Below the view, or only its top edge showing at the bottom: the row lands below.
          else now.edge = !inView && entry.boundingClientRect.top > (entry.rootBounds?.top ?? 0) ? 'bottom' : 'top';
        }
        setWhere({ ...now });
      },
      { root, threshold: [0, IN_VIEW] },
    );
    observer.observe(sign);
    if (target.band) observer.observe(target.band);
    return () => observer.disconnect();
  }, [body, lands, order, layout]);
  return where;
}

/** The page is the tab on screen: the pill's time does not run in a tab nobody sees. */
function usePageShown(): boolean {
  const [shown, setShown] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  useEffect(() => {
    const read = () => setShown(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', read);
    return () => document.removeEventListener('visibilitychange', read);
  }, []);
  return shown;
}

export interface ListNewPillProps {
  /** The threads behind "N new" (held.ts `heldNews`); none while nothing waits. */
  news: readonly HeldNews[];
  /** The list's scroll box. */
  body: RefObject<HTMLElement | null>;
  /** The list's groups in its order, the empty ones too. */
  order: readonly InboxListGroupId[];
  /** Changes when the groups drawn do (which have rows, Smart groups or List): the landing place is found again. */
  layout: string;
  /** The list is drawn but out of sight (a thread covers it): the pill waits for the list to be back. */
  covered: boolean;
  /** Show, as the "N new" line's press. */
  onShow: () => void;
}

export function ListNewPill({ news, body, order, layout, covered, onShow }: ListNewPillProps) {
  const loud = news.filter((item) => !NO_PILL.has(item.lands));
  /** The news the reader has had a sign of: the pill ran its time, or the "N new" line was in view. */
  const [seen, setSeen] = useState(NONE);
  const fresh = loud.filter((item) => !seen.has(item.key));
  const burst = fresh.map((item) => item.key).join('\n');
  const where = useWhere(body, fresh[0]?.lands ?? null, order.join(','), layout);
  const watching = usePageShown() && !covered;
  const on = watching && fresh.length > 0 && where !== null && !where.sign;
  // Every new thread is in `burst`, so an effect that follows `burst` always holds the news as it is.
  const sawAll = () => setSeen(new Set(loud.map((item) => item.key)));

  // The line is in view: the reader has their sign, and a pill on screen leaves at once.
  const signInView = watching && where?.sign === true && fresh.length > 0;
  useEffect(() => {
    if (signInView) sawAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sawAll` is a fresh closure each render; see above.
  }, [signInView, burst]);

  // Its time: whole, then the fade, then seen. Another arrival (`burst`) starts it again. The pointer or focus on it
  // holds it, and leaving it goes straight to the fade. Reduced motion has no fade: it is there, then it is not.
  const [held, setHeld] = useState(false);
  const [fading, setFading] = useState(false);
  const letGo = useRef(false);
  useEffect(() => {
    if (!on) {
      // Gone (its time, the line in view, a press) with the pointer still where it was: the next pill starts whole.
      letGo.current = false;
      setHeld(false);
      return;
    }
    if (held) return;
    const fade = prefersReducedMotion() ? 0 : LIST_NEW_PILL_FADE_MS;
    const whole = letGo.current ? 0 : LIST_NEW_PILL_MS;
    letGo.current = false;
    let timer = setTimeout(() => {
      if (fade === 0) return sawAll();
      setFading(true);
      timer = setTimeout(sawAll, fade);
    }, whole);
    return () => {
      clearTimeout(timer);
      setFading(false);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sawAll` is a fresh closure each render; see above.
  }, [on, held, burst]);
  const hold = (next: boolean) => {
    if (!next && held) letGo.current = true;
    setHeld(next);
  };

  // What the pill shows; as it leaves it keeps what it last showed.
  const last = useRef<{ count: number; edge: Edge }>({ count: 1, edge: 'bottom' });
  const drawn = on ? { count: fresh.length, edge: where.edge } : last.current;
  useLayoutEffect(() => {
    if (on) last.current = drawn;
  });
  const words = `${drawn.count} new ${drawn.count === 1 ? 'message' : 'messages'} ${drawn.edge === 'bottom' ? 'below' : 'above'}`;
  // Said once as the pill comes, not again as its count grows.
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(on ? words : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the pill coming and going: its count growing is not said again.
  }, [on]);

  return (
    <div className="ib-lnew" data-edge={drawn.edge}>
      <button
        type="button"
        className="ib-npill"
        data-list-new-pill=""
        data-off={on ? undefined : ''}
        data-fading={on && fading ? '' : undefined}
        tabIndex={on ? 0 : -1}
        aria-hidden={!on}
        aria-label={`${words}, show`}
        onPointerEnter={() => hold(true)}
        onPointerLeave={() => hold(false)}
        onFocus={() => hold(true)}
        onBlur={() => hold(false)}
        onClick={(event) => {
          // The pill goes with the press: focus is the list's to place, as after the line's Show.
          event.currentTarget.blur();
          onShow();
        }}
      >
        <Icon name={drawn.edge === 'bottom' ? 'arrowDown' : 'arrowUp'} size={15} />
        {drawn.count} new
      </button>
      <span className="ib-sr" aria-live="polite" data-list-new-said="">
        {said}
      </span>
    </div>
  );
}
