/**
 * The thread panes as a drop target (drag/threadDrag.ts): a list row's thread dropped on a pane's edge opens beside
 * it, on its centre takes its place; a pane dropped on another's half goes to that side of it. Edges are the outer
 * 28% of a pane's width and 30% of its height, as the engine's own drop places; a pane carried by its header has no
 * centre, only the nearest half. A side is offered only where the layout still fits after the drop (layoutRoom.ts),
 * counting a docked sidebar that would fold for room; a row's thread there opens in the pane's place instead.
 *
 * The reply box and the foot of a pane (`.ib-pfoot`) are not this target's: a thread carried over them is left to a
 * target of a higher layer (the reply box's mention), or to nothing.
 */
import { useEffect, useRef } from 'react';
import { announce, LAYER, registerDropTarget, type DragPayload, type DropHit } from '../drag/threadDrag';
import { mainWidthOf } from '../stack';
import * as L from './layoutModel';
import { fits, type Room } from './layoutRoom';
import type { WindowPanes } from './useRoutePanes';

export type Place = L.DropPlace;

interface PaneDropHit {
  target: L.PaneId;
  place: Place;
  /** The layout after the drop. */
  next: L.FreeLayout;
  rect: { left: number; top: number; width: number; height: number };
}

const EDGE_X = 0.28;
const EDGE_Y = 0.3;
const SIDE_WORDS: Record<L.Edge, string> = { left: 'left of', right: 'right of', top: 'above', bottom: 'below' };

/** The room beside the list the panes share (`.ib-main` less its padding, the list and the gap after it); `reclaim` adds a docked sidebar's width. */
export function measureRoom(reclaim = false): { room: Room; gap: number } | null {
  const main = document.querySelector<HTMLElement>('.pn-inbox .ib-main');
  if (!main) return null;
  const style = getComputedStyle(main);
  const gap = parseFloat(style.columnGap) || 0;
  const root = main.closest<HTMLElement>('.pn-inbox');
  const outer = reclaim && root ? root.getBoundingClientRect().width : root ? mainWidthOf(root) : main.clientWidth;
  let width = outer - (parseFloat(style.paddingLeft) || 0) - (parseFloat(style.paddingRight) || 0);
  const height = main.getBoundingClientRect().height -(parseFloat(style.paddingTop) || 0) - (parseFloat(style.paddingBottom) || 0);
  const list = main.querySelector<HTMLElement>(':scope > .ib-listcol');
  if (list) {
    const listStyle = getComputedStyle(list);
    if (listStyle.visibility !== 'hidden' && listStyle.position !== 'absolute') width -= list.getBoundingClientRect().width + gap;
  }
  return { room: { width, height }, gap: Math.max(1, gap) };
}

/** The panes on screen and their boxes: the engine's hosts (one pane is in the layout too). */
function paneBoxes(): { id: L.PaneId; el: HTMLElement }[] {
  return [...document.querySelectorAll<HTMLElement>('.ib-layout > [data-layout-pane]:not([data-pane-hidden="true"])')].map((el) => ({ id: el.dataset.layoutPane!, el }));
}

function nearestEdge(x: number, y: number, box: DOMRect): { edge: L.Edge; depth: number } {
  const sides: [L.Edge, number][] = [
    ['left', (x - box.left) / box.width / EDGE_X],
    ['right', (box.right - x) / box.width / EDGE_X],
    ['top', (y - box.top) / box.height / EDGE_Y],
    ['bottom', (box.bottom - y) / box.height / EDGE_Y],
  ];
  sides.sort((a, b) => a[1] - b[1]);
  return { edge: sides[0]![0], depth: sides[0]![1] };
}

function sideRect(box: DOMRect, place: Place) {
  const half = { width: box.width / 2, height: box.height / 2 };
  if (place === 'left') return { left: box.left, top: box.top, width: half.width, height: box.height };
  if (place === 'right') return { left: box.left + half.width, top: box.top, width: half.width, height: box.height };
  if (place === 'top') return { left: box.left, top: box.top, width: box.width, height: half.height };
  if (place === 'bottom') return { left: box.left, top: box.top + half.height, width: box.width, height: half.height };
  return { left: box.left, top: box.top, width: box.width, height: box.height };
}

export interface PaneDropOptions {
  /** The panes take drops: the switch is on, and the window can show several (not a phone, not stacked, no file). */
  enabled: boolean;
  /** Several panes show (the engine draws them). */
  multi: boolean;
  windowPanes: WindowPanes;
  hidden: ReadonlySet<L.PaneId>;
  title: (id: L.PaneId) => string;
  /** Fold a docked sidebar when the list and this many columns fit only without it (sidebarHold.ts). */
  holdSidebar: (columns: number) => void;
}

/** The panes as a drop target while `enabled`. */
export function usePaneDrop(options: PaneDropOptions): void {
  const live = useRef(options);
  live.current = options;
  useEffect(() => {
    if (!options.enabled) return;
    let preview: HTMLElement | null = null;
    const hit = (x: number, y: number, payload: DragPayload): DropHit | null => {
      const { windowPanes, hidden } = live.current;
      const layout = windowPanes.layout;
      const box = paneBoxes().find(({ el }) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      if (!box) return null;
      const target = box.id;
      if (payload.kind === 'pane' && payload.paneId === target) return null;
      const over = document.elementFromPoint(x, y);
      if (payload.kind === 'thread' && over && box.el.contains(over) && over.closest('.ib-pfoot, .ib-rbox')) return null;
      const r = box.el.getBoundingClientRect();
      const { edge, depth } = nearestEdge(x, y, r);
      const measured = measureRoom(true);
      const sideFits = (next: L.FreeLayout) => !!next.root && !!measured && fits(next.root, measured.room, measured.gap, hidden);
      let place: Place = payload.kind === 'pane' || depth <= 1 ? edge : 'center';
      let next =
        payload.kind === 'pane'
          ? L.move(layout, payload.paneId, target, edge)
          : place === 'center'
            ? L.replace(layout, target, payload.threadId)
            : L.openAt(layout, payload.threadId, target, edge);
      if (place !== 'center' && !sideFits(next)) {
        if (payload.kind === 'pane') return null;
        place = 'center';
        next = L.replace(layout, target, payload.threadId);
      }
      if (next === layout) return null;
      const action = payload.kind === 'pane' ? 'Move here' : place === 'center' ? 'Open here' : 'Open beside';
      const data: PaneDropHit = { target, place, next, rect: sideRect(r, place) };
      return { action, data };
    };
    const target = {
      id: 'thread-panes',
      layer: LAYER.pane,
      accepts: (payload: DragPayload) => payload.kind === 'thread' || live.current.multi,
      hit,
      over(found: DropHit | null) {
        if (!found) {
          preview?.remove();
          preview = null;
          return;
        }
        const { rect } = found.data as PaneDropHit;
        if (!preview) {
          preview = document.createElement('div');
          preview.className = 'ib-droppreview';
          preview.setAttribute('aria-hidden', 'true');
          (document.querySelector('.pn-inbox') ?? document.body).appendChild(preview);
        }
        Object.assign(preview.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
      },
      drop(found: DropHit, payload: DragPayload) {
        const { windowPanes, title, holdSidebar } = live.current;
        const { target: on, place, next } = found.data as PaneDropHit;
        const name = title(on);
        holdSidebar(L.columns(next.root));
        if (payload.kind === 'pane') {
          windowPanes.movePane(payload.paneId, on, place as L.Edge);
          announce(`${payload.label} moved ${SIDE_WORDS[place as L.Edge]} ${name}.`);
          // Focus stays in the pane that moved.
          requestAnimationFrame(() => {
            const host = document.querySelector<HTMLElement>(`.ib-layout > [data-layout-pane="${CSS.escape(payload.paneId)}"]`);
            if (host && !host.contains(document.activeElement)) host.focus({ preventScroll: true });
          });
        } else if (place === 'center') {
          windowPanes.replaceIn(on, payload.threadId);
          announce(`${payload.label} opened in place of ${name}.`);
        } else {
          windowPanes.openAt(payload.threadId, on, place);
          announce(`${payload.label} opened ${SIDE_WORDS[place]} ${name}.`);
        }
      },
    };
    const unregister = registerDropTarget(target);
    return () => {
      unregister();
      preview?.remove();
    };
  }, [options.enabled]);
}
