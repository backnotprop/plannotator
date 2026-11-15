import { useRef } from 'react';
import { MAIN_PANE, open, paneThread, singlePane, type PaneSet } from './model';

/** The window's panes, the main one showing the address's thread (`#thread=`): the address stays the one source of it. */
export function useRoutePanes(thread: string | null): PaneSet {
  const held = useRef<PaneSet | null>(null);
  if (held.current === null) held.current = singlePane(thread);
  else if (paneThread(held.current, MAIN_PANE) !== thread) held.current = open(held.current, thread, MAIN_PANE);
  return held.current;
}
