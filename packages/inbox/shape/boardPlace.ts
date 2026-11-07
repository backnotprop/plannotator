/**
 * Where the person is on the open board (its view and panel), and where they left it when one of its links opened
 * the review (approval "review-show-me", q-db7db55f). The review mounts a board of its own under the corner card, so
 * the card's Grow, and Back to the thread, open on that place, not on the first view. Kept while the board stays
 * open; a board opened again starts at its first view, as before.
 */
import { useEffect, useMemo, useRef } from 'react';
import type { ShapeBoardPlace } from './types';

type Kept = { id: string } & ShapeBoardPlace;

export interface BoardPlaces {
  /** Where a board mounting now starts: the place a link left it, or null (its first view). */
  placeOf: (id: string) => ShapeBoardPlace | null;
  /** The person moved to a view or panel on the board (its `onNavigate`). */
  moved: (id: string, place: ShapeBoardPlace) => void;
  /** A link on the board opens the review: keep where the person is. */
  leave: (id: string) => void;
}

/** `open`: the board open in the window (`&shape=`), or null; once it closes, the left place goes too. */
export function useBoardPlaces(open: string | null): BoardPlaces {
  const seen = useRef<Kept | null>(null);
  const left = useRef<Kept | null>(null);
  useEffect(() => {
    if (!open) left.current = null;
  }, [open]);
  return useMemo(
    () => ({
      placeOf: (id) => (left.current?.id === id ? { view: left.current.view, panel: left.current.panel } : null),
      moved: (id, place) => {
        seen.current = { id, ...place };
        if (left.current?.id === id) left.current = { id, ...place };
      },
      leave: (id) => {
        left.current = seen.current?.id === id ? seen.current : null;
      },
    }),
    [],
  );
}
