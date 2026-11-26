/**
 * Resting on a pin shows what waits there (the owner's recommendation, borrowed from take R3's state 06): a small card
 * beside the rail with the place's mark and name, how many wait on the person, and the first few of those threads.
 * The pointer's alone: the tile itself already says its count to a screen reader, so the card is hidden from it.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { InboxListRow } from '@plannotator/core/inbox-types';
import { formatCount } from '../format';
import { titleOf } from '../components/rowParts';
import { RailMark } from './RailTile';
import { waitingIn, type RailPlace } from './railModel';

/** How long the pointer rests on a pin before its card shows, and how many threads it lists. */
const REST_MS = 450;
const CARD_ROWS = 3;

export interface RailPeekAt {
  place: RailPlace;
  top: number;
  left: number;
}

/** The card's place and timing; `enabled: false` (a menu open, a drag) shows none. */
export function useRailPeek(enabled: boolean) {
  const [at, setAt] = useState<RailPeekAt | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clear = () => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
  };
  const hide = useCallback(() => {
    clear();
    setAt(null);
  }, []);
  const rest = (place: RailPlace, tile: HTMLElement) => {
    clear();
    if (!enabled) return;
    timer.current = setTimeout(() => {
      const rect = tile.getBoundingClientRect();
      setAt({ place, top: Math.max(8, rect.top), left: rect.right + 8 });
    }, REST_MS);
  };
  useEffect(() => {
    if (!enabled) hide();
  }, [enabled, hide]);
  useEffect(() => clear, []);
  return { at, rest, hide };
}

export function RailPeekCard({ peek, rows }: { peek: RailPeekAt | null; rows: readonly InboxListRow[] }) {
  if (!peek) return null;
  const { place } = peek;
  const waiting = waitingIn(place, rows);
  const listed = waiting.slice(0, CARD_ROWS);
  return (
    <div className="ib-rail-card" style={{ top: peek.top, left: peek.left }} aria-hidden="true" data-rail-card={place.key}>
      <div className="ib-rail-card-h">
        <RailMark place={place} />
        <span className="ib-rail-card-n" dir="auto">
          {place.name}
          {place.machine && <span className="ib-rail-card-m"> · {place.machine}</span>}
        </span>
      </div>
      <div className="ib-rail-card-c">{place.count > 0 ? `${formatCount(place.count)} waiting on you` : 'Nothing waits on you here'}</div>
      {listed.map((row) => (
        <div key={row.thread_id} className="ib-rail-card-r" dir="auto">
          <span className="ib-rail-card-t">{titleOf(row)}</span>
          {place.kind === 'tag' && <span className="ib-rail-card-p">{row.project.name}</span>}
        </div>
      ))}
      {waiting.length > listed.length && <div className="ib-rail-card-more">and {formatCount(waiting.length - listed.length)} more</div>}
    </div>
  );
}
