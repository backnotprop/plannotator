import { Fragment, useEffect, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent } from 'react';
import type { HeldThread } from '../data/apply/record';
import type { Route } from '../app/route';
import { ThreadSlot } from '../thread/ThreadSlot';
import type { ThreadSlotHost } from '../thread/slotHost';
import { paneOf, type PaneId } from './model';
import type { WindowPanes } from './useRoutePanes';

/** Each pane's narrowest share of the two while the divider is dragged (the rest of the window is the other's). */
const SPLIT_MIN = 0.3;

/** The address a pane's own links start from: the window's list and filters, with that pane's thread and nothing open in it. */
export function paneRoute(route: Route, thread: string | null): Route {
  return { page: 'inbox', project: route.project ?? null, machine: route.machine ?? null, agent: route.agent ?? null, tag: route.tag ?? null, thread };
}

export interface PaneRowProps {
  windowPanes: WindowPanes;
  /** The active pane's thread as App holds it (`useHeldThread`); the other pane's slot reads its own. */
  held: HeldThread | null;
  host: ThreadSlotHost;
}

/**
 * The thread panes, left to right: one ThreadSlot per pane, keyed by pane id, so the open pane keeps its scroll and
 * reply box when a second opens beside it. One pane draws exactly today's slot. Two draw side by side with a divider
 * between them; a click or focus in a pane makes it the active one, whose header is the brighter.
 */
export function PaneRow({ windowPanes, held, host }: PaneRowProps) {
  const { panes } = windowPanes;
  const two = panes.panes.length > 1;
  const divider = useRef<HTMLDivElement>(null);
  const activeThread = panes.panes.find((pane) => pane.id === panes.active)?.thread ?? null;
  // The active pane's header is the brighter (inbox.css `[data-pane-quiet]`): the pane's section is Thread.tsx's own.
  useLayoutEffect(() => {
    for (const section of document.querySelectorAll<HTMLElement>('.ib-main > section.ib-pane[data-thread-id]')) {
      const quiet = two && section.dataset.threadId !== activeThread;
      if (quiet) section.dataset.paneQuiet = '';
      else delete section.dataset.paneQuiet;
    }
  });
  // A press or focus in the other pane makes it the active one, before its own handler runs.
  useEffect(() => {
    if (!two) return;
    const into = (event: Event) => {
      const section = event.target instanceof Element ? event.target.closest<HTMLElement>('.ib-main > section.ib-pane[data-thread-id]') : null;
      const id = section?.dataset.threadId ? paneOf(panes, section.dataset.threadId) : null;
      if (id !== null && id !== panes.active) windowPanes.focus(id);
    };
    document.addEventListener('pointerdown', into, true);
    document.addEventListener('focusin', into, true);
    return () => {
      document.removeEventListener('pointerdown', into, true);
      document.removeEventListener('focusin', into, true);
    };
  }, [two, panes, windowPanes]);
  const drag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const main = divider.current?.parentElement;
    if (!main || event.button !== 0) return;
    event.preventDefault();
    const box = main.getBoundingClientRect();
    const to = (x: number) => main.style.setProperty('--ib-pane-split', `${Math.min(1 - SPLIT_MIN, Math.max(SPLIT_MIN, (x - box.left) / box.width)) * 100}%`);
    const moved = (e: PointerEvent) => to(e.clientX);
    const done = () => {
      window.removeEventListener('pointermove', moved);
      window.removeEventListener('pointerup', done);
      main.removeAttribute('data-pane-dragging');
    };
    main.setAttribute('data-pane-dragging', '');
    window.addEventListener('pointermove', moved);
    window.addEventListener('pointerup', done);
  };
  // One pane: no split kept for the next.
  useLayoutEffect(() => {
    if (!two) document.querySelector<HTMLElement>('.pn-inbox .ib-main')?.style.removeProperty('--ib-pane-split');
  }, [two]);
  return (
    <>
      {panes.panes.map((pane, i) => {
        const active = pane.id === panes.active;
        const own = active ? host : paneHost(host, paneRoute(host.route, pane.thread));
        return (
          <Fragment key={pane.id}>
            {i > 0 && <div ref={divider} className="ib-panesplit" role="separator" aria-orientation="vertical" data-pane-split="" onPointerDown={drag} />}
            <ThreadSlot
              paneId={pane.id}
              threadId={pane.thread}
              active={active}
              held={active ? held : undefined}
              host={two ? withPaneClose(own, pane.id, windowPanes.closePane) : own}
            />
          </Fragment>
        );
      })}
    </>
  );
}

/** The other pane's host: its own address, with no file, guide or review of the active pane's. */
function paneHost(host: ThreadSlotHost, route: Route): ThreadSlotHost {
  return { ...host, route, routeRef: { current: route }, fileOpen: false, fromCard: null };
}

/**
 * Beside another pane: the pane's ✕ closes this pane, not the thread under both, and the pair has the window (App
 * draws it as full screen), so neither pane offers full screen of its own.
 */
function withPaneClose(host: ThreadSlotHost, id: PaneId, closePane: (id: PaneId) => void): ThreadSlotHost {
  return { ...host, full: false, paired: true, close: (next) => (next.page === 'inbox' && next.thread === null ? closePane(id) : host.close(next)) };
}
