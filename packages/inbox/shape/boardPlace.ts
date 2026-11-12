import { useEffect, useMemo, useRef } from 'react';
import type { ShapeBoardPlace } from './types';

type Kept = { id: string } & ShapeBoardPlace;

export interface BoardPlaces {
  placeOf: (id: string) => ShapeBoardPlace | null;
  moved: (id: string, place: ShapeBoardPlace) => void;
  leave: (id: string) => void;
}

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
