/**
 * How the free layout (layoutModel.ts) fits the room beside the list, and how it gives way when there is too little.
 *
 * Every pane keeps 440 x 260 px at least (a thread's column beside a file, its header and a few lines). The panes
 * draw as the layout places them when the room holds all of them at that size. When it does not, the pane the person
 * was in longest ago steps aside, then the next, until the rest fit; the active pane never does. Below two columns of
 * room (2 x 440 px and the gap) only the active pane shows. A pane that steps aside keeps its place, its thread and
 * its size in the layout and comes back in place once the room is there again. Nothing is stored for room: it is
 * worked out for every draw.
 */
import { setPaneHidden, type Edge, type LayoutNode } from '@plannotator/vendor-pierre-layouts';
import { PANE_MIN_HEIGHT, PANE_MIN_WIDTH, panesOf, type FreeLayout, type PaneId } from './layoutModel';

export interface Room {
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

/** The narrowest and shortest the tree draws, the panes in `hidden` left out (null: nothing shows). */
export function minimumSize(node: LayoutNode, hidden: ReadonlySet<PaneId>, gap: number): Size | null {
  if (node.type === 'pane') return hidden.has(node.id) ? null : { width: PANE_MIN_WIDTH, height: PANE_MIN_HEIGHT };
  if (node.type !== 'split') return { width: PANE_MIN_WIDTH, height: PANE_MIN_HEIGHT };
  const sizes = node.children.map((child) => minimumSize(child, hidden, gap)).filter((size): size is Size => size !== null);
  if (sizes.length === 0) return null;
  const gaps = gap * (sizes.length - 1);
  return node.direction === 'horizontal'
    ? { width: sizes.reduce((sum, size) => sum + size.width, 0) + gaps, height: Math.max(...sizes.map((size) => size.height)) }
    : { width: Math.max(...sizes.map((size) => size.width)), height: sizes.reduce((sum, size) => sum + size.height, 0) + gaps };
}

/** Whether the layout's panes, less `hidden`, fit the room. */
export function fits(root: LayoutNode, room: Room, gap: number, hidden: ReadonlySet<PaneId> = new Set()): boolean {
  const size = minimumSize(root, hidden, gap);
  return !size || (size.width <= room.width + 0.5 && size.height <= room.height + 0.5);
}

/** The panes that step aside for room: the least recently active first, never the active one. */
export function hiddenForRoom(layout: FreeLayout, room: Room, gap: number): Set<PaneId> {
  const hidden = new Set<PaneId>();
  if (!layout.root || !layout.active) return hidden;
  const ids = panesOf(layout.root).map((pane) => pane.id);
  if (ids.length < 2) return hidden;
  if (room.width < 2 * PANE_MIN_WIDTH + gap) {
    for (const id of ids) if (id !== layout.active) hidden.add(id);
    return hidden;
  }
  // Least recent first: the panes `recent` does not name, then `recent` from its end.
  const order = [...ids.filter((id) => !layout.recent.includes(id)), ...[...layout.recent].reverse().filter((id) => ids.includes(id))];
  for (const id of order) {
    if (fits(layout.root, room, gap, hidden)) break;
    if (id !== layout.active) hidden.add(id);
  }
  return hidden;
}

/** The tree the engine draws: the layout's, with the panes that stepped aside hidden in place. */
export function drawnTree(root: LayoutNode, hidden: ReadonlySet<PaneId>): LayoutNode {
  let tree = root;
  for (const id of hidden) tree = setPaneHidden(tree, id, true);
  return tree;
}

export interface PaneRect {
  id: PaneId;
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * The pane next to `id` toward `edge` on screen (the ⋯ menu's Move left/right/up/down), or null: the nearest pane past
 * that side of it that overlaps it across, the one overlapping most when two are as near.
 */
export function neighbor(rects: readonly PaneRect[], id: PaneId, edge: Edge): PaneId | null {
  const from = rects.find((rect) => rect.id === id);
  if (!from) return null;
  let best: { id: PaneId; distance: number; overlap: number } | null = null;
  for (const rect of rects) {
    if (rect.id === id) continue;
    const across = edge === 'left' || edge === 'right';
    const overlap = across ? Math.min(from.bottom, rect.bottom) - Math.max(from.top, rect.top) : Math.min(from.right, rect.right) - Math.max(from.left, rect.left);
    if (overlap <= 1) continue;
    const distance = edge === 'left' ? from.left - rect.right : edge === 'right' ? rect.left - from.right : edge === 'top' ? from.top - rect.bottom : rect.top - from.bottom;
    if (distance < -1) continue;
    if (!best || distance < best.distance - 1 || (Math.abs(distance - best.distance) <= 1 && overlap > best.overlap)) best = { id: rect.id, distance, overlap };
  }
  return best?.id ?? null;
}
