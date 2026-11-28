/**
 * The free layout of thread panes (config.json `inboxSplitView`): which panes there are, where each sits, how big it
 * is, the thread each shows and the active one. Pure data and verbs: every verb returns a new layout, or the same one
 * when nothing changes. The tree is @pierre/layouts' n-ary model (packages/vendor-pierre-layouts): a pane node has no
 * payload, so `threads` maps each pane id to its thread. A pane id names the pane, never its place, so a pane drawn by
 * id keeps its state when another pane closes or moves.
 *
 * One thread shows in one pane at most: opening a thread another pane shows makes that pane active instead. The
 * active pane is the one the address (`#thread=`) names, R, J/K and typing go to, and the only one whose messages
 * count as seen. `recent` orders the panes by when the person was last in them (the active one first): when the
 * window is too small for every pane, the least recent step aside first (layoutRoom.ts).
 *
 * A file pane later: `threads` becomes `contents` keyed by pane id (`{ kind: 'thread', id } | { kind: 'file', ... }`)
 * and the pane view draws by kind; the tree, the verbs and the room rules here do not change.
 */
import { naryTree, type ChildSize, type Edge, type LayoutNode, type PaneNode } from '@plannotator/vendor-pierre-layouts';
import { MAIN_PANE, singlePane, type PaneSet } from './model';

export type PaneId = string;
export type { Edge };
/** Where a thread dropped on a pane goes: beside it at an edge, or in its place (`center`). */
export type DropPlace = Edge | 'center';

/**
 * The narrowest a pane of the free layout gets: its header, the reply bar (Reply, Looks good, the open-question chip),
 * question cards and a message stay whole at 400 px (the owner, 2026-11-16: "lower the minimum width to about 400 px,
 * so three columns fit at 1728"). It is the floor: every room rule reads it (layoutRoom.ts: stepping aside, Open to the
 * side; paneDrop.ts and outerEdge.ts: a drop's fit; sidebarHold.ts: the sidebar folded for room; savedLayout.ts: a kept
 * layout's panes), and the engine keeps a divider from taking a pane below it. Where a pane would go narrower, nothing
 * opens there ("No room on the right"). A single thread beside the list keeps stack.ts's 440 px.
 */
export const PANE_MIN_WIDTH = 400;
/** The header, a few lines of the thread and its foot. */
export const PANE_MIN_HEIGHT = 260;

export interface FreeLayout {
  /** The tree of the panes, null when no thread is open. Never carries `hidden`: what steps aside for room is drawn, not stored. */
  readonly root: LayoutNode | null;
  readonly threads: Readonly<Record<PaneId, string>>;
  readonly active: PaneId | null;
  /** Pane ids, the most recently active first. */
  readonly recent: readonly PaneId[];
  /** The next pane id's number. */
  readonly serial: number;
}

export const EMPTY_LAYOUT: FreeLayout = { root: null, threads: {}, active: null, recent: [], serial: 1 };

export const paneNode = (id: PaneId): PaneNode => ({ type: 'pane', id, minWidth: PANE_MIN_WIDTH, minHeight: PANE_MIN_HEIGHT });

/** Every pane of a tree, in tree order (left to right, top to bottom). */
export function panesOf(root: LayoutNode | null): PaneNode[] {
  if (!root) return [];
  if (root.type === 'pane') return [root];
  return root.children.flatMap((child) => panesOf(child));
}

export const paneCount = (layout: FreeLayout): number => Object.keys(layout.threads).length;

/** The pane showing `thread`, or null. */
export function paneOfThread(layout: FreeLayout, thread: string): PaneId | null {
  for (const [id, shown] of Object.entries(layout.threads)) if (shown === thread) return id;
  return null;
}

export const activeThread = (layout: FreeLayout): string | null => (layout.active ? (layout.threads[layout.active] ?? null) : null);

/** The pane at the top left: the first child of every split down from the root. */
export function firstPane(root: LayoutNode | null): PaneId | null {
  let node = root;
  while (node && node.type !== 'pane') node = node.children[0]!;
  return node?.id ?? null;
}

function allIds(node: LayoutNode): string[] {
  return node.type === 'pane' ? [node.id] : [node.id, ...node.children.flatMap(allIds)];
}

/** Names for new splits that no node of `root` has. */
function splitIds(root: LayoutNode): () => string {
  const taken = new Set(allIds(root));
  let n = 0;
  return () => {
    let id: string;
    do id = `split-${++n}`;
    while (taken.has(id));
    taken.add(id);
    return id;
  };
}

/** The tree in the n-ary model's shape: no split holds a split of its own direction. */
const shaped = (root: LayoutNode): LayoutNode => naryTree.normalize(root, splitIds(root));

const splitTree = (root: LayoutNode, target: PaneId, pane: PaneNode, edge: Edge): LayoutNode =>
  shaped(naryTree.split(root, target, pane, edge, splitIds(root)));

/**
 * The target that names the whole layout (`openAt`, `move`): a pane put at its edge spans its full height (left,
 * right) or full width (top, bottom), beside every pane, where a pane's own edge splits that pane only.
 */
export const WHOLE: PaneId = '*';

/**
 * `pane` at `edge` of the whole tree. The engine splits a pane or a stack only (its `split` takes no split as its
 * target), so this puts the tree and the pane in a new split and lets the engine's normalize join it into a root of
 * that direction, as its own split would. The pane takes one column's share (one row's for top and bottom), not half.
 */
function besideAll(root: LayoutNode, pane: PaneNode, edge: Edge): LayoutNode {
  const horizontal = edge === 'left' || edge === 'right';
  const share = horizontal ? columns(root) : rows(root);
  const first = edge === 'left' || edge === 'top';
  return shaped({
    type: 'split',
    id: splitIds(root)(),
    direction: horizontal ? 'horizontal' : 'vertical',
    children: first ? [pane, root] : [root, pane],
    sizes: first ? [1, share] : [share, 1],
  });
}

/** Pane `id` is already the whole layout's first (left, top) or last (right, bottom) child toward `edge`. */
function atWholeEdge(root: LayoutNode, id: PaneId, edge: Edge): boolean {
  if (root.type !== 'split' || root.direction !== (edge === 'left' || edge === 'right' ? 'horizontal' : 'vertical')) return false;
  const end = edge === 'left' || edge === 'top' ? root.children[0] : root.children[root.children.length - 1];
  return end?.type === 'pane' && end.id === id;
}

/** A pane id no pane has. */
function newId(layout: FreeLayout): PaneId {
  let serial = layout.serial;
  while (`p${serial}` in layout.threads) serial++;
  return `p${serial}`;
}

const touch = (recent: readonly PaneId[], id: PaneId): PaneId[] => [id, ...recent.filter((other) => other !== id)];

/** `id` is the active pane now. */
export function focus(layout: FreeLayout, id: PaneId): FreeLayout {
  if (layout.active === id || !(id in layout.threads)) return layout;
  return { ...layout, active: id, recent: touch(layout.recent, id) };
}

/**
 * The address names `thread` (a row, J/K, a link, Back). A thread another pane shows makes that pane active; any other
 * thread shows in the active pane; with no pane yet, one pane opens with it. Null changes nothing here (`close` does).
 */
export function follow(layout: FreeLayout, thread: string | null): FreeLayout {
  if (thread === null || activeThread(layout) === thread) return layout;
  const shownIn = paneOfThread(layout, thread);
  if (shownIn !== null) return focus(layout, shownIn);
  if (!layout.root || !layout.active) {
    // The first pane has the id a window without the switch draws (model.ts), so its reads carry over.
    return { root: paneNode(MAIN_PANE), threads: { [MAIN_PANE]: thread }, active: MAIN_PANE, recent: [MAIN_PANE], serial: layout.serial };
  }
  return { ...layout, threads: { ...layout.threads, [layout.active]: thread } };
}

/**
 * `thread` opens in a new pane at `edge` of `target`, and the person is in it. A thread another pane shows moves
 * that pane there instead (a row dragged onto an edge, its thread already open).
 */
export function openAt(layout: FreeLayout, thread: string, target: PaneId, edge: Edge): FreeLayout {
  if (!layout.root || (target !== WHOLE && !(target in layout.threads))) return follow(layout, thread);
  const shownIn = paneOfThread(layout, thread);
  if (shownIn !== null) return focus(move(layout, shownIn, target, edge), shownIn);
  const id = newId(layout);
  return {
    root: target === WHOLE ? besideAll(layout.root, paneNode(id), edge) : splitTree(layout.root, target, paneNode(id), edge),
    threads: { ...layout.threads, [id]: thread },
    active: id,
    recent: touch(layout.recent, id),
    serial: Number(id.slice(1)) + 1,
  };
}

/** `thread` takes pane `target`'s place (a row dropped on its centre), and the person is in it. Already shown: that pane is active. */
export function replace(layout: FreeLayout, target: PaneId, thread: string): FreeLayout {
  if (!(target in layout.threads)) return follow(layout, thread);
  const shownIn = paneOfThread(layout, thread);
  if (shownIn !== null) return focus(layout, shownIn);
  return focus({ ...layout, threads: { ...layout.threads, [target]: thread } }, target);
}

/** Pane `id` goes to `edge` of pane `target` (of the whole layout: `WHOLE`). Its thread and the active pane stay. */
export function move(layout: FreeLayout, id: PaneId, target: PaneId, edge: Edge): FreeLayout {
  if (!layout.root || id === target || !(id in layout.threads) || (target !== WHOLE && !(target in layout.threads))) return layout;
  if (target === WHOLE && atWholeEdge(layout.root, id, edge)) return layout;
  const rest = naryTree.remove(layout.root, id);
  const moving = panesOf(layout.root).find((pane) => pane.id === id);
  if (!rest || !moving) return layout;
  return { ...layout, root: target === WHOLE ? besideAll(rest, moving, edge) : splitTree(rest, target, moving, edge) };
}

/**
 * Pane `id` closes and its room goes to its neighbours. The active pane closing makes the most recent other pane
 * active. The last pane closing leaves no layout: the window is today's list with no thread open.
 */
export function close(layout: FreeLayout, id: PaneId): FreeLayout {
  if (!layout.root || !(id in layout.threads)) return layout;
  const root = naryTree.remove(layout.root, id);
  if (!root) return { ...EMPTY_LAYOUT, serial: layout.serial };
  const { [id]: _gone, ...threads } = layout.threads;
  const recent = layout.recent.filter((other) => other !== id && other in threads);
  const active = layout.active === id || !layout.active ? (recent[0] ?? firstPane(root)!) : layout.active;
  return { ...layout, root: shaped(root), threads, active, recent: touch(recent, active) };
}

/** The panes showing a thread for which `gone` holds (archived, deleted) close. */
export function closeWhere(layout: FreeLayout, gone: (thread: string) => boolean): FreeLayout {
  let next = layout;
  for (const [id, thread] of Object.entries(layout.threads)) if (gone(thread)) next = close(next, id);
  return next;
}

/** The splits' sizes the person dragged (the engine's `onResize`, by split id), kept in the layout. */
export function resize(layout: FreeLayout, sizes: Readonly<Record<string, readonly ChildSize[]>>): FreeLayout {
  if (!layout.root) return layout;
  const apply = (node: LayoutNode): LayoutNode => {
    if (node.type !== 'split') return node;
    const children = node.children.map(apply);
    const given = sizes[node.id];
    const nextSizes = given && given.length === node.sizes.length ? given : node.sizes;
    return nextSizes === node.sizes && children.every((child, i) => child === node.children[i]) ? node : { ...node, children, sizes: nextSizes };
  };
  const root = apply(layout.root);
  return root === layout.root ? layout : { ...layout, root };
}

/** The panes as the window's reads take them (paneReads.ts, model.ts): every pane in tree order, and the active one. */
export function asPaneSet(layout: FreeLayout): PaneSet {
  const panes = panesOf(layout.root).map((pane) => ({ id: pane.id, thread: layout.threads[pane.id] ?? null }));
  return panes.length && layout.active ? { panes, active: layout.active } : singlePane(null);
}

/** How many thread columns side by side the layout needs at least: a row adds its children's, a column takes its widest. */
export function columns(node: LayoutNode | null): number {
  if (!node || node.type !== 'split') return 1;
  const each = node.children.map(columns);
  return node.direction === 'horizontal' ? each.reduce((a, b) => a + b, 0) : Math.max(...each);
}

/** How many thread rows stacked the layout needs at least: a column adds its children's, a row takes its tallest. */
export function rows(node: LayoutNode | null): number {
  if (!node || node.type !== 'split') return 1;
  const each = node.children.map(rows);
  return node.direction === 'vertical' ? each.reduce((a, b) => a + b, 0) : Math.max(...each);
}
