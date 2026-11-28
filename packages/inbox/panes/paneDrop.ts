/**
 * The thread panes as a drop target. A list row's thread is carried by the window's one thread drag (../threadDrag.ts,
 * #3526's module): the panes register there at THREAD_DROP_LAYER.pane, and a row dropped on a pane's edge opens beside
 * it, on its centre takes its place. A reply box inside a pane is its own target there at `reply`, a higher layer, so a
 * row dropped on it is a mention, never this. A pane carried by its header (paneDrag.ts, this layout's own) goes to
 * the nearest half of another pane; it has no centre.
 *
 * Edges are the outer 28% of a pane's width and 30% of its height, as the engine's own drop places. A side is taken
 * only where no pane steps aside for it (layoutRoom.ts `steppedAside`), counting a docked sidebar that would fold for
 * room. Where it does not fit, the drop zone says so and takes the other axis's nearer side of that pane if that fits
 * ("Too narrow: opens below"); where neither fits it says "No room to split here" and the drop changes nothing. The
 * ghost's word says where it lands before the release. A row over a pane's foot (`.ib-pfoot`) with no reply box open
 * does nothing.
 *
 * The thin strip along the whole pane area's outer rim is its own place (outerEdge.ts), for a row and a pane alike: it
 * opens (moves) the pane at the root of the layout on that side, the full height or width, and wins over a pane's own
 * edge there. With no room it says so and changes nothing; it never takes another side.
 */
import { useEffect, useRef } from 'react';
import { registerThreadDropTarget, sayThreadDrag, THREAD_DROP_LAYER } from '../threadDrag';
import { announce, registerDropTarget, type DragPayload, type DropHit } from './paneDrag';
import { mainWidthOf } from '../stack';
import * as L from './layoutModel';
import { hiddenForRoom, steppedAside, type PaneRect, type Room } from './layoutRoom';
import { outerEdgeAt, outerPlace, outerRect, outerWords, type AreaBox } from './outerEdge';
import type { WindowPanes } from './useRoutePanes';

/** Where a drop lands; `none`: an edge with no room on either axis, which the drop zone says and the drop leaves alone. */
export type Place = L.DropPlace | 'none';

/** What is carried over the panes: a pane by its header, or one list row's thread. */
type Carried = DragPayload | { kind: 'thread'; threadId: string; label: string };

interface PaneDropHit {
  /** A pane, or `L.WHOLE`: the whole layout's `outer` edge. */
  target: L.PaneId;
  outer?: L.Edge;
  place: Place;
  /** The layout after the drop. */
  next: L.FreeLayout;
  rect: { left: number; top: number; width: number; height: number };
}

const EDGE_X = 0.28;
const EDGE_Y = 0.3;
const SIDE_WORDS: Record<L.Edge, string> = { left: 'left of', right: 'right of', top: 'above', bottom: 'below' };
/** Where a split lands, in the drop zone's words. */
const PLACE_WORDS: Record<L.Edge, string> = { left: 'on the left', right: 'on the right', top: 'above', bottom: 'below' };

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

/** The panes' boxes on screen: the ⋯ menu's moves, and the largest pane "Open to the side" may split (beside.ts). */
export function paneRects(): PaneRect[] {
  return paneBoxes().map(({ id, el }) => {
    const r = el.getBoundingClientRect();
    return { id, left: r.left, top: r.top, right: r.right, bottom: r.bottom };
  });
}

/** The panes on screen and their boxes: the engine's hosts (one pane is in the layout too). */
function paneBoxes(): { id: L.PaneId; el: HTMLElement }[] {
  return [...document.querySelectorAll<HTMLElement>('.ib-layout > [data-layout-pane]:not([data-pane-hidden="true"])')].map((el) => ({ id: el.dataset.layoutPane!, el }));
}

/** The box around every pane on screen: the area the outer edges belong to. */
function areaOf(boxes: readonly { el: HTMLElement }[]): AreaBox | null {
  if (!boxes.length) return null;
  const rects = boxes.map(({ el }) => el.getBoundingClientRect());
  return { left: Math.min(...rects.map((r) => r.left)), top: Math.min(...rects.map((r) => r.top)), right: Math.max(...rects.map((r) => r.right)), bottom: Math.max(...rects.map((r) => r.bottom)) };
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

/** A list row's title, for what the live region says (the row's subject line, as the list draws it). */
function rowTitle(threadId: string): string {
  const row = document.querySelector(`.ib-lbody [data-thread-id="${CSS.escape(threadId)}"]`);
  const label = row?.querySelector('.ib-subj')?.textContent?.trim() || 'Thread';
  return label.length > 60 ? `${label.slice(0, 57)}…` : label;
}

export interface PaneDropOptions {
  /** The panes take drops: the switch is on, and the window can show several (not a phone, not stacked, no file). */
  enabled: boolean;
  /** Several panes show (the engine draws them). */
  multi: boolean;
  windowPanes: WindowPanes;
  title: (id: L.PaneId) => string;
  /** Fold a docked sidebar when the list and this many columns fit only without it (sidebarHold.ts). */
  holdSidebar: (columns: number) => void;
}

/** The panes as a drop target while `enabled`: a row's thread through the window's thread drag, a pane through paneDrag.ts. */
export function usePaneDrop(options: PaneDropOptions): void {
  const live = useRef(options);
  live.current = options;
  useEffect(() => {
    if (!options.enabled) return;
    let preview: HTMLElement | null = null;
    const hit = (x: number, y: number, carried: Carried): DropHit | null => {
      const { windowPanes } = live.current;
      const layout = windowPanes.layout;
      const boxes = paneBoxes();
      const box = boxes.find(({ el }) => {
        const r = el.getBoundingClientRect();
        return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
      });
      // A pane still over its own box (its header pressed and nudged) goes nowhere, the rim included: it has to leave
      // its own pane before any place counts.
      if (carried.kind === 'pane' && box?.id === carried.paneId) return null;
      // An open reply box (and the foot around it) is the reply's, rim strip included: a drop never lands in or
      // disturbs a draft, and the box's own target (a mention, layer `reply`) takes a thread there. A closed foot
      // (Reply, Looks good) is the pane's bottom edge like the rest of it.
      const over = box ? document.elementFromPoint(x, y) : null;
      const foot = over && box!.el.contains(over) ? over.closest('.ib-pfoot') : null;
      if (carried.kind === 'thread' && over && box!.el.contains(over) && (over.closest('.ib-rbox') || foot?.querySelector('.ib-rbox'))) return null;
      // The whole area's rim next: there it is the whole side, never one pane's edge.
      const area = areaOf(boxes);
      const rim = area ? outerEdgeAt(x, y, area) : null;
      if (area && rim) {
        const measured = measureRoom(true);
        if (!measured) return null;
        const outer = outerPlace(layout, carried.kind === 'pane' ? { kind: 'pane', paneId: carried.paneId } : { kind: 'thread', threadId: carried.threadId }, rim, measured.room, measured.gap);
        if (!outer) return null;
        const data: PaneDropHit = { target: L.WHOLE, outer: rim, place: outer.fits ? rim : 'none', next: outer.fits ? outer.next : layout, rect: outerRect(area, rim, outer.next, measured.gap, hiddenForRoom(outer.next, measured.room, measured.gap)) };
        return { action: outerWords(rim, outer.fits, carried.kind), data };
      }
      if (!box) return null;
      const target = box.id;
      const r = box.el.getBoundingClientRect();
      const { edge, depth } = nearestEdge(x, y, r);
      const measured = measureRoom(true);
      const split = (side: L.Edge) => (carried.kind === 'pane' ? L.move(layout, carried.paneId, target, side) : L.openAt(layout, carried.threadId, target, side));
      // Taken only where no pane steps aside for it (a narrow window's rule, layoutRoom.ts).
      const roomy = (next: L.FreeLayout) => next !== layout && !!next.root && !!measured && steppedAside(layout, next, measured.room, measured.gap).length === 0;
      let place: Place = carried.kind === 'pane' || depth <= 1 ? edge : 'center';
      let next = place === 'center' && carried.kind === 'thread' ? L.replace(layout, target, carried.threadId) : split(edge);
      let narrow: 'Too narrow' | 'Too short' | null = null;
      if (place !== 'center' && !roomy(next)) {
        // The other axis's nearer side of the same pane, if that fits; else nothing, said.
        const across = edge === 'left' || edge === 'right';
        const other: L.Edge = across ? (y < r.top + r.height / 2 ? 'top' : 'bottom') : x < r.left + r.width / 2 ? 'left' : 'right';
        const alt = split(other);
        if (roomy(alt)) {
          narrow = across ? 'Too narrow' : 'Too short';
          place = other;
          next = alt;
        } else {
          place = 'none';
          next = layout;
        }
      }
      if (place !== 'none' && next === layout) return null;
      const verb = carried.kind === 'pane' ? 'moves' : 'opens';
      const action =
        place === 'none'
          ? carried.kind === 'pane' ? 'No room to move here' : 'No room to split here'
          : place === 'center'
            ? 'Open here'
            : narrow
              ? `${narrow}: ${verb} ${PLACE_WORDS[place]}`
              : carried.kind === 'pane' ? 'Move here' : `Open ${PLACE_WORDS[place]}`;
      const data: PaneDropHit = { target, place, next, rect: sideRect(r, place) };
      return { action, data };
    };
    const draw = (found: DropHit | null) => {
      if (!found) {
        preview?.remove();
        preview = null;
        return;
      }
      const { rect, place } = found.data as PaneDropHit;
      // No room: the words say so, and no zone is drawn where nothing would land.
      if (place === 'none') {
        preview?.remove();
        preview = null;
        return;
      }
      if (!preview) {
        preview = document.createElement('div');
        preview.className = 'ib-droppreview';
        preview.setAttribute('aria-hidden', 'true');
        (document.querySelector('.pn-inbox') ?? document.body).appendChild(preview);
      }
      Object.assign(preview.style, { left: `${rect.left}px`, top: `${rect.top}px`, width: `${rect.width}px`, height: `${rect.height}px` });
    };
    /** False when it changed nothing (no room, said). */
    const drop = (found: DropHit, carried: Carried, say: (words: string) => void): boolean => {
      const { windowPanes, title, holdSidebar } = live.current;
      const { target: on, place, next, outer } = found.data as PaneDropHit;
      if (outer) {
        const words = outerWords(outer, place !== 'none', carried.kind);
        if (place === 'none') {
          say(`${words}. Nothing changed.`);
          return false;
        }
        holdSidebar(L.columns(next.root));
        if (carried.kind === 'pane') windowPanes.movePane(carried.paneId, L.WHOLE, outer);
        else windowPanes.openAt(carried.threadId, L.WHOLE, outer);
        say(`${carried.label} ${words.replace(/^Open /, 'opened ').replace(/^Move /, 'moved ')}.`);
        return true;
      }
      const name = title(on);
      if (place === 'none') {
        say(`No room beside ${name}. Nothing changed.`);
        return false;
      }
      holdSidebar(L.columns(next.root));
      if (carried.kind === 'pane') {
        windowPanes.movePane(carried.paneId, on, place as L.Edge);
        say(`${carried.label} moved ${SIDE_WORDS[place as L.Edge]} ${name}.`);
        // Focus stays in the pane that moved.
        requestAnimationFrame(() => {
          const host = document.querySelector<HTMLElement>(`.ib-layout > [data-layout-pane="${CSS.escape(carried.paneId)}"]`);
          if (host && !host.contains(document.activeElement)) host.focus({ preventScroll: true });
        });
      } else if (place === 'center') {
        windowPanes.replaceIn(on, carried.threadId);
        say(`${carried.label} opened in place of ${name}.`);
      } else {
        windowPanes.openAt(carried.threadId, on, place);
        say(`${carried.label} opened ${SIDE_WORDS[place]} ${name}.`);
      }
      return true;
    };
    // A pane by its header (paneDrag.ts), while several show.
    const offPanes = registerDropTarget({
      id: 'thread-panes',
      accepts: () => live.current.multi,
      hit,
      over: draw,
      drop: (found, carried) => void drop(found, carried, announce),
    });
    // A list row's thread (../threadDrag.ts): one thread at a time; several picked rows are no place's here.
    let carried: string | null = null;
    let found: DropHit | null = null;
    const offRows = registerThreadDropTarget({
      element: () => document.querySelector<HTMLElement>('.pn-inbox .ib-layout'),
      layer: THREAD_DROP_LAYER.pane,
      // Read as the pointer moves, just before `over` runs: `over` writes the ghost's word too, so it never lags.
      get what() {
        return found?.action ?? '';
      },
      accepts: (ids) => (ids.length === 1 ? 'take' : null),
      show: (answer, ids) => {
        carried = answer === 'take' ? ids[0]! : null;
        if (!answer) {
          found = null;
          draw(null);
        }
      },
      over: (point) => {
        found = point && carried ? hit(point.x, point.y, { kind: 'thread', threadId: carried, label: '' }) : null;
        draw(found);
        const word = document.querySelector<HTMLElement>('[data-thread-ghost] .ib-tdrag-w');
        if (word) word.textContent = found?.action ?? '';
      },
      drop: (ids, point) => {
        const threadId = ids[0]!;
        const thread: Carried = { kind: 'thread', threadId, label: rowTitle(threadId) };
        const at = hit(point.x, point.y, thread);
        if (at) return drop(at, thread, (words) => sayThreadDrag(words));
        sayThreadDrag('Nothing changed.');
        return false;
      },
    });
    return () => {
      offPanes();
      offRows();
      preview?.remove();
    };
  }, [options.enabled]);
}
