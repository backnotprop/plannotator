/**
 * The window's thread panes: which panes there are, left to right, the thread each shows, and the active one (the
 * pane R, J/K and typing go to, and the only one whose messages count as seen). Pure data: every verb returns a new
 * set, or the same set when nothing changes.
 *
 * The verbs carry the names of @pierre/layouts' LayoutStore (`split`, `move`, `close`, `focusPane`), so its tree can
 * replace this row later and keep the panes' ids. A pane id names the pane, never its position: a pane drawn by id
 * keeps its state when another pane closes or moves.
 *
 * One thread shows in one pane at most: opening a thread another pane shows makes that pane the active one. Per-thread
 * state (the reply draft, dictation, a send on its way) can then be keyed by thread and still belong to one pane.
 *
 * The address (`#thread=`) always names the active pane's thread (`addressThread`). An address that changes is
 * followed (`followAddress`): a thread another pane shows focuses that pane, any other thread shows in the active pane.
 * Focusing a pane changes the address the other way: the window writes the newly active pane's thread to it.
 */

export type PaneId = string;

/** The pane the address (`#thread=`) drives. It is never closed, only emptied. */
export const MAIN_PANE: PaneId = 'main';

export interface ThreadPaneEntry {
  readonly id: PaneId;
  readonly thread: string | null;
}

export interface PaneSet {
  readonly panes: readonly ThreadPaneEntry[];
  readonly active: PaneId;
}

export type PaneEdge = 'left' | 'right';

export const singlePane = (thread: string | null = null): PaneSet => ({ panes: [{ id: MAIN_PANE, thread }], active: MAIN_PANE });

export const paneThread = (set: PaneSet, id: PaneId): string | null => set.panes.find((pane) => pane.id === id)?.thread ?? null;

/** The pane showing `thread`, or null. */
export const paneOf = (set: PaneSet, thread: string): PaneId | null => set.panes.find((pane) => pane.thread === thread)?.id ?? null;

export const hasPane = (set: PaneSet, id: PaneId): boolean => set.panes.some((pane) => pane.id === id);

/** `target` (the active pane by default) shows `thread` (null: nothing). A thread another pane shows focuses that pane instead. */
export function open(set: PaneSet, thread: string | null, target: PaneId = set.active): PaneSet {
  if (!hasPane(set, target)) return set;
  const shownIn = thread === null ? null : paneOf(set, thread);
  if (shownIn !== null && shownIn !== target) return focusPane(set, shownIn);
  if (paneThread(set, target) === thread) return set;
  return { ...set, panes: set.panes.map((pane) => (pane.id === target ? { ...pane, thread } : pane)) };
}

/** `pane` is added beside `target` and becomes active. A thread already shown focuses its pane; a taken id changes nothing. */
export function split(set: PaneSet, target: PaneId, pane: ThreadPaneEntry, edge: PaneEdge = 'right'): PaneSet {
  const at = set.panes.findIndex((entry) => entry.id === target);
  if (at < 0 || hasPane(set, pane.id)) return set;
  const shownIn = pane.thread === null ? null : paneOf(set, pane.thread);
  if (shownIn !== null) return focusPane(set, shownIn);
  const panes = [...set.panes];
  panes.splice(edge === 'right' ? at + 1 : at, 0, pane);
  return { panes, active: pane.id };
}

/** `id` goes to the `edge` of `target`. Moving changes no pane's thread and not which one is active. */
export function move(set: PaneSet, id: PaneId, target: PaneId, edge: PaneEdge): PaneSet {
  if (id === target || !hasPane(set, id) || !hasPane(set, target)) return set;
  const moving = set.panes.find((pane) => pane.id === id)!;
  const rest = set.panes.filter((pane) => pane.id !== id);
  const at = rest.findIndex((pane) => pane.id === target);
  const panes = [...rest];
  panes.splice(edge === 'right' ? at + 1 : at, 0, moving);
  if (panes.every((pane, i) => pane === set.panes[i])) return set;
  return { ...set, panes };
}

/**
 * `id` goes; the main pane only empties. Closing the active pane makes its left neighbour active (the right one when
 * it was first).
 */
export function close(set: PaneSet, id: PaneId): PaneSet {
  const at = set.panes.findIndex((pane) => pane.id === id);
  if (at < 0) return set;
  if (id === MAIN_PANE) return open(set, null, MAIN_PANE);
  const panes = set.panes.filter((pane) => pane.id !== id);
  const active = set.active === id ? panes[Math.max(0, at - 1)]!.id : set.active;
  return { panes, active };
}

/**
 * The person closes pane `id`: beside another pane it goes, and the main pane, which never goes, takes the thread of
 * the pane beside it instead (so one pane left is the main pane, as before any split). Alone, it only empties.
 */
export function closePane(set: PaneSet, id: PaneId): PaneSet {
  if (id !== MAIN_PANE || set.panes.length < 2) return close(set, id);
  const [next, ...rest] = set.panes.filter((pane) => pane.id !== MAIN_PANE);
  const active = set.active === MAIN_PANE || set.active === next!.id ? MAIN_PANE : set.active;
  return { panes: [{ id: MAIN_PANE, thread: next!.thread }, ...rest], active };
}

export function focusPane(set: PaneSet, id: PaneId): PaneSet {
  return set.active === id || !hasPane(set, id) ? set : { ...set, active: id };
}

/** The thread the address names: the active pane's. */
export const addressThread = (set: PaneSet): string | null => paneThread(set, set.active);

/** The set after the address changed to `thread`; afterwards `addressThread` is `thread`. */
export const followAddress = (set: PaneSet, thread: string | null): PaneSet => (addressThread(set) === thread ? set : open(set, thread));
