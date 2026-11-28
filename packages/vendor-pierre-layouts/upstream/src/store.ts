import {
  activatePane,
  addToStack,
  type BinaryLayoutNode,
  fromBinaryLayout,
  getPanes,
  moveTabTo,
  parentOf,
  replaceNode,
  sameNodes,
  setNodeCollapsed,
  setPaneHidden,
  shownPanes,
  slotOf,
  stackOf,
  validateLayout,
} from './model';
import { binaryTree } from './models/binary';
import type {
  ChildSize,
  Edge,
  LayoutNode,
  LayoutState,
  PaneNode,
  StoredLayoutTree,
  TabOptions,
  TreeModel,
} from './types';

export interface LayoutStoreOptions {
  /**
   * The rules of the tree's shape, and how a split and a close change it:
   * `binaryTree` (the default) or `naryTree`.
   */
  model?: TreeModel;
}

/** Own immutable layout state and notify adapters without coupling the model to a UI framework. */
export class LayoutStore {
  private state: LayoutState;
  private model: TreeModel;
  private readonly listeners = new Set<() => void>();
  private sequence = 0;

  constructor(root: LayoutNode, options: LayoutStoreOptions = {}) {
    this.model = options.model ?? binaryTree;
    const owned = copyAndFreeze(this.shape(root));
    this.state = Object.freeze({
      root: owned,
      focusedPane: shownPanes(owned)[0].id,
      zoomedPane: null,
    });
  }

  readonly getSnapshot = (): LayoutState => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getModel(): TreeModel {
    return this.model;
  }

  /** Change the tree model, and give the tree the shape of the new model. */
  setModel(model: TreeModel): void {
    if (model === this.model) return;
    const previous = this.model;
    this.model = model;
    try {
      this.commit({ ...this.state, root: this.shape(this.state.root) });
    } catch (error) {
      this.model = previous;
      throw error;
    }
  }

  /** Set the tree. A tree of another shape takes the shape of the model. */
  setRoot(root: LayoutNode): void {
    this.commit({ ...this.state, root: copyAndFreeze(this.shape(root)) });
  }

  focusPane(id: string): void {
    this.requirePane(id);
    if (this.state.focusedPane !== id)
      this.commit({ ...this.state, focusedPane: id });
  }

  /** Zoom a pane, or restore it. A pane of a stack also becomes active. */
  toggleZoom(id: string = this.state.focusedPane): void {
    this.requirePane(id);
    const restore = this.state.zoomedPane === id;
    this.commit({
      root: restore ? this.state.root : this.activeRoot(id),
      focusedPane: id,
      zoomedPane: restore ? null : id,
    });
  }

  /**
   * Show a pane of a stack. It takes the focus, and the zoom when the zoomed
   * pane is in the same stack.
   */
  activate(id: string): void {
    this.requirePane(id);
    const stack = stackOf(this.state.root, id);
    if (stack === null) throw new Error(`Pane not in a stack: ${id}`);
    const zoomed = this.state.zoomedPane;
    this.commit({
      root: activatePane(this.state.root, id),
      focusedPane: id,
      zoomedPane:
        zoomed !== null && stack.children.some((child) => child.id === zoomed)
          ? id
          : zoomed,
    });
  }

  /**
   * Add a new pane as a tab of a target pane, at `index` among the tabs of
   * its stack, or after the target. A target that is not in a stack gets a
   * stack in its place. The new pane shows and takes the focus unless
   * `activate` is false.
   */
  addTab(
    targetId: string,
    pane: PaneNode,
    index?: number,
    options: TabOptions = {}
  ): void {
    this.requirePane(targetId);
    const activate = options.activate ?? true;
    const root = addToStack(
      this.state.root,
      targetId,
      { ...pane },
      this.nextId(this.state.root, 'stack'),
      index,
      activate
    );
    this.commit(
      activate
        ? {
            root,
            focusedPane: pane.id,
            zoomedPane: this.zoomAfterTab(targetId, pane.id),
          }
        : { ...this.state, root }
    );
  }

  /**
   * Move a pane into the stack of a target pane, at `index` among its tabs, or
   * after the target. A move inside one stack changes the order of its tabs.
   * With `activate: false`, the destination keeps its active tab.
   */
  moveToStack(
    sourceId: string,
    targetId: string,
    index?: number,
    options: TabOptions = {}
  ): void {
    this.requirePane(sourceId);
    this.requirePane(targetId);
    if (sourceId === targetId) return;
    const activate = options.activate ?? true;
    const current = this.state.root;
    const source = getPanes(current).find(({ id }) => id === sourceId)!;
    const stack = stackOf(current, sourceId);
    let root: LayoutNode;
    if (stack !== null && stack === stackOf(current, targetId)) {
      // Keep the stack, and put the source at its new place among the tabs.
      const others = stack.children.filter(({ id }) => id !== sourceId);
      root = moveTabTo(
        current,
        sourceId,
        index ?? others.findIndex(({ id }) => id === targetId) + 1,
        activate
      );
    } else {
      const remaining = this.model.remove(current, sourceId);
      if (remaining === null) return;
      root = addToStack(
        remaining,
        targetId,
        source,
        this.nextId(current, 'stack'),
        index,
        activate
      );
    }
    this.commit(
      activate
        ? { root, focusedPane: sourceId, zoomedPane: null }
        : {
            ...this.state,
            root,
            focusedPane: this.focusAfterLeaving(sourceId, root),
          }
    );
  }

  /**
   * Move a pane to `index` among the tabs of its stack: the index in the
   * order of the other tabs, hidden ones included, from 0 to their number.
   * The pane shows and keeps the focus, and the zoom of its stack.
   */
  moveTab(id: string, index: number): void {
    this.requirePane(id);
    const root = moveTabTo(this.state.root, id, index);
    if (root === this.state.root) return;
    const zoomed = this.state.zoomedPane;
    const stack = stackOf(root, id);
    this.commit({
      root,
      focusedPane: id,
      zoomedPane:
        zoomed !== null &&
        stack?.children.some((pane) => pane.id === zoomed) === true
          ? id
          : zoomed,
    });
  }

  split(targetId: string, pane: PaneNode, edge: Edge = 'right'): void {
    this.requirePane(targetId);
    // The new pane comes from the caller, so the store keeps its own copy. A
    // split of a pane in a stack puts the new pane beside the stack.
    const root = this.model.split(
      this.state.root,
      slotOf(this.state.root, targetId),
      { ...pane },
      edge,
      () => this.nextId(this.state.root)
    );
    this.commit({ root, focusedPane: pane.id, zoomedPane: null });
  }

  close(id: string): void {
    this.requirePane(id);
    const root = this.model.remove(this.state.root, id);
    // The last visible pane stays: a layout needs one.
    if (root !== null && getPanes(root).some((pane) => pane.hidden !== true))
      this.commit({
        ...this.state,
        root,
        focusedPane: this.focusAfterLeaving(id, root),
      });
  }

  /**
   * Hide a pane or show it again. A hidden pane keeps its place in the tree,
   * its content, and its state, but takes no space. The last visible pane
   * stays visible. A pane that shows again gets the focus, and becomes the
   * active pane of its stack.
   */
  setHidden(id: string, hidden: boolean): void {
    this.requirePane(id);
    const visible = getPanes(this.state.root).filter(
      (pane) => pane.hidden !== true
    );
    if (hidden && visible.length === 1 && visible[0].id === id) return;
    let root = setPaneHidden(this.state.root, id, hidden);
    if (!hidden && stackOf(root, id) !== null) root = activatePane(root, id);
    if (root === this.state.root) return;
    this.commit({
      ...this.state,
      root,
      focusedPane: hidden ? this.focusAfterLeaving(id, root) : id,
    });
  }

  /**
   * Collapse a pane to its `collapsedSize` along its split, or expand it to
   * its size in the split again. A pane of a stack collapses its stack. The
   * pane at the root fills the layout, so it does not collapse.
   */
  setCollapsed(id: string, collapsed: boolean): void {
    this.requirePane(id);
    const slot = slotOf(this.state.root, id);
    if (parentOf(this.state.root, slot) === null) return;
    const root = setNodeCollapsed(this.state.root, slot, collapsed);
    if (root !== this.state.root) this.commit({ ...this.state, root });
  }

  /**
   * Move a pane to one edge of another pane. A target in a stack takes the
   * pane beside the whole stack. A pane of a stack leaves its stack.
   */
  move(sourceId: string, targetId: string, edge: Edge): void {
    const current = this.state.root;
    const source = getPanes(current).find(({ id }) => id === sourceId);
    if (source === undefined) throw new Error(`Pane not found: ${sourceId}`);
    this.requirePane(targetId);
    const remaining =
      sourceId === targetId ? null : this.model.remove(current, sourceId);
    const root =
      remaining === null
        ? current
        : this.model.split(
            remaining,
            slotOf(remaining, targetId),
            source,
            edge,
            () => this.nextId(current)
          );
    this.commit({ root, focusedPane: sourceId, zoomedPane: null });
  }

  /**
   * Set the sizes of splits, by split ID: one positive weight for each child
   * of the split, as in `SplitNode.sizes`.
   */
  setSizes(sizes: Readonly<Record<string, readonly ChildSize[]>>): void {
    let root = this.state.root;
    for (const [id, values] of Object.entries(sizes)) {
      root = replaceNode(root, id, (node) =>
        node.type === 'split' ? { ...node, sizes: [...values] } : node
      );
    }
    this.commit({ ...this.state, root });
  }

  serialize(): string {
    return JSON.stringify({ version: 3, ...this.state });
  }

  /** Return the tree without the window's focus and zoom state. */
  toStoredTree(): StoredLayoutTree {
    return Object.freeze({ version: 3, root: this.state.root });
  }

  setStoredTree(tree: StoredLayoutTree): void {
    this.setRoot(tree.root);
  }

  /**
   * Restore a layout from `serialize`. Version 3 added stacks. A layout of
   * version 2 has the same form with no stack. A layout of version 1, where
   * each split had two children, converts. The tree takes the shape of the
   * model.
   */
  restore(serialized: string): void {
    const value: unknown = JSON.parse(serialized);
    if (
      value === null ||
      typeof value !== 'object' ||
      !('version' in value) ||
      (value.version !== 1 && value.version !== 2 && value.version !== 3) ||
      !('root' in value) ||
      value.root === null ||
      typeof value.root !== 'object' ||
      !('focusedPane' in value) ||
      typeof value.focusedPane !== 'string' ||
      !('zoomedPane' in value) ||
      (value.zoomedPane !== null && typeof value.zoomedPane !== 'string')
    ) {
      throw new Error('Invalid layout state');
    }
    const root =
      value.version === 1
        ? fromBinaryLayout(value.root as BinaryLayoutNode)
        : (value.root as LayoutNode);
    this.commit({
      root: copyAndFreeze(this.shape(root)),
      focusedPane: value.focusedPane,
      zoomedPane: value.zoomedPane,
    });
  }

  /**
   * Give a tree the shape of the model, and validate it. The checks of
   * `validateLayout` come first, so that the model gets a sound tree.
   */
  private shape(root: LayoutNode): LayoutNode {
    validateLayout(root);
    const shaped = this.model.normalize(root, () => this.nextId(root));
    this.model.validate(shaped);
    return shaped;
  }

  private requirePane(id: string): void {
    if (!getPanes(this.state.root).some((pane) => pane.id === id))
      throw new Error(`Pane not found: ${id}`);
  }

  /**
   * The focus after a pane stops showing: the tab of its stack that shows
   * next, nearest first, when the pane had the focus.
   */
  private focusAfterLeaving(id: string, next: LayoutNode): string {
    const focused = this.state.focusedPane;
    const stack = stackOf(this.state.root, id);
    if (focused !== id || stack === null) return focused;
    const shown = new Set(shownPanes(next).map((pane) => pane.id));
    const at = stack.children.findIndex((pane) => pane.id === id);
    const nearest = [
      ...stack.children.slice(at + 1),
      ...stack.children.slice(0, at).reverse(),
    ].find((pane) => shown.has(pane.id));
    return nearest?.id ?? focused;
  }

  /** The tree with a pane active in its stack, or the tree itself. */
  private activeRoot(id: string): LayoutNode {
    return stackOf(this.state.root, id) === null
      ? this.state.root
      : activatePane(this.state.root, id);
  }

  /**
   * The zoom after a new tab: the new tab takes the zoom of its stack or of
   * its target. A zoom of another pane ends, so that the new tab shows.
   */
  private zoomAfterTab(targetId: string, paneId: string): string | null {
    const zoomed = this.state.zoomedPane;
    if (zoomed === null) return null;
    const stack = stackOf(this.state.root, targetId);
    const same =
      zoomed === targetId ||
      (stack !== null && stack.children.some(({ id }) => id === zoomed));
    return same ? paneId : null;
  }

  /** A split or stack ID that the tree does not use. */
  private nextId(root: LayoutNode, kind: 'split' | 'stack' = 'split'): string {
    let id: string;
    do {
      id = `layout-${kind}-${++this.sequence}`;
    } while (hasId(root, id));
    return id;
  }

  // The root of `next` holds only nodes that the store owns: frozen nodes of
  // the current tree, and new nodes from the model functions or from a copy of
  // caller input. Unchanged nodes keep their identity, so a view can skip them.
  private commit(next: LayoutState): void {
    const sameTree = next.root === this.state.root;
    if (!sameTree) this.model.validate(next.root);
    // Focus and zoom belong to panes that show only.
    const panes = shownPanes(next.root);
    const focusedPane = panes.some(({ id }) => id === next.focusedPane)
      ? next.focusedPane
      : panes[0].id;
    const zoomedPane = panes.some(({ id }) => id === next.zoomedPane)
      ? next.zoomedPane
      : null;
    this.state = Object.freeze({
      root: sameTree ? next.root : freezeNew(next.root),
      focusedPane,
      zoomedPane,
    });
    for (const listener of [...this.listeners]) listener();
  }
}

function hasId(node: LayoutNode, id: string): boolean {
  return (
    node.id === id ||
    (node.type !== 'pane' && node.children.some((child) => hasId(child, id)))
  );
}

/**
 * Copy the nodes of a tree that a caller owns and freeze the copies, so
 * neither side can change the other's state. A node that is frozen with its
 * whole subtree, such as a node of the store's own tree, is kept: a kept pane
 * node keeps its content from rendering again.
 */
function copyAndFreeze(node: LayoutNode): LayoutNode {
  if (node.type === 'pane')
    return Object.isFrozen(node) ? node : Object.freeze({ ...node });
  if (node.type === 'stack') {
    const tabs = node.children.map((child) => copyAndFreeze(child) as PaneNode);
    if (Object.isFrozen(node) && sameNodes(tabs, node.children)) return node;
    return Object.freeze({ ...node, children: Object.freeze(tabs) });
  }
  const children = node.children.map(copyAndFreeze);
  if (
    Object.isFrozen(node) &&
    Object.isFrozen(node.sizes) &&
    sameNodes(children, node.children)
  )
    return node;
  return Object.freeze({
    ...node,
    children: Object.freeze(children),
    sizes: Object.freeze([...node.sizes]),
  });
}

/**
 * Freeze the nodes that a model function created, with their lists. A frozen
 * node is a node of an earlier tree, frozen with its whole subtree, so the
 * walk stops there.
 */
function freezeNew(node: LayoutNode): LayoutNode {
  if (Object.isFrozen(node)) return node;
  if (node.type === 'split') {
    node.children.forEach(freezeNew);
    Object.freeze(node.children);
    Object.freeze(node.sizes);
  } else if (node.type === 'stack') {
    node.children.forEach(freezeNew);
    Object.freeze(node.children);
  }
  return Object.freeze(node);
}
