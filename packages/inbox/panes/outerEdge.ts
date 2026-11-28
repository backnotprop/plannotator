/**
 * The outer edges of the whole pane area as drop places (paneDrop.ts). A thread row, or a pane carried by its header,
 * let go in the thin strip along the area's outer edge opens (moves) at the root of the layout on that side: a column
 * the full height of the area beside every pane (left, right), or a row its full width (top, bottom). A pane's own
 * edge zone splits that pane only; this strip is narrower than those zones, lies along the area's rim, and wins
 * where they overlap, because a person aiming at the very edge means the whole side.
 *
 * It is offered where nothing steps aside for it (layoutRoom.ts `steppedAside`, the same rule as a pane's edges, so
 * every pane keeps 400 x 260 px). Where it does not fit the place says "No room on the right" and the drop changes
 * nothing: it never falls back to another side, since the person asked for that one.
 */
import type { Edge } from '@plannotator/vendor-pierre-layouts';
import * as L from './layoutModel';
import { steppedAside, type Room } from './layoutRoom';

/** How deep the strip along each outer edge of the pane area is, in px: well inside a pane's own edge zone (28% of its width, 30% of its height; 112 px at the 400 px floor). */
export const OUTER_ZONE = 24;

export interface AreaBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** What is carried to the rim: one list row's thread, or a pane by its header. */
export type OuterCarried = { kind: 'thread'; threadId: string } | { kind: 'pane'; paneId: L.PaneId };

export interface OuterPlace {
  edge: Edge;
  /** The layout after the drop. */
  next: L.FreeLayout;
  /** Every pane keeps its minimum and none steps aside for it. */
  fits: boolean;
}

/** The outer edge of `area` whose strip holds the point, or null; a corner goes to the side it is nearer. */
export function outerEdgeAt(x: number, y: number, area: AreaBox, zone = OUTER_ZONE): Edge | null {
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) return null;
  const sides: [Edge, number][] = [
    ['left', x - area.left],
    ['right', area.right - x],
    ['top', y - area.top],
    ['bottom', area.bottom - y],
  ];
  const [edge, depth] = sides.reduce((near, side) => (side[1] < near[1] ? side : near));
  return depth <= zone ? edge : null;
}

/**
 * Where a drop at the whole layout's `edge` lands, and whether it fits the room; null where it changes nothing (no
 * pane open, or the pane carried already is that whole side).
 */
export function outerPlace(layout: L.FreeLayout, carried: OuterCarried, edge: Edge, room: Room, gap: number): OuterPlace | null {
  if (!layout.root) return null;
  const next = carried.kind === 'pane' ? L.move(layout, carried.paneId, L.WHOLE, edge) : L.openAt(layout, carried.threadId, L.WHOLE, edge);
  if (next === layout || !next.root) return null;
  return { edge, next, fits: steppedAside(layout, next, room, gap).length === 0 };
}

/** The strip the new column (row) takes in `area` once `next` draws: its share of the root split toward `edge`. */
export function outerRect(area: AreaBox, edge: Edge, next: L.FreeLayout, gap: number, aside: ReadonlySet<string> = new Set()): { left: number; top: number; width: number; height: number } {
  const width = area.right - area.left;
  const height = area.bottom - area.top;
  const horizontal = edge === 'left' || edge === 'right';
  const root = next.root;
  let share = 0.5;
  let count = 2;
  if (root?.type === 'split') {
    // Only what draws shares the area: a child whose panes all stepped aside (`aside`) takes no room and no gap.
    const shown = root.children.map((child) => !L.panesOf(child).every((pane) => aside.has(pane.id)));
    const end = edge === 'left' || edge === 'top' ? 0 : root.sizes.length - 1;
    const weights = root.sizes.map((size, i) => (shown[i] && typeof size === 'number' ? size : 0));
    const total = weights.reduce((sum, w) => sum + w, 0);
    count = Math.max(1, shown.filter(Boolean).length);
    share = total > 0 ? weights[end]! / total : 1 / count;
  }
  const along = Math.max(0, ((horizontal ? width : height) - gap * (count - 1)) * share);
  if (edge === 'left') return { left: area.left, top: area.top, width: along, height };
  if (edge === 'right') return { left: area.right - along, top: area.top, width: along, height };
  if (edge === 'top') return { left: area.left, top: area.top, width, height: along };
  return { left: area.left, top: area.bottom - along, width, height: along };
}

/** The ghost's words for a drop at the whole layout's `edge`: where it opens (moves), or that there is no room. */
export function outerWords(edge: Edge, fits: boolean, kind: OuterCarried['kind']): string {
  if (!fits) return { left: 'No room on the left', right: 'No room on the right', top: 'No room above', bottom: 'No room below' }[edge];
  const span = edge === 'left' || edge === 'right' ? 'full height' : 'full width';
  const where = { left: 'on the left', right: 'on the right', top: 'above', bottom: 'below' }[edge];
  return `${kind === 'pane' ? 'Move' : 'Open'} ${where}, ${span}`;
}
