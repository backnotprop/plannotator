import { getPanes } from './model';
import { naryTree } from './models/n-ary';
import { LayoutStore } from './store';
import type { LayoutNode, PaneNode, TreeModel } from './types';
import { groupsOf } from './view';

export const DEFAULT_LAYOUT_GROUP_ID = 'group-primary';

export function defaultLayoutTree(
  tabIds: readonly string[]
): LayoutNode | null {
  const unique = [...new Set(tabIds)];
  const panes: PaneNode[] = unique.map((id) => ({ type: 'pane', id }));
  if (panes.length === 0) return null;
  if (panes.length === 1) return panes[0];
  let groupId = DEFAULT_LAYOUT_GROUP_ID;
  for (let suffix = 1; unique.includes(groupId); suffix += 1)
    groupId = `${DEFAULT_LAYOUT_GROUP_ID}:${suffix}`;
  return {
    type: 'stack',
    id: groupId,
    children: panes,
    active: panes[0].id,
  };
}

/** Remove closed tabs and append new tabs without changing the active tab of a surviving group. */
export function reconcileLayoutTree(
  root: LayoutNode | null,
  tabIds: readonly string[],
  model: TreeModel = naryTree
): LayoutNode | null {
  const wanted = [...new Set(tabIds)];
  if (root === null) return defaultLayoutTree(wanted);
  const present = new Set(getPanes(root).map((pane) => pane.id));
  const wantedSet = new Set(wanted);
  if (![...present].some((id) => wantedSet.has(id)))
    return defaultLayoutTree(wanted);
  const missing = wanted.filter((id) => !present.has(id));
  const stale = [...present].filter((id) => !wantedSet.has(id));
  if (missing.length === 0 && stale.length === 0) return root;
  const store = new LayoutStore(root, { model });
  for (const id of stale) store.close(id);
  for (const id of missing) {
    const first = groupsOf(store.getSnapshot().root)[0];
    store.addTab(
      first.tabs[first.tabs.length - 1],
      { type: 'pane', id },
      first.tabs.length,
      { activate: false }
    );
  }
  return store.getSnapshot().root;
}
