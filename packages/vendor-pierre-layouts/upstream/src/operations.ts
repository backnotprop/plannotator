import { findNode, getPanes, parentOf, stackOf } from './model';
import { naryTree } from './models/n-ary';
import { LayoutStore } from './store';
import type {
  ChildSize,
  Edge,
  LayoutNode,
  PaneNode,
  SplitNode,
  TreeModel,
} from './types';
import { groupOf, groupsOf } from './view';

export type TabPlace =
  | { readonly into: string; readonly index?: number }
  | { readonly beside: string; readonly edge: Edge };

export type LayoutTreeOperation =
  | {
      readonly op: 'open';
      readonly tab: string;
      readonly place?: TabPlace;
      readonly select?: boolean;
    }
  | { readonly op: 'select'; readonly tab: string }
  | { readonly op: 'close'; readonly tab: string }
  | { readonly op: 'move'; readonly tab: string; readonly place: TabPlace }
  | {
      readonly op: 'resize';
      readonly tab: string;
      readonly sizes: readonly ChildSize[];
      readonly level?: number;
    };

export type LayoutOperationErrorCode =
  | 'tab_not_found'
  | 'invalid_place'
  | 'layout_limit'
  | 'last_tab'
  | 'invalid_sizes';

export class LayoutOperationError extends Error {
  readonly code: LayoutOperationErrorCode;

  constructor(code: LayoutOperationErrorCode, message: string) {
    super(message);
    this.name = 'LayoutOperationError';
    this.code = code;
  }
}

export interface ApplyLayoutOperationsOptions {
  readonly model?: TreeModel;
  /** Optional consumer limit. By default, the number of groups is unlimited. */
  readonly maxGroups?: number;
}

/** Apply a batch to an isolated store. A failed operation leaves the input tree unchanged. */
export function applyLayoutOperations(
  root: LayoutNode,
  operations: readonly LayoutTreeOperation[],
  options: ApplyLayoutOperationsOptions = {}
): LayoutNode {
  const store = new LayoutStore(root, { model: options.model ?? naryTree });
  const maxGroups = options.maxGroups ?? Infinity;
  for (const operation of operations) {
    const before = groupsOf(store.getSnapshot().root).length;
    applyOperation(store, operation);
    const after = groupsOf(store.getSnapshot().root).length;
    if (after > before && after > maxGroups)
      throw new LayoutOperationError(
        'layout_limit',
        `A layout holds at most ${maxGroups} groups`
      );
  }
  return store.getSnapshot().root;
}

function applyOperation(
  store: LayoutStore,
  operation: LayoutTreeOperation
): void {
  switch (operation.op) {
    case 'open':
      openTab(store, operation.tab, operation.place, operation.select === true);
      return;
    case 'select':
      requireTab(store, operation.tab);
      selectTab(store, operation.tab);
      return;
    case 'close':
      closeTab(store, operation.tab);
      return;
    case 'resize':
      resizeSplit(store, operation.tab, operation.sizes, operation.level ?? 0);
      return;
    case 'move':
      moveTab(store, operation.tab, operation.place);
      return;
  }
}

function hasTab(store: LayoutStore, id: string): boolean {
  return getPanes(store.getSnapshot().root).some((pane) => pane.id === id);
}

function requireTab(store: LayoutStore, id: string): void {
  if (!hasTab(store, id))
    throw new LayoutOperationError('tab_not_found', `Tab not found: ${id}`);
}

function selectTab(store: LayoutStore, id: string): void {
  if (stackOf(store.getSnapshot().root, id) !== null) store.activate(id);
}

function openTab(
  store: LayoutStore,
  id: string,
  place: TabPlace | undefined,
  select: boolean
): void {
  if (hasTab(store, id)) {
    if (select) selectTab(store, id);
    return;
  }
  const pane: PaneNode = { type: 'pane', id };
  const root = store.getSnapshot().root;
  if (place === undefined) {
    const first = groupsOf(root)[0];
    store.addTab(first.tabs[first.tabs.length - 1], pane, first.tabs.length, {
      activate: select,
    });
    return;
  }
  if ('into' in place) {
    requireTab(store, place.into);
    const group = groupOf(root, place.into)!;
    store.addTab(place.into, pane, place.index ?? group.tabs.length, {
      activate: select,
    });
    return;
  }
  requireTab(store, place.beside);
  store.split(place.beside, pane, place.edge);
}

function closeTab(store: LayoutStore, id: string): void {
  requireTab(store, id);
  if (getPanes(store.getSnapshot().root).length === 1)
    throw new LayoutOperationError(
      'last_tab',
      `The last tab of a layout does not close: ${id}`
    );
  store.close(id);
}

function moveTab(store: LayoutStore, id: string, place: TabPlace): void {
  requireTab(store, id);
  const root = store.getSnapshot().root;
  if ('into' in place) {
    requireTab(store, place.into);
    const group = groupOf(root, place.into)!;
    const target =
      place.into === id ? group.tabs.find((tab) => tab !== id) : place.into;
    if (target === undefined)
      throw new LayoutOperationError(
        'invalid_place',
        `A tab does not move into its own lone group: ${id}`
      );
    store.moveToStack(id, target, place.index ?? group.tabs.length, {
      activate: false,
    });
    return;
  }
  requireTab(store, place.beside);
  if (place.beside === id)
    throw new LayoutOperationError(
      'invalid_place',
      `A tab does not move beside its own lone group: ${id}`
    );
  store.move(id, place.beside, place.edge);
}

export interface SplitAddress {
  readonly tab: string;
  readonly level: number;
}

function groupSlotOf(root: LayoutNode, tab: string): string {
  return stackOf(root, tab)?.id ?? tab;
}

export function splitOfTab(
  root: LayoutNode,
  tab: string,
  level = 0
): SplitNode | null {
  let id = groupSlotOf(root, tab);
  for (let step = 0; step <= level; step += 1) {
    const parent = parentOf(root, id);
    if (parent === null) return null;
    if (step === level) return parent;
    id = parent.id;
  }
  return null;
}

/** Address a split through one of its tabs, without exposing generated split IDs. */
export function splitAddressOf(
  root: LayoutNode,
  splitId: string
): SplitAddress | null {
  const split = findNode(root, splitId);
  if (split === null || split.type !== 'split') return null;
  let level = 0;
  let node: LayoutNode = split.children[0];
  while (node.type === 'split') {
    node = node.children[0];
    level += 1;
  }
  return {
    tab: node.type === 'stack' ? node.children[0].id : node.id,
    level,
  };
}

function isChildSize(size: ChildSize): boolean {
  return typeof size === 'number'
    ? Number.isFinite(size) && size > 0
    : Number.isFinite(size.px) && size.px >= 0;
}

function resizeSplit(
  store: LayoutStore,
  tab: string,
  sizes: readonly ChildSize[],
  level: number
): void {
  requireTab(store, tab);
  if (!Number.isInteger(level) || level < 0)
    throw new LayoutOperationError(
      'invalid_place',
      `A level counts splits from 0: ${level}`
    );
  const split = splitOfTab(store.getSnapshot().root, tab, level);
  if (split === null)
    throw new LayoutOperationError(
      'invalid_place',
      `No split holds the group of ${tab} at level ${level}`
    );
  if (sizes.length !== split.children.length)
    throw new LayoutOperationError(
      'invalid_sizes',
      `The split has ${split.children.length} children, and the request gives ${sizes.length} sizes`
    );
  if (!sizes.every(isChildSize))
    throw new LayoutOperationError(
      'invalid_sizes',
      'A size is a positive weight or { px } of 0 or more'
    );
  store.setSizes({ [split.id]: sizes });
}
