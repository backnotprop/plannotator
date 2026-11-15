import { useRef } from 'react';
import { followAddress, singlePane, type PaneSet } from './model';

/** The window's panes, following the address's thread (`#thread=`, the active pane's thread: model.ts). */
export function useRoutePanes(thread: string | null): PaneSet {
  const held = useRef<PaneSet | null>(null);
  held.current = held.current === null ? singlePane(thread) : followAddress(held.current, thread);
  return held.current;
}
