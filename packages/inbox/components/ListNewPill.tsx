/**
 * The list's own "↓ N new" pill (the owner's pick, variant "A · Pill" of the design "new below"): the thread's
 * pill (`.ib-npill`, Thread.tsx `NewPill`) at the list's edge, for rows Show brought in that the reader cannot see.
 *
 * Only after Show (the owner, 2026-11-17: before Show the news is held behind the "N new · Show" bar, which sticks
 * to the list's top, so a pill then took the reader to nothing). Show never scrolls; when a row it brought in
 * landed above or below the view, the pill says where and a press goes to the nearest. The rule is listNewState.ts.
 *
 * It counts one direction at a time, never both in one number: the side with more rows, below the view (the
 * bottom edge) or above it (the top edge), below on a tie. After a press the pill shows what is left.
 *
 * How long it stays is `LIST_NEW_PILL_STAYS`: until it is pressed or the reader scrolls there (the default), or,
 * set to false, `LIST_NEW_PILL_MS` after the last row joined it and then a fade (the owner's first ask: "show for
 * five seconds and it would like queue up. If more appear below, it would just add up to it"). The pointer or focus
 * on it holds the fade. The list never moves by itself.
 *
 * State: the rows are the light's (`unseen`, showLight.ts); the only thing kept here is what the reader has already
 * had a sign of (`seen`: rows whose fading pill ran its time).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { ListEdge, UnseenRow } from '../showLight';
import { listNewState } from '../listNewState';
import { Icon } from '../icons';
import { prefersReducedMotion } from '../settle';

/**
 * The pill stays until it is pressed or the reader scrolls there. False: it stays `LIST_NEW_PILL_MS` after the
 * last row joined it, then fades (an open question with the owner; this is the one place to change it).
 */
export const LIST_NEW_PILL_STAYS: boolean = true;
/** With `LIST_NEW_PILL_STAYS` false: how long the pill stays whole after the last row joined it, and how long its fade then takes (inbox.css `data-fading`). */
export const LIST_NEW_PILL_MS = 5000;
export const LIST_NEW_PILL_FADE_MS = 1800;

const NONE: ReadonlySet<string> = new Set();

type Edge = ListEdge;

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
  /** The rows Show brought in that are not in view yet (showLight.ts). */
  unseen: readonly UnseenRow[];
  /** The list is drawn but out of sight (a thread covers it): the pill waits for the list to be back. */
  covered: boolean;
  /** On to the nearest unseen row past that edge. */
  onGo: (edge: Edge) => void;
  /** `LIST_NEW_PILL_STAYS`, for the tests of the other answer. */
  stays?: boolean;
}

export function ListNewPill({ unseen, covered, onGo, stays = LIST_NEW_PILL_STAYS }: ListNewPillProps) {
  /** Rows the reader has had a sign of: the pill ran its time (when it fades). */
  const [seen, setSeen] = useState(NONE);
  const watching = usePageShown() && !covered;
  // Held news is the bar's, never the pill's: `held` 0 here, the pill is the rows Show brought in alone.
  const { button } = listNewState({ held: 0, unseen, dismissed: seen, watching });
  const on = button !== null;
  const burst = unseen
    .filter((row) => !seen.has(row.id))
    .map((row) => row.id)
    .join('\n');
  // Everything that could show is in `burst`, so an effect that follows `burst` always holds it as it is.
  const sawAll = () => setSeen(new Set(unseen.map((row) => row.id)));

  // A row seen is no longer `unseen`; once none is, a later Show's rows start with nothing dismissed.
  const noneUnseen = unseen.length === 0;
  useEffect(() => {
    if (noneUnseen) setSeen((last) => (last.size > 0 ? NONE : last));
  }, [noneUnseen]);

  // Only when the pill fades (`stays` false). Its time: whole, then the fade, then seen. Another row (`burst`)
  // starts it again. The pointer or focus on it holds it, and leaving it goes straight to the fade. Reduced motion
  // has no fade: it is there, then it is not.
  const [holding, setHolding] = useState(false);
  const [fading, setFading] = useState(false);
  const letGo = useRef(false);
  useEffect(() => {
    if (!on) {
      // Gone (its time, the rows seen, a press) with the pointer still where it was: the next pill starts whole.
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
  const last = useRef<{ count: number; edge: Edge }>({ count: 1, edge: 'bottom' });
  const drawn = button ?? last.current;
  useLayoutEffect(() => {
    if (button) last.current = button;
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
        aria-label={`${words}, go there`}
        onPointerEnter={() => hold(true)}
        onPointerLeave={() => hold(false)}
        onFocus={() => hold(true)}
        onBlur={() => hold(false)}
        onClick={(event) => {
          // The pill goes with the press: focus is the list's to place (`go` puts it on the row).
          event.currentTarget.blur();
          onGo(drawn.edge);
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
