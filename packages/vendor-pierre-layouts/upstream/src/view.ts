import { isFixed } from './model';
import type { ChildSize, LayoutNode, PaneNode, StackNode } from './types';

export interface LayoutGroupView {
  type: 'group';
  tabs: string[];
  active: string;
}

export interface LayoutSplitView {
  type: 'split';
  direction: 'row' | 'column';
  sizes: (number | { px: number })[];
  children: LayoutNodeView[];
}

export type LayoutNodeView = LayoutGroupView | LayoutSplitView;

function groupView(node: PaneNode | StackNode): LayoutGroupView {
  return node.type === 'pane'
    ? { type: 'group', tabs: [node.id], active: node.id }
    : {
        type: 'group',
        tabs: node.children.map((child) => child.id),
        active: node.active,
      };
}

const sizeView = (size: ChildSize): number | { px: number } =>
  isFixed(size) ? { px: size.px } : size;

/** A compact read form for groups and sizes. Use StoredLayoutTree to retain all node properties. */
export function toLayoutNodeView(root: LayoutNode): LayoutNodeView {
  if (root.type !== 'split') return groupView(root);
  return {
    type: 'split',
    direction: root.direction === 'horizontal' ? 'row' : 'column',
    sizes: root.sizes.map(sizeView),
    children: root.children.map(toLayoutNodeView),
  };
}

export function groupsOf(root: LayoutNode): LayoutGroupView[] {
  return root.type === 'split'
    ? root.children.flatMap(groupsOf)
    : [groupView(root)];
}

export function groupOf(
  root: LayoutNode,
  tabId: string
): LayoutGroupView | null {
  return groupsOf(root).find((group) => group.tabs.includes(tabId)) ?? null;
}

export function exceedsGroupLimit(root: LayoutNode, limit: number): boolean {
  return groupsOf(root).length > limit;
}

const firstTabOf = (view: LayoutNodeView): string =>
  view.type === 'group' ? view.tabs[0] : firstTabOf(view.children[0]);

/** Rebuild a trusted read form with deterministic IDs; omitted node properties are not restored. */
export function fromLayoutNodeView(view: LayoutNodeView): LayoutNode {
  const ids = new Set<string>();
  const collectTabs = (node: LayoutNodeView): void => {
    if (node.type === 'group') {
      for (const tab of node.tabs) ids.add(tab);
    } else node.children.forEach(collectTabs);
  };
  collectTabs(view);
  const nodeId = (base: string): string => {
    let id = base;
    for (let suffix = 1; ids.has(id); suffix += 1) id = `${base}:${suffix}`;
    ids.add(id);
    return id;
  };
  const visit = (node: LayoutNodeView, depth: number): LayoutNode => {
    if (node.type === 'group') {
      if (node.tabs.length === 1) return { type: 'pane', id: node.tabs[0] };
      return {
        type: 'stack',
        id: nodeId(`layout-stack:${node.tabs[0]}`),
        children: node.tabs.map((id): PaneNode => ({ type: 'pane', id })),
        active: node.active,
      };
    }
    return {
      type: 'split',
      id: nodeId(`layout-split:${depth}:${firstTabOf(node)}`),
      direction: node.direction === 'row' ? 'horizontal' : 'vertical',
      sizes: node.sizes.map(
        (size): ChildSize => (typeof size === 'number' ? size : { px: size.px })
      ),
      children: node.children.map((child) => visit(child, depth + 1)),
    };
  };
  return visit(view, 0);
}
