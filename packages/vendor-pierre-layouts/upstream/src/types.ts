export type Direction = 'horizontal' | 'vertical';
export type Edge = 'left' | 'right' | 'top' | 'bottom';

export interface PaneNode {
  readonly type: 'pane';
  readonly id: string;
  readonly minWidth?: number;
  readonly minHeight?: number;
  /**
   * The largest size of the pane while other panes can take the space. When
   * every pane that shares the space of a split has its maximum size, they
   * grow past it, so that the layout has no empty space.
   */
  readonly maxWidth?: number;
  readonly maxHeight?: number;
  /**
   * A hidden pane keeps its place in the tree, its content, and its state, but
   * takes no space and does not render.
   */
  readonly hidden?: boolean;
  /**
   * A collapsed pane takes `collapsedSize` pixels along its split, for example
   * the height of its header, and its content does not render. It keeps its
   * size in the split for when it expands again. A pane of a stack does not
   * collapse on its own: its stack collapses.
   */
  readonly collapsed?: boolean;
  /** The size of the pane along its split when it is collapsed. 0 by default. */
  readonly collapsedSize?: number;
}

/**
 * Two or more panes in one place, with tabs. One pane shows at a time: the
 * active pane. The others keep their content and their state, and do not
 * render. The stack takes the minimum size of its largest pane, so a change
 * of the active pane changes no other box.
 */
export interface StackNode {
  readonly type: 'stack';
  readonly id: string;
  /** The panes in the order of their tabs. */
  readonly children: readonly PaneNode[];
  /** The ID of the pane that shows. */
  readonly active: string;
  /** A collapsed stack takes `collapsedSize` pixels along its split. */
  readonly collapsed?: boolean;
  /** The size of the stack along its split when it is collapsed. 0 by default. */
  readonly collapsedSize?: number;
}

/**
 * The size of a child in its split: a positive weight, for a child that
 * shares the space of the split with the other weighted children, or a fixed
 * size in pixels, for a child that keeps its size when the split changes
 * size, such as a sidebar.
 */
export type ChildSize = number | { readonly px: number };

/**
 * A row (`horizontal`) or a column (`vertical`) of two or more children. The
 * tree model of the store sets the other rules of the shape (see `TreeModel`).
 */
export interface SplitNode {
  readonly type: 'split';
  readonly id: string;
  readonly direction: Direction;
  /** Left to right in a row, top to bottom in a column. */
  readonly children: readonly LayoutNode[];
  /**
   * The preferred size of each child, in the order of `children`: a weight or
   * a size in pixels (see `ChildSize`). A child with a size in pixels keeps
   * it. The other visible children share the rest of the space of the split,
   * without its separators, in proportion to their weights. When the space
   * shrinks, the weighted children shrink to their minimum sizes first, then
   * the children with sizes in pixels. A hidden child keeps its size for when
   * it shows again.
   */
  readonly sizes: readonly ChildSize[];
}

export type LayoutNode = PaneNode | StackNode | SplitNode;

export interface TabOptions {
  /** Defaults to true. False keeps the destination's active tab. */
  readonly activate?: boolean;
}

export interface StoredLayoutTree {
  readonly version: 3;
  readonly root: LayoutNode;
}

/**
 * The rules of the tree's shape, and how a split and a close change it. The
 * geometry, the drag, and the view are the same for each model.
 */
export interface TreeModel {
  readonly name: string;
  /** Throw when a tree does not have the shape of this model. */
  validate(root: LayoutNode): void;
  /**
   * Give a tree the shape of this model. Nodes that have that shape keep their
   * identity. `nextId` names each new split.
   */
  normalize(root: LayoutNode, nextId: () => string): LayoutNode;
  /**
   * Put a pane at one edge of a target: a pane outside a stack, or a stack.
   * `nextId` names a new split.
   */
  split(
    root: LayoutNode,
    targetId: string,
    pane: PaneNode,
    edge: Edge,
    nextId: () => string
  ): LayoutNode;
  /** Remove a pane. Null when no pane stays. */
  remove(root: LayoutNode, id: string): LayoutNode | null;
}

export interface LayoutState {
  readonly root: LayoutNode;
  readonly focusedPane: string;
  readonly zoomedPane: string | null;
}

export interface Rect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface PaneGeometry {
  readonly pane: PaneNode;
  readonly rect: Rect;
}

/** A visible child of a split, along the axis of the split, in pixels. */
export interface ChildExtent {
  /** The index of the child in `split.children`. */
  readonly index: number;
  readonly size: number;
  readonly min: number;
  /** The maximum size, or `Infinity`. */
  readonly max: number;
}

export interface SeparatorGeometry {
  /**
   * The ID of the separator: the ID of the split and the index of the child
   * after it (see `separatorId`).
   */
  readonly id: string;
  readonly split: SplitNode;
  /** The index in `split.children` of the child after the separator. */
  readonly index: number;
  readonly rect: Rect;
  /** The box of the split. */
  readonly container: Rect;
  /** The visible children of the split, in order. */
  readonly children: readonly ChildExtent[];
}

export interface CornerGeometry {
  readonly id: string;
  readonly x: number;
  readonly y: number;
  readonly separators: readonly SeparatorGeometry[];
}

export interface LayoutGeometry {
  readonly panes: readonly PaneGeometry[];
  readonly separators: readonly SeparatorGeometry[];
  readonly corners: readonly CornerGeometry[];
}
