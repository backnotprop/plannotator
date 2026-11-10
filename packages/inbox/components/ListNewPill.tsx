/**
 * The list's own "↓ N new" pill (the owner's pick, variant "A · Pill" of the design "new below"): the thread's
 * pill (`.ib-npill`, Thread.tsx `NewPill`) at the list's edge, for news the reader cannot see. Two cases, one pill:
 *
 *  - Held: news came while the "N new · Show" line at the list's top is out of view. A press is Show, and goes
 *    to the rows.
 *  - Shown: Show brought rows in and some are out of view (Show never scrolls). A press goes to the nearest.
 *
 * It counts one direction at a time, never both in one number: the rows that land (or are) below the view, at
 * the bottom edge; with none there, those above, at the top edge. After a press the pill shows what is left.
 *
 * How long it stays is `LIST_NEW_PILL_STAYS`: until it is pressed or the reader scrolls there (the default), or,
 * set to false, `LIST_NEW_PILL_MS` after the last arrival and then a fade (the owner's first ask: "show for five
 * seconds and it would like queue up. If more appear below, it would just add up to it"). The pointer or focus on
 * it holds the fade. News that lands in Quiet or Sent shows none. The list never moves by itself.
 *
 * State: what waits is the held list's (`heldNews`) and the light's (`unseen`, showLight.ts); the only thing kept
 * here is what the reader has already had a sign of (`seen`). Where the line is comes from one
 * IntersectionObserver on the list's scroll box, never from a timer.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import type { InboxListGroupId } from '@plannotator/core/inbox-types';
import type { HeldNews } from '../held';
import type { ListEdge, UnseenRow } from '../showLight';
import { Icon } from '../icons';
import { prefersReducedMotion } from '../settle';

/**
 * The pill stays until it is pressed or the reader scrolls there. False: it stays `LIST_NEW_PILL_MS` after the
 * last arrival, then fades (an open question with the owner; this is the one place to change it).
 */
export const LIST_NEW_PILL_STAYS: boolean = true;
/** With `LIST_NEW_PILL_STAYS` false: how long the pill stays whole after the last arrival, and how long its fade then takes (inbox.css `data-fading`). */
export const LIST_NEW_PILL_MS = 5000;
export const LIST_NEW_PILL_FADE_MS = 1800;

/** Groups whose news shows no pill: nothing there waits on the person. */
const NO_PILL: ReadonlySet<InboxListGroupId> = new Set(['quiet', 'sent']);
/** The share of the "N new" line, or of a group's header, that must show for it to count as in view. */
const IN_VIEW = 0.6;
const NONE: ReadonlySet<string> = new Set();

type Edge = ListEdge;
interface Where {
  /** The "N new · Show" line is in view. */
  sign: boolean;
  /** For each group news lands in: top when its header is scrolled away above, else bottom (the rows land under a header in view, or further down). */
  edges: Record<string, Edge>;
}

/**
 * The top of the group a row lands in, which is where Show will put it (news is the newest row of its group).
 * A group with no row yet is not drawn: the next one drawn stands in. Null with `edge`: List has no groups and
 * news lands at its top; past the last group drawn, it lands at the list's end.
 */
function landing(body: HTMLElement, lands: InboxListGroupId, order: readonly string[]): { band: Element | null; edge: Edge } {
  if (body.querySelector('[data-flat-list]')) return { band: null, edge: 'top' };
  for (const id of order.slice(Math.max(0, order.indexOf(lands)))) {
    const band = body.querySelector(`.ib-group[data-section-id="${id}"] > .ib-band`);
    // The group's first row is where the news will be (a phone's header sticks to the top of the view while its
    // group is on screen, so the header itself says nothing); a closed group has only its header.
    if (band) return { band: band.nextElementSibling ?? band, edge: 'top' };
  }
  return { band: null, edge: 'bottom' };
}

/** Where the "N new" line and each landing place are in the list's scroll box; null until the browser has said. `lands`: the groups, comma-joined. */
function useWhere(body: RefObject<HTMLElement | null>, lands: string, order: string, layout: string): Where | null {
  const [where, setWhere] = useState<Where | null>(null);
  // After the commit's refs are set: the list's scroll box is a later sibling of the pill.
  useEffect(() => {
    const root = body.current;
    const sign = root?.querySelector('[data-inbox-notice]');
    if (!root || !sign || lands === '' || typeof IntersectionObserver === 'undefined') {
      setWhere(null);
      return;
    }
    // Another landing place (news now lands higher up) keeps what is known until the browser reports on it, so a
    // pill on screen does not blink.
    const now: Where = { sign: false, edges: {} };
    /** Each header watched, and the groups whose rows land at it. */
    const bands = new Map<Element, string[]>();
    for (const group of lands.split(',')) {
      const target = landing(root, group as InboxListGroupId, order.split(','));
      now.edges[group] = target.edge;
      if (target.band) bands.set(target.band, [...(bands.get(target.band) ?? []), group]);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const inView = entry.intersectionRatio >= IN_VIEW;
          if (entry.target === sign) now.sign = inView;
          // Scrolled away above: the rows land above. Else below: under a header in view, or one further down.
          else for (const group of bands.get(entry.target) ?? []) now.edges[group] = inView || entry.boundingClientRect.top > (entry.rootBounds?.top ?? 0) ? 'bottom' : 'top';
        }
        setWhere({ sign: now.sign, edges: { ...now.edges } });
      },
      { root, threshold: [0, IN_VIEW] },
    );
    observer.observe(sign);
    for (const band of bands.keys()) observer.observe(band);
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
  /** The rows Show brought in that are not in view yet (showLight.ts). */
  unseen: readonly UnseenRow[];
  /** The list's scroll box. */
  body: RefObject<HTMLElement | null>;
  /** The list's groups in its order, the empty ones too. */
  order: readonly InboxListGroupId[];
  /** Changes when the groups drawn do (which have rows, Smart groups or List): the landing place is found again. */
  layout: string;
  /** The list is drawn but out of sight (a thread covers it): the pill waits for the list to be back. */
  covered: boolean;
  /** Show, as the "N new" line's press, and on to the rows it brings in past that edge. */
  onShow: (edge: Edge) => void;
  /** On to the nearest unseen row past that edge. */
  onGo: (edge: Edge) => void;
  /** `LIST_NEW_PILL_STAYS`, for the tests of the other answer. */
  stays?: boolean;
}

const shownKey = (row: UnseenRow) => `shown ${row.id}`;

export function ListNewPill({ news, unseen, body, order, layout, covered, onShow, onGo, stays = LIST_NEW_PILL_STAYS }: ListNewPillProps) {
  const loud = news.filter((item) => !NO_PILL.has(item.lands));
  /** What the reader has had a sign of: the "N new" line was in view, or (when the pill fades) the pill ran its time. */
  const [seen, setSeen] = useState(NONE);
  const fresh = loud.filter((item) => !seen.has(item.key));
  const where = useWhere(body, [...new Set(fresh.map((item) => item.lands))].join(','), order.join(','), layout);
  const watching = usePageShown() && !covered;
  // Held news first; else the rows Show brought in. Either way one direction at a time, never a count that mixes
  // both: what is below first, then what is above.
  const held = watching && fresh.length > 0 && where !== null && !where.sign;
  const rest = unseen.filter((row) => !seen.has(shownKey(row)));
  const edges = held ? fresh.map((item) => where.edges[item.lands] ?? 'top') : rest.map((row) => row.edge);
  const edge: Edge = edges.includes('bottom') ? 'bottom' : 'top';
  const count = edges.filter((at) => at === edge).length;
  const on = held || (watching && count > 0);
  const burst = held ? fresh.map((item) => item.key).join('\n') : rest.map(shownKey).join('\n');
  // Everything that could show is in `burst`, so an effect that follows `burst` always holds it as it is.
  const sawAll = () => setSeen(new Set([...loud.map((item) => item.key), ...unseen.map(shownKey)]));

  // The line is in view: the reader has their sign, and a pill on screen for it leaves at once.
  const signInView = watching && where?.sign === true && fresh.length > 0;
  useEffect(() => {
    if (signInView) sawAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `sawAll` is a fresh closure each render; see above.
  }, [signInView, burst]);
  // A row seen is no longer `unseen`; once none is, a later Show's rows start with nothing dismissed.
  const noneUnseen = unseen.length === 0;
  useEffect(() => {
    if (noneUnseen) setSeen((last) => ([...last].some((key) => key.startsWith('shown ')) ? new Set([...last].filter((key) => !key.startsWith('shown '))) : last));
  }, [noneUnseen]);

  // Only when the pill fades (`stays` false). Its time: whole, then the fade, then seen. Another arrival (`burst`)
  // starts it again. The pointer or focus on it holds it, and leaving it goes straight to the fade. Reduced motion
  // has no fade: it is there, then it is not.
  const [holding, setHolding] = useState(false);
  const [fading, setFading] = useState(false);
  const letGo = useRef(false);
  useEffect(() => {
    if (!on) {
      // Gone (its time, the line in view, a press) with the pointer still where it was: the next pill starts whole.
      letGo.current = false;
      setHolding(false);
      return;
    }
    if (stays || holding) return;
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
  }, [on, holding, burst, stays]);
  const hold = (next: boolean) => {
    if (!next && holding) letGo.current = true;
    setHolding(next);
  };

  // What the pill shows; as it leaves it keeps what it last showed.
  const last = useRef<{ count: number; edge: Edge; held: boolean }>({ count: 1, edge: 'bottom', held: true });
  const drawn = on ? { count, edge, held } : last.current;
  useLayoutEffect(() => {
    if (on) last.current = drawn;
  });
  const words = `${drawn.count} new ${drawn.count === 1 ? 'message' : 'messages'} ${drawn.edge === 'bottom' ? 'below' : 'above'}`;
  // Said once as the pill comes, not again as its count changes.
  const [said, setSaid] = useState('');
  useEffect(() => {
    setSaid(on ? words : '');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the pill coming and going: its count changing is not said again.
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
        // Held, the press is Show and then goes there; shown already, it only goes there.
        aria-label={`${words}, ${drawn.held ? 'show and go there' : 'go there'}`}
        onPointerEnter={() => hold(true)}
        onPointerLeave={() => hold(false)}
        onFocus={() => hold(true)}
        onBlur={() => hold(false)}
        onClick={(event) => {
          // The pill goes with the press: focus is the list's to place, as after the line's Show.
          event.currentTarget.blur();
          if (held) onShow(drawn.edge);
          else onGo(drawn.edge);
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
