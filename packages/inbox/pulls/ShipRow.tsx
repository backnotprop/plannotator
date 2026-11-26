/**
 * Ship mode on a Reviews row (approval "inbox-ship-mode", look "Glint"): calm water behind the line, two slow pools of
 * colour, a sun glint now and then, the sail for the row's mark and the agent's mark bobbing. Drawn only for a row
 * that ships: no other row has any of it. Only transform and opacity move (pulls/ship.css), the water sits behind the
 * line in the row's own box (nothing shifts), and a row off screen holds still (`useStillOffScreen`). Reduced motion:
 * the coloured row and the sail, still. Stuck: sand comes over the water and it stops. Merged: the words take the end.
 */
import { useEffect, useRef, useState } from 'react';
import { shipRowWords, type InboxShipView } from '@plannotator/core/inbox-pull-handoff';

/** The sail (the approval's own glyph), in the text's colour. */
export function SailGlyph({ size = 15 }: { size?: number }) {
  return (
    <svg className="ib-shp-g" width={size} height={size} viewBox="0 0 16 16" aria-hidden="true">
      <path d="M8.7 1.4v8.9h5.1Z" />
      <path d="M7.5 3.6v6.7H3.1Z" />
      <path d="M1.6 11.5h12.8l-1.7 2.8H3.3Z" />
    </svg>
  );
}

/** The row's mark while it ships: the sail, rocking on the water. */
export function ShipMark() {
  return (
    <span className="ib-shp-sail" aria-hidden="true">
      <span className="ib-shp-rock">
        <SailGlyph size={14} />
      </span>
    </span>
  );
}

let watcher: IntersectionObserver | null = null;
/** One observer for every shipping row: a row off screen gets `data-shp-off`, which holds its motion still. */
function offScreenWatcher(): IntersectionObserver | null {
  if (typeof IntersectionObserver === 'undefined') return null;
  watcher ??= new IntersectionObserver((entries) => {
    for (const entry of entries) entry.target.parentElement?.toggleAttribute('data-shp-off', !entry.isIntersecting);
  });
  return watcher;
}

function useStillOffScreen<T extends Element>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    const el = ref.current;
    const watch = offScreenWatcher();
    if (!el || !watch) return;
    watch.observe(el);
    const row = el.parentElement;
    return () => {
      watch.unobserve(el);
      row?.removeAttribute('data-shp-off');
    };
  }, []);
  return ref;
}

/** Ship started this recently when its row is drawn: the water fills in from the left once (the launch). */
const LAUNCH_MS = 4000;

/** The water, behind the row's line. */
export function ShipWater({ ship }: { ship: Pick<InboxShipView, 'started_at'> }) {
  const ref = useStillOffScreen<HTMLSpanElement>();
  const [launch] = useState(() => Date.now() - Date.parse(ship.started_at) < LAUNCH_MS);
  return (
    <span ref={ref} className="ib-shp" aria-hidden="true" data-shp-launch={launch ? '' : undefined}>
      <span className="ib-shp-rev">
        <span className="ib-shp-in">
          <span className="ib-shp-tint" />
          <span className="ib-shp-pool ib-shp-a">
            <span />
          </span>
          <span className="ib-shp-pool ib-shp-b">
            <span />
          </span>
          <span className="ib-shp-glide">
            <span className="ib-shp-glint" />
          </span>
          <span className="ib-shp-sand" />
        </span>
      </span>
    </span>
  );
}

/**
 * "Stuck: <reason>" or "Merged <time>"; a shipping row says it to a screen reader only. Stuck: "Stuck:" is never cut
 * and the reason keeps a floor, cut with "…" past it (pulls/ship.css); the whole words are in the row's name, their
 * tooltip and the ship log.
 */
export function ShipWords({ ship, now }: { ship: Pick<InboxShipView, 'state' | 'reason' | 'merged_at'>; now: number }) {
  const words = shipRowWords(ship, new Date(now));
  if (!words) return <span className="ib-sr">, shipping</span>;
  const cut = ship.state === 'stuck' ? words.indexOf(': ') : -1;
  return (
    <span className="ib-shp-word" data-ship-words="" title={ship.state === 'stuck' ? words : undefined}>
      <span className="ib-sr">, </span>
      {cut < 0 ? (
        words
      ) : (
        <>
          <span className="ib-shp-head">{words.slice(0, cut + 2)}</span>
          <span className="ib-shp-why">{words.slice(cut + 2)}</span>
        </>
      )}
    </span>
  );
}
