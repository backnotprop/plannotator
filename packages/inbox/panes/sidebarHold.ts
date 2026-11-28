import { useEffect, useState, type Dispatch, type RefObject, type SetStateAction } from 'react';
import type { Route } from '../app/route';
import { LIST_MIN_WIDTH, THREAD_BESIDE_FILE_WIDTH, paneGutters } from '../stack';
import { PANE_MIN_WIDTH } from './layoutModel';

/**
 * The room the list and `threads` thread columns take: the list's narrowest column, the threads and the gutters. One
 * thread keeps the 440 px a thread keeps beside the list (stack.ts, which stacks below it); several are free layout
 * panes, each at the pane minimum (layoutModel.ts `PANE_MIN_WIDTH`), as the room rules count them.
 */
export const listAndThreads = (threads: number, el?: Element | null): number =>
  LIST_MIN_WIDTH + (threads > 1 ? threads * PANE_MIN_WIDTH : THREAD_BESIDE_FILE_WIDTH) + paneGutters(el, threads);

export interface SidebarHold {
  /** The docked sidebar is folded on screen for room, the person's stored choice unchanged. */
  held: boolean;
  setHeld: Dispatch<SetStateAction<boolean>>;
  /** Fold the docked sidebar on screen when the list and `threads` threads fit only without it. */
  holdIfTight: (threads?: number) => void;
}

/**
 * The docked sidebar folded on screen for room (`held`), without writing the person's choice: when the list comes back
 * beside a thread (‹ Inbox from a file, leaving full screen) or "Open to the side" opens a second thread, in a window with
 * room for the list and the threads but not for the sidebar too. It comes back by itself once there is room again (the
 * window widened, the second pane closed), when no thread is open, or when the person opens it. A sidebar the person
 * folded is theirs: it is never held, so nothing here opens it.
 */
export function useSidebarHold(rootRef: RefObject<HTMLElement | null>, routeRef: RefObject<Route>, route: Route, threads: number, sidebarOpen: boolean): SidebarHold {
  const [held, setHeld] = useState(false);
  useEffect(() => {
    if (!held) return;
    const check = () => {
      const now = routeRef.current;
      if (now.page !== 'inbox' || !now.thread) {
        setHeld(false);
        return;
      }
      const root = rootRef.current;
      if (!root) return;
      const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
      if (root.getBoundingClientRect().width - sidebar >= listAndThreads(threads, root)) setHeld(false);
    };
    check();
    window.addEventListener('resize', check);
    return () => window.removeEventListener('resize', check);
  }, [held, route, threads]);
  const holdIfTight = (count = threads) => {
    const root = rootRef.current;
    if (!root || !sidebarOpen) return;
    const width = root.getBoundingClientRect().width;
    const sidebar = root.querySelector('.ib-sb-inner')?.getBoundingClientRect().width ?? 0;
    const room = listAndThreads(count, root);
    if (width >= room && width - sidebar < room) setHeld(true);
  };
  return { held, setHeld, holdIfTight };
}
