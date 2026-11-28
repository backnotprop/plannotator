'use client';

import {
  type CSSProperties,
  type HTMLAttributes,
  type JSX,
  type KeyboardEvent,
  memo,
  type PointerEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import {
  ALL_EDGES,
  computeCSSLayout,
  type CSSLayout,
  type CSSSeparator,
  type PaneEdges,
} from '../css-layout';
import {
  animateFromBoxes,
  cancelFlipAnimations,
  finishFlipAnimations,
  readBoxes,
} from '../dom/flip';
import {
  focusOwner,
  focusPane,
  focusTab,
  focusZoomedPane,
  hideCoveredAfterAnimation,
  hostOf,
  notifyHidden,
  readPixelGeometry,
  separatorIdsAt,
  setCollapsedContent,
  setCoveredHidden,
} from '../dom/panes';
import { createResizeWork, type ResizeStrategy } from '../dom/resize-work';
import {
  boundaryOffset,
  clearTabDrop,
  readTabEdges,
  showTabDrop,
  TAB_CLOSE_ATTRIBUTE,
  type TabEdges,
  TABLIST_ATTRIBUTE,
  tablistAt,
  tabsOf,
} from '../dom/tab-drag';
import {
  dragSizes,
  dropTarget,
  getExitEdges,
  keySizes,
  paneAt,
  tabBoundaryAt,
  type TabDropTarget,
  tabDropTarget,
  tabInsertIndex,
  tabMoveIndex,
} from '../gestures';
import { findNode, getPanes, shownPanes, stackOf } from '../model';
import type { LayoutStore } from '../store';
import type {
  ChildSize,
  Edge,
  LayoutGeometry,
  LayoutNode,
  PaneNode,
  Rect,
  SeparatorGeometry,
  StackNode,
} from '../types';

export { PANE_VISIBILITY_EVENT, type PaneVisibilityEvent } from '../dom/panes';
export type { ResizeStrategy } from '../dom/resize-work';
export type { PaneEdges } from '../css-layout';
export type { DropPlace } from '../gestures';

/**
 * A button in a pane header: drag to move, zoom, close, or collapse. The
 * collapse button is not in the default actions.
 */
export type PaneAction = 'move' | 'zoom' | 'close' | 'collapse';

// Pane layers save compositing time from about 6 visible panes, and cost
// tile memory below that.
const DEFAULT_PANE_LAYERS = { minPanes: 6 };

const ALL_PANE_ACTIONS: readonly PaneAction[] = ['move', 'zoom', 'close'];

export interface LayoutTablistProps {
  role: 'tablist';
  'aria-label': string;
  'data-layout-tablist': '';
}

export interface LayoutTabProps {
  id: string;
  role: 'tab';
  'aria-selected': boolean;
  'aria-controls': string;
  tabIndex: number;
  'data-layout-tab': string;
  onPointerDown: (event: PointerEvent<HTMLElement>) => void;
  onClick: () => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}

export interface PaneHeaderProps {
  pane: PaneNode;
  stack: StackNode | null;
  tabs: readonly PaneNode[];
  edges: PaneEdges;
  focused: boolean;
  zoomed: boolean;
  collapsed: boolean;
  canClose: (id: string) => boolean;
  close: (id: string) => void;
  select: (id: string) => void;
  tablistProps: LayoutTablistProps;
  getTabProps: (tab: PaneNode) => LayoutTabProps;
}

export interface LayoutProps {
  store: LayoutStore;
  /**
   * The content of a pane. It runs again when the pane node changes, except
   * for a change of `hidden`, `collapsed`, or `collapsedSize` alone: the
   * content of a pane that hides, shows, collapses, or expands does not
   * render, and receives `PANE_VISIBILITY_EVENT` instead.
   */
  renderPane: (pane: PaneNode) => ReactNode;
  /** Replace the shown pane's header; spread the supplied tab props to retain keyboard and drag behavior. */
  renderHeader?: (header: PaneHeaderProps) => ReactNode;
  /** Give a pane outside a stack its own single-tab strip. */
  loneTabStrip?: boolean;
  getPaneTitle?: (pane: PaneNode) => string;
  /**
   * Which changes animate. `layout` covers changes of the split tree: split,
   * close, move, hide, and show. `zoom` covers zoom and restore. Both are true
   * by default; with `false`, the change applies at once. A user's
   * `prefers-reduced-motion: reduce` turns both off.
   */
  animate?: boolean | { layout?: boolean; zoom?: boolean };
  /**
   * Whether each pane host is its own compositor layer: `true`, `false`, or
   * `{ minPanes }` to turn the layers on from that number of visible panes.
   * A layer for each pane makes an update in one pane cheaper for the
   * compositor when there are many panes, and costs tile memory when there
   * are few. `{ minPanes: 6 }` by default: below 6 visible panes, the layers
   * cost memory and save no measured time.
   */
  paneLayers?: boolean | { minPanes: number };
  /**
   * The buttons of each pane header, for all panes or for each pane. All three
   * by default.
   */
  paneActions?:
    | readonly PaneAction[]
    | ((pane: PaneNode) => readonly PaneAction[]);
  /**
   * Called by the close button of a pane instead of `store.close`, for example
   * to hide the pane with `store.setHidden` so that it keeps its content.
   */
  onPaneClose?: (pane: PaneNode) => void;
  /** Report changed split sizes at pointer release or after a keyboard resize. Cancellation reports nothing. */
  onResize?: (sizes: Readonly<Record<string, readonly ChildSize[]>>) => void;
  /**
   * Called when a pointer resize starts and for each keyboard resize. It can
   * return a `LayoutResizeSession` that constrains the sizes and releases app
   * state when the resize ends. The view keeps pointer capture and keyboard
   * handling.
   */
  onResizeStart?: (context: LayoutResizeContext) => LayoutResizeSession | void;
  /**
   * Extra props of each pane host: classes, the tab order, a label for a host
   * without tabs, and `data-*` attributes. The view's own attributes, such as
   * `data-layout-pane`, take precedence. A hidden host is never in the tab
   * order.
   */
  getPaneProps?: (pane: PaneNode) => Pick<
    HTMLAttributes<HTMLElement>,
    'className' | 'tabIndex' | 'aria-label'
  > & {
    [Attribute in `data-${string}`]?: string | boolean | undefined;
  };
  /**
   * Extra props of each separator: classes, children such as a larger hit
   * area, an accessible label, `hidden`, and a double-click handler. The view
   * keeps the geometry, the focus, and the resize handlers.
   */
  getSeparatorProps?: (
    separator: CSSSeparator
  ) => Pick<
    HTMLAttributes<HTMLDivElement>,
    'className' | 'children' | 'onDoubleClick' | 'aria-label' | 'hidden'
  >;
  className?: string;
  style?: CSSProperties;
  gap?: number;
  /** Accessible name of the workspace. */
  label?: string;
  /**
   * Experimental, for `explore-resize-drag-content-layout`: how a pointer
   * resize applies its sizes (see `ResizeStrategy`).
   */
  experimentalResize?: ResizeStrategy;
  /**
   * Experimental, for `explore-size-animation-without-stretch`: how a pane
   * that changes size animates. `counter-scale` keeps its header and content
   * in shape; `scale` scales them with the pane, as before.
   */
  experimentalSizeAnimation?: 'counter-scale' | 'scale';
}

/** The start of a resize, for `onResizeStart`. */
export interface LayoutResizeContext {
  /** The separator or the corner that the user resizes with. */
  element: HTMLElement;
  /** The pixel geometry of the separators that the resize changes. */
  separators: readonly SeparatorGeometry[];
  source: 'pointer' | 'keyboard';
}

/**
 * An app's part in one resize: a pointer drag from press to release, or one
 * key press.
 */
export interface LayoutResizeSession {
  /**
   * Returns the sizes to apply in place of the proposed sizes, for example
   * sizes that snap to a position. `point` is the pointer position, or null
   * for a keyboard resize.
   */
  update?: (
    sizes: Record<string, ChildSize[]>,
    point: { clientX: number; clientY: number } | null
  ) => Record<string, ChildSize[]>;
  /**
   * Called once when the resize ends: with `false` after it applies, and with
   * `true` after a cancellation or an unmount, which restore the sizes from
   * before the resize.
   */
  end?: (cancelled: boolean) => void;
}

interface ResizeGesture {
  type: 'resize';
  /** The separator or the corner that holds the pointer capture. */
  element: HTMLElement;
  pointerId: number;
  x: number;
  y: number;
  separators: readonly SeparatorGeometry[];
  originalSizes: Record<string, readonly ChildSize[]>;
  session: LayoutResizeSession | void;
}

interface MoveGesture {
  type: 'move';
  pointerId: number;
  x: number;
  y: number;
  paneId: string;
}

interface TabTarget extends TabDropTarget {
  index?: number;
}

/** A tab drag can reorder its list, join another group, or split at a pane edge. */
interface TabGesture {
  type: 'tab';
  pointerId: number;
  x: number;
  y: number;
  paneId: string;
  tab: HTMLElement;
  tablist: HTMLElement;
  /** The IDs of the visible tabs, in order. */
  visible: readonly string[];
  /** The tab edges, read when the pointer has moved far enough to drag. */
  edges: TabEdges[] | null;
  /** The boundary of the list where the tab would go. */
  boundary: number | null;
  target: TabTarget | null;
  marked: HTMLElement | null;
}

// The compiled CSS of each tree, by gap. The view reads it before a change,
// to find whether any box moves, and when it renders the change.
const cssLayouts = new WeakMap<LayoutNode, Map<number, CSSLayout>>();

function cssLayoutOf(root: LayoutNode, gap: number): CSSLayout {
  let byGap = cssLayouts.get(root);
  if (byGap === undefined) {
    byGap = new Map();
    cssLayouts.set(root, byGap);
  }
  let layout = byGap.get(gap);
  if (layout === undefined) {
    layout = computeCSSLayout(root, gap);
    byGap.set(gap, layout);
  }
  return layout;
}

/**
 * Whether a tree change moves or resizes an element that shows in both
 * trees. A change of tab, or a change inside a hidden pane, moves nothing,
 * so it needs no FLIP animation and no read of boxes.
 */
function boxesMove(before: CSSLayout, after: CSSLayout): boolean {
  const shown = (layout: CSSLayout): Map<string, string> =>
    new Map(
      layout.panes
        .filter(({ hidden }) => !hidden)
        .map(({ pane, rect }) => [pane.id, JSON.stringify(rect)])
    );
  const panesBefore = shown(before);
  for (const [id, rect] of shown(after)) {
    const old = panesBefore.get(id);
    if (old !== undefined && old !== rect) return true;
  }
  const key = (layout: CSSLayout): string =>
    JSON.stringify([
      layout.separators.map(({ id, rect }) => [id, rect]),
      layout.corners.map(({ id, left, top }) => [id, left, top]),
    ]);
  return key(before) !== key(after);
}

/** The node that a zoom of a pane fills the layout with: its stack, or the pane. */
const zoomKey = (root: LayoutNode, zoomedPane: string | null): string | null =>
  zoomedPane === null ? null : (stackOf(root, zoomedPane)?.id ?? zoomedPane);

// IDs of the tab of a pane in the header of a host. Each host of a stack
// renders the tabs of the stack, so a tab ID names the host too.
const tabIdOf = (prefix: string, host: string, tab: string): string =>
  `${prefix}-tab-${encodeURIComponent(host)}~${encodeURIComponent(tab)}`;

interface PaneBodyProps {
  pane: PaneNode;
  renderPane: (pane: PaneNode) => ReactNode;
}

// Properties of a pane node that change where and whether its content shows,
// not the content. A hide, a show, a collapse, or an expand replaces the pane
// node with a copy that differs only in these.
const LAYOUT_ONLY_KEYS = new Set<string>([
  'hidden',
  'collapsed',
  'collapsedSize',
]);

/**
 * True when a pane's content can keep its last render: the same `renderPane`,
 * and a pane node that is the same, or differs only in `LAYOUT_ONLY_KEYS`.
 * The host stops or starts the rendering of the content and sends
 * `PANE_VISIBILITY_EVENT`, so the content does not need to render for these.
 */
function sameContentProps(a: PaneBodyProps, b: PaneBodyProps): boolean {
  if (a.renderPane !== b.renderPane) return false;
  if (a.pane === b.pane) return true;
  const keys = (pane: PaneNode): string[] =>
    Object.keys(pane).filter((key) => !LAYOUT_ONLY_KEYS.has(key));
  const before = keys(a.pane);
  const record = (pane: PaneNode) => pane as unknown as Record<string, unknown>;
  return (
    before.length === keys(b.pane).length &&
    before.every((key) => record(a.pane)[key] === record(b.pane)[key])
  );
}

/**
 * The FLIP keys of the panes that show in `after` and that `store.setHidden`
 * hid in `before`, so that they grow into their place.
 */
function shownAgain(before: LayoutNode, after: LayoutNode): Set<string> {
  const hidden = new Set(
    getPanes(before)
      .filter((pane) => pane.hidden === true)
      .map(({ id }) => id)
  );
  return new Set(
    shownPanes(after)
      .filter(({ id }) => hidden.has(id))
      .map(({ id }) => `pane:${id}`)
  );
}

/**
 * The app's content of one pane. It renders only when its pane node or the
 * app's `renderPane` changes: focus, zoom, and size changes keep the pane
 * node, because the store keeps the identity of unchanged nodes, and a hide,
 * a show, a collapse, or an expand changes only `LAYOUT_ONLY_KEYS`.
 */
const PaneBody = memo(function PaneBody({
  pane,
  renderPane,
}: PaneBodyProps): JSX.Element {
  return <div className="pierre-layout-content">{renderPane(pane)}</div>;
}, sameContentProps);

function CustomHeader({
  render,
  ...header
}: PaneHeaderProps & {
  render: (header: PaneHeaderProps) => ReactNode;
}): ReactNode {
  return render(header);
}

// The box of a zoomed pane and of the focus indicator while a pane is zoomed.
const FULL_SIZE: CSSProperties = {
  left: 0,
  top: 0,
  width: '100%',
  height: '100%',
};

const rectStyle = (rect: Rect): CSSProperties => ({
  left: rect.x,
  top: rect.y,
  width: rect.width,
  height: rect.height,
});

const EDGE_ORDER = ['top', 'right', 'bottom', 'left'] as const;

const edgeList = (edges: PaneEdges): string =>
  EDGE_ORDER.filter((edge) => edges[edge]).join(' ');

const sameDrop = (a: TabDropTarget | null, b: TabDropTarget | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.paneId === b.paneId &&
    a.place === b.place &&
    JSON.stringify(a.rect) === JSON.stringify(b.rect));

/** The class of an element of the view, with an app's classes after it. */
const withClasses = (own: string, app: string | undefined): string =>
  app === undefined || app === '' ? own : `${own} ${app}`;

/**
 * Releases the pointer capture of a resize that ends before the pointer
 * release, for example on Escape or a window blur, so that the separator gets
 * no more events of that pointer. A DOM without pointer capture, such as a
 * test DOM, has nothing to release.
 */
function releaseCapture(active: ResizeGesture): void {
  if (active.element.hasPointerCapture?.(active.pointerId))
    active.element.releasePointerCapture(active.pointerId);
}

/** Flat, keyed pane hosts retain application content while the split tree changes around them. */
export function Layout({
  store,
  renderPane,
  renderHeader,
  loneTabStrip = false,
  getPaneTitle = (pane) => pane.id,
  className,
  style,
  gap = 8,
  label = 'Workspace',
  paneActions = ALL_PANE_ACTIONS,
  onPaneClose,
  onResize,
  onResizeStart,
  getPaneProps,
  getSeparatorProps,
  animate: animateOptions,
  paneLayers = DEFAULT_PANE_LAYERS,
  experimentalResize = 'live',
  experimentalSizeAnimation = 'counter-scale',
}: LayoutProps): JSX.Element {
  const rootRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<ResizeGesture | MoveGesture | TabGesture | null>(null);
  const [resizing, setResizing] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [drop, setDrop] = useState<TabDropTarget | null>(null);
  const [exitEdges, setExitEdges] = useState<Record<string, Edge>>({});
  const dropRef = useRef<TabDropTarget | null>(null);
  const prefix = useId();

  // Boxes before a store change, for the FLIP animation after React commits it.
  const boxesBefore = useRef<Map<string, Rect> | null>(null);
  // The tree of the last commit. The DOM shows it until React commits the
  // next tree, which can hold more than one store change.
  const committedRoot = useRef<LayoutNode | null>(null);
  const zoomFocusOwner = useRef<string | null>(null);
  const animateLayout =
    typeof animateOptions === 'object'
      ? animateOptions.layout !== false
      : animateOptions !== false;
  const animateZoom =
    typeof animateOptions === 'object'
      ? animateOptions.zoom !== false
      : animateOptions !== false;
  // The direct DOM work of a pointer resize with the `experimentalResize` strategy.
  const resizeWork = useMemo(() => createResizeWork(store), [store]);

  // A window that loses the focus during a pointer resize, for example to
  // another app, may never send the pointer release. The resize then applies
  // its current sizes and ends. The ref holds the gesture end of the last
  // render, with its current props (see `finishGesture`).
  const finishGestureRef = useRef<(cancel: boolean) => void>(() => {});
  useEffect(() => {
    if (!resizing) return;
    const finish = () => finishGestureRef.current(false);
    window.addEventListener('blur', finish);
    return () => window.removeEventListener('blur', finish);
  }, [resizing]);

  // An unmount during a pointer resize restores the sizes from before it and
  // ends the app's session, so that no app state stays in a resize.
  useEffect(
    () => () => {
      const active = gesture.current;
      if (active?.type !== 'resize') return;
      gesture.current = null;
      releaseCapture(active);
      resizeWork.end(true);
      store.setSizes(active.originalSizes);
      active.session?.end?.(true);
    },
    [resizeWork, store]
  );

  // Animate model changes only. CSS owns continuous sizing, including while JS is busy.
  const subscribe = useCallback(
    (listener: () => void): (() => void) => {
      let previous = store.getSnapshot();
      const unsubscribe = store.subscribe(() => {
        const element = rootRef.current;
        const next = store.getSnapshot();
        const zoom = next.zoomedPane;
        // Only a tree or zoom change moves elements. A focus change reads no
        // boxes: the focus indicator shows on the new pane at once. A change
        // of tab in a zoomed stack is not a zoom change: the stack stays.
        const zoomChanges =
          zoomKey(next.root, zoom) !==
          zoomKey(previous.root, previous.zoomedPane);
        const rootChanges = next.root !== previous.root;
        // A pointer resize follows the pointer with no animation.
        const animatable =
          element !== null &&
          (rootChanges || zoomChanges) &&
          (!rootChanges || animateLayout) &&
          (!zoomChanges || animateZoom) &&
          gesture.current?.type !== 'resize' &&
          !matchMedia('(prefers-reduced-motion: reduce)').matches;
        // A tree change animates when a box that shows before and after it
        // moves. A change of tab moves none. The check compares the compiled
        // CSS of both trees, which the render needs anyway.
        const animate =
          animatable &&
          (zoomChanges ||
            boxesMove(
              cssLayoutOf(previous.root, gap),
              cssLayoutOf(next.root, gap)
            ));
        const zoomStarts = zoomChanges && zoom !== null;
        if (element !== null && zoomStarts)
          zoomFocusOwner.current = focusOwner(element);
        if (element !== null && (animate || zoomStarts)) {
          // Layout is clean here, before React applies the change, so these reads are cheap.
          const boxes = readBoxes(element);
          if (zoomStarts) {
            const bounds = element.getBoundingClientRect();
            setExitEdges(getExitEdges(boxes, bounds.width, bounds.height));
          }
          // Stop running animations; the new animation starts from the current boxes.
          cancelFlipAnimations(element);
          boxesBefore.current = animate ? boxes : null;
        }
        // Show the covered panes before React commits a zoom change, so
        // that they render during the next animation.
        if (element !== null && zoomChanges) setCoveredHidden(element, null);
        previous = next;
        listener();
      });
      return unsubscribe;
    },
    [store, animateLayout, animateZoom, gap]
  );
  const state = useSyncExternalStore(
    subscribe,
    store.getSnapshot,
    store.getSnapshot
  );
  // The store keeps the tree on focus and zoom changes, so this runs only when
  // the tree or the gap changes.
  const geometry = useMemo(
    () => cssLayoutOf(state.root, gap),
    [state.root, gap]
  );
  // Style objects keep their identity while the tree does, so a focus or zoom
  // change gives React the same objects to compare.
  const styles = useMemo(
    () => ({
      panes: new Map(
        geometry.panes.map(({ pane, rect }): [string, CSSProperties] => [
          pane.id,
          rect,
        ])
      ),
      separators: new Map(
        geometry.separators.map(({ id, rect }): [string, CSSProperties] => [
          id,
          rect,
        ])
      ),
      corners: new Map(
        geometry.corners.map(({ id, left, top }): [string, CSSProperties] => [
          id,
          { left, top },
        ])
      ),
    }),
    [geometry]
  );
  // Keep DOM order independent of tree traversal: detach/reinsert can reset scroll and focus.
  const paneHosts = [...geometry.panes].sort((a, b) =>
    a.pane.id < b.pane.id ? -1 : a.pane.id > b.pane.id ? 1 : 0
  );
  const focused = geometry.panes.find(
    ({ pane }) => pane.id === (state.zoomedPane ?? state.focusedPane)
  );
  const visibleCount = geometry.panes.filter(({ hidden }) => !hidden).length;
  // A pane can close while another pane would still show: another visible
  // pane, or another visible tab of its stack.
  const closable = (pane: PaneNode, stack: StackNode | null): boolean =>
    visibleCount > 1 ||
    (stack?.children.some((tab) => tab.id !== pane.id && tab.hidden !== true) ??
      false);
  const layered =
    typeof paneLayers === 'boolean'
      ? paneLayers
      : visibleCount >= paneLayers.minPanes;
  const actionsOf = (pane: PaneNode): readonly PaneAction[] =>
    typeof paneActions === 'function' ? paneActions(pane) : paneActions;

  // Tell the content of a pane that stops or starts showing: store.setHidden
  // hides or shows it, or its tab changes. The content stays mounted, so it
  // can pause its own work.
  // A collapsed pane that is not zoomed shows its header only, and its
  // content does not render, so it counts as hidden here.
  // Most tree changes, such as each pointer move of a resize, hide no pane,
  // so the DOM is read only when the set of hidden panes changes.
  const hiddenBefore = useRef<ReadonlySet<string> | null>(null);
  useEffect(() => {
    const hidden = new Set(
      geometry.panes
        .filter(
          ({ pane, hidden, collapsed }) =>
            hidden || (collapsed && pane.id !== state.zoomedPane)
        )
        .map(({ pane }) => pane.id)
    );
    const before = hiddenBefore.current;
    hiddenBefore.current = hidden;
    const element = rootRef.current;
    if (before === null || element === null) return;
    const changed =
      before.size !== hidden.size || [...hidden].some((id) => !before.has(id));
    if (changed) notifyHidden(element, before, hidden);
  }, [geometry, state.zoomedPane]);

  // The content of a collapsed pane is inert. The view sets it on the DOM, in
  // the same style update as the `content-visibility` of the content, so the
  // content does not render again for either change. The key changes only
  // when a pane collapses or expands, so a drag does no work here.
  const collapsedKey = JSON.stringify(
    geometry.panes
      .filter(
        ({ pane, collapsed }) => collapsed && pane.id !== state.zoomedPane
      )
      .map(({ pane }) => pane.id)
  );
  useLayoutEffect(() => {
    const element = rootRef.current;
    if (element !== null)
      setCollapsedContent(
        element,
        new Set(JSON.parse(collapsedKey) as string[])
      );
  }, [collapsedKey]);

  // A tab that the user selects is in the header of the host that shows next.
  // Its host takes no input until React commits the change, so the focus
  // moves to it here, before the browser paints.
  const tabToFocus = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = rootRef.current;
    const id = tabToFocus.current;
    tabToFocus.current = null;
    if (element !== null && id !== null) focusTab(element, id);
  }, [state]);

  // After React commits a store change, animate each moved element from its old box.
  // A pane that shows again grows into its place. The panes that show again
  // come from the last committed tree, not from one store change: an app
  // can show the panes of a stack with one call each before React commits.
  useLayoutEffect(() => {
    const element = rootRef.current;
    const before = boxesBefore.current;
    const committed = committedRoot.current;
    boxesBefore.current = null;
    committedRoot.current = state.root;
    if (element !== null && before !== null)
      animateFromBoxes(
        element,
        before,
        experimentalSizeAnimation === 'counter-scale',
        committed === null || committed === state.root
          ? new Set()
          : shownAgain(committed, state.root)
      );
  }, [state, experimentalSizeAnimation]);

  useEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    // No text selection during a gesture. An inherited style on the root,
    // such as user-select, would recalculate the style of all pane content.
    const preventSelection = (event: Event): void => {
      if (gesture.current !== null) event.preventDefault();
    };
    element.addEventListener('selectstart', preventSelection);
    return () => element.removeEventListener('selectstart', preventSelection);
  }, []);

  useEffect(() => {
    const element = rootRef.current;
    if (element === null) return;
    // Observation only ends a discrete animation; it never computes bounds or updates React.
    const observer = new ResizeObserver(() => finishFlipAnimations(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  // Pixel geometry is needed only when a user starts resizing or points at a drop target.
  function readGeometry(): LayoutGeometry {
    const element = rootRef.current;
    if (element === null) return { panes: [], separators: [], corners: [] };
    return readPixelGeometry(element, store.getSnapshot().root, gap);
  }

  function separatorsAt(
    target: HTMLElement,
    ids: readonly string[]
  ): SeparatorGeometry[] {
    const element = rootRef.current;
    if (element === null) return [];
    const touching = separatorIdsAt(element, target, ids, geometry.corners);
    return readGeometry().separators.filter(({ id }) => touching.has(id));
  }

  // Move the focus into the zoomed pane first: a focused element in a pane
  // with `content-visibility: hidden` loses the focus to `body`. When the
  // zoom animation ends, the covered panes skip rendering.
  useEffect(() => {
    const element = rootRef.current;
    const zoomedPane = state.zoomedPane;
    const owner = zoomFocusOwner.current;
    zoomFocusOwner.current = null;
    if (element === null || zoomedPane === null) return;
    focusZoomedPane(element, zoomedPane, owner);
    let current = true;
    // A tree change during the zoom cancels its animations, and the covered
    // panes then hide at once. A zoom change also cancels them, before React
    // ends this effect, so check the store too.
    hideCoveredAfterAnimation(
      element,
      zoomedPane,
      () => current && store.getSnapshot().zoomedPane === zoomedPane
    );
    return () => {
      current = false;
    };
  }, [state.zoomedPane, store]);

  function startResize(
    event: PointerEvent<HTMLElement>,
    ids: readonly string[]
  ): void {
    const separators = separatorsAt(event.currentTarget, ids);
    if (event.button !== 0) return;
    event.preventDefault();
    event.currentTarget.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      type: 'resize',
      element: event.currentTarget,
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      separators,
      originalSizes: Object.fromEntries(
        separators.map(({ split }) => [split.id, split.sizes])
      ),
      session: onResizeStart?.({
        element: event.currentTarget,
        separators,
        source: 'pointer',
      }),
    };
    setResizing(true);
  }

  function startMove(
    event: PointerEvent<HTMLButtonElement>,
    paneId: string
  ): void {
    if (event.button !== 0 || state.zoomedPane !== null) return;
    event.currentTarget.setPointerCapture(event.pointerId);
    gesture.current = {
      type: 'move',
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      paneId,
    };
  }

  function selectTab(id: string): void {
    tabToFocus.current = id;
    store.activate(id);
  }

  /**
   * Move a tab to a boundary of its tab list (see `tabMoveIndex`). The tab
   * keeps the focus.
   */
  function moveTabTo(
    stack: StackNode,
    visible: readonly string[],
    id: string,
    boundary: number
  ): void {
    const index = tabMoveIndex(
      stack.children.map((pane) => pane.id),
      visible,
      id,
      boundary
    );
    if (index === null) return;
    tabToFocus.current = id;
    store.moveTab(id, index);
  }

  /**
   * The keys of the tab list, from the APG tabs pattern: arrows move to the
   * next or the previous tab, and Home and End to the first or the last. The
   * tab that gets the focus shows. Delete closes the focused tab. Ctrl+Shift
   * with PageUp or PageDown moves the focused tab before the previous tab or
   * after the next one, as Firefox, Chrome, and VS Code move their tabs.
   */
  function tabKey(
    event: KeyboardEvent<HTMLElement>,
    tabs: readonly PaneNode[],
    tab: PaneNode,
    stack: StackNode | null
  ): void {
    const at = tabs.indexOf(tab);
    if (
      event.ctrlKey &&
      event.shiftKey &&
      (event.key === 'PageUp' || event.key === 'PageDown')
    ) {
      // The browser does not move its own tab for a key that the page uses.
      event.preventDefault();
      const boundary = event.key === 'PageUp' ? at - 1 : at + 2;
      if (stack !== null && boundary >= 0 && boundary <= tabs.length)
        moveTabTo(
          stack,
          tabs.map((pane) => pane.id),
          tab.id,
          boundary
        );
      return;
    }
    const next =
      event.key === 'ArrowRight'
        ? tabs[(at + 1) % tabs.length]
        : event.key === 'ArrowLeft'
          ? tabs[(at - 1 + tabs.length) % tabs.length]
          : event.key === 'Home'
            ? tabs[0]
            : event.key === 'End'
              ? tabs[tabs.length - 1]
              : null;
    if (next !== null) {
      event.preventDefault();
      if (next.id !== tab.id) selectTab(next.id);
    } else if (
      event.key === 'Delete' &&
      actionsOf(tab).includes('close') &&
      closable(tab, stack)
    ) {
      event.preventDefault();
      closePane(tab);
    }
  }

  function closePane(pane: PaneNode): void {
    // A tab that closes from the tab list gives the focus to the tab that
    // shows next, as the APG tabs pattern does.
    const fromTab = document.activeElement?.getAttribute('role') === 'tab';
    if (onPaneClose !== undefined) onPaneClose(pane);
    else store.close(pane.id);
    requestAnimationFrame(() => {
      const element = rootRef.current;
      if (element === null) return;
      const focused = store.getSnapshot().focusedPane;
      if (fromTab) focusTab(element, focused);
      else focusPane(element, focused);
    });
  }

  /**
   * Start a possible drag of a tab. It becomes a drag when the pointer moves
   * 4 px; a press without a move stays a click. A press on the close mark is
   * a click.
   */
  function startTabDrag(
    event: PointerEvent<HTMLElement>,
    id: string,
    tabs: readonly PaneNode[]
  ): void {
    const tablist = event.currentTarget.closest<HTMLElement>(
      `[${TABLIST_ATTRIBUTE}]`
    );
    if (
      event.button !== 0 ||
      tablist === null ||
      (event.target as Element).closest(`[${TAB_CLOSE_ATTRIBUTE}]`) !== null
    )
      return;
    gesture.current = {
      type: 'tab',
      pointerId: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      paneId: id,
      tab: event.currentTarget,
      tablist,
      visible: tabs.map((tab) => tab.id),
      edges: null,
      boundary: null,
      target: null,
      marked: null,
    };
  }

  function markTablist(active: TabGesture, tablist: HTMLElement | null): void {
    if (active.marked !== null && active.marked !== tablist)
      clearTabDrop(active.marked);
    active.marked = tablist;
  }

  function showTabTarget(active: TabGesture, target: TabTarget | null): void {
    active.target = target;
    if (!sameDrop(dropRef.current, target)) {
      dropRef.current = target;
      setDrop(target);
    }
    setDragging(target === null ? null : active.paneId);
  }

  function groupTargetAt(
    active: TabGesture,
    clientX: number,
    clientY: number
  ): TabTarget | null {
    const element = rootRef.current;
    if (element === null || store.getSnapshot().zoomedPane !== null) {
      markTablist(active, null);
      return null;
    }
    const bounds = element.getBoundingClientRect();
    const x = clientX - bounds.left;
    const y = clientY - bounds.top;
    const pixels = readGeometry();
    const hit = paneAt(pixels, x, y, '');
    if (hit !== undefined && !active.visible.includes(hit.pane.id)) {
      const host = hostOf(element, hit.pane.id);
      const tablist =
        host === undefined ? null : tablistAt(host, clientX, clientY);
      const target = tabDropTarget(
        pixels,
        x,
        y,
        active.paneId,
        active.visible,
        true
      );
      if (tablist !== null && target !== null) {
        const edges = readTabEdges(tablist);
        const boundary = tabBoundaryAt(
          edges,
          clientX - tablist.getBoundingClientRect().left
        );
        const stack = stackOf(store.getSnapshot().root, hit.pane.id);
        markTablist(active, tablist);
        showTabDrop(tablist, boundaryOffset(edges, boundary));
        return {
          ...target,
          index: tabInsertIndex(
            stack?.children.map(({ id }) => id) ?? [hit.pane.id],
            tabsOf(tablist).map((tab) => tab.dataset.layoutTab ?? ''),
            boundary
          ),
        };
      }
    }
    markTablist(active, null);
    return tabDropTarget(pixels, x, y, active.paneId, active.visible);
  }

  /**
   * Follow a tab drag: show where the tab would go. The tab edges are read
   * once, when the drag starts. The current list box and other groups are
   * read during the drag so that cross-group targets follow the pointer.
   */
  function dragTab(active: TabGesture, event: PointerEvent): void {
    if (active.edges === null) {
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4)
        return;
      active.edges = readTabEdges(active.tablist);
      try {
        active.tab.setPointerCapture(active.pointerId);
      } catch {
        // The pointer is no longer active; the next event ends the gesture.
      }
      active.tab.dataset.dragging = 'true';
    }
    const box = active.tablist.getBoundingClientRect();
    const inTablist =
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    if (inTablist) {
      markTablist(active, null);
      showTabTarget(active, null);
      active.boundary = tabBoundaryAt(active.edges, event.clientX - box.left);
      showTabDrop(
        active.tablist,
        boundaryOffset(active.edges, active.boundary)
      );
      return;
    }
    active.boundary = null;
    clearTabDrop(active.tablist);
    showTabTarget(active, groupTargetAt(active, event.clientX, event.clientY));
  }

  function pointerMove(event: PointerEvent<HTMLDivElement>): void {
    const active = gesture.current;
    if (active === null || active.pointerId !== event.pointerId) return;
    if (active.type === 'tab') {
      dragTab(active, event);
    } else if (active.type === 'resize') {
      const element = rootRef.current;
      if (element === null) return;
      const proposed = dragSizes(
        active.separators,
        event.clientX - active.x,
        event.clientY - active.y
      );
      resizeWork.apply(
        element,
        experimentalResize,
        active.separators,
        active.session?.update?.(proposed, event) ?? proposed,
        geometry.corners
      );
    } else {
      if (Math.hypot(event.clientX - active.x, event.clientY - active.y) < 4)
        return;
      setDragging(active.paneId);
      const bounds = event.currentTarget.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const target = paneAt(readGeometry(), x, y, active.paneId);
      const edge =
        target === undefined
          ? null
          : dropTarget(target.pane.id, target.rect, x, y);
      const next =
        edge === null
          ? null
          : { paneId: edge.paneId, place: edge.edge, rect: edge.rect };
      dropRef.current = next;
      setDrop(next);
    }
  }

  function finishGesture(cancel: boolean, pointerId?: number): void {
    const active = gesture.current;
    if (
      active === null ||
      (pointerId !== undefined && active.pointerId !== pointerId)
    )
      return;
    if (active.type === 'resize') resizeWork.end(cancel);
    gesture.current = null;
    // After the gesture ends, so that the `lostpointercapture` of the release
    // finds no gesture to cancel.
    if (active.type === 'resize') releaseCapture(active);
    if (active.type === 'tab') {
      clearTabDrop(active.tablist);
      markTablist(active, null);
      delete active.tab.dataset.dragging;
      const stack = stackOf(store.getSnapshot().root, active.paneId);
      const target = active.target;
      dropRef.current = null;
      setDrop(null);
      setDragging(null);
      if (cancel) return;
      if (target !== null) {
        tabToFocus.current = active.paneId;
        if (target.place === 'center')
          store.moveToStack(active.paneId, target.paneId, target.index);
        else store.move(active.paneId, target.paneId, target.place);
      } else if (active.boundary !== null && stack !== null)
        moveTabTo(stack, active.visible, active.paneId, active.boundary);
      return;
    }
    if (active.type === 'resize' && cancel)
      store.setSizes(active.originalSizes);
    if (active.type === 'resize' && !cancel) {
      const root = store.getSnapshot().root;
      const changed = Object.fromEntries(
        Object.entries(active.originalSizes).flatMap(([id, original]) => {
          const split = findNode(root, id);
          return split?.type === 'split' &&
            JSON.stringify(split.sizes) !== JSON.stringify(original)
            ? [[id, split.sizes]]
            : [];
        })
      );
      if (Object.keys(changed).length > 0) onResize?.(changed);
    }
    if (active.type === 'resize') active.session?.end?.(cancel);
    const moveTo = dropRef.current;
    if (
      active.type === 'move' &&
      !cancel &&
      moveTo !== null &&
      moveTo.place !== 'center'
    ) {
      store.move(active.paneId, moveTo.paneId, moveTo.place);
    }
    dropRef.current = null;
    setResizing(false);
    setDragging(null);
    setDrop(null);
  }
  useLayoutEffect(() => {
    finishGestureRef.current = finishGesture;
  });

  // A key press that resizes is a whole resize: it starts a session, applies
  // the session's sizes, and ends it. The key does not reach the app's own
  // key handlers above the layout.
  function resizeKey(
    event: KeyboardEvent<HTMLElement>,
    ids: readonly string[]
  ): void {
    const separators = separatorsAt(event.currentTarget, ids);
    const proposed = keySizes(separators, event.key, event.shiftKey);
    if (proposed !== null) {
      event.preventDefault();
      event.stopPropagation();
      const session = onResizeStart?.({
        element: event.currentTarget,
        separators,
        source: 'keyboard',
      });
      const sizes = session?.update?.(proposed, null) ?? proposed;
      const before = store.getSnapshot().root;
      store.setSizes(sizes);
      const changed = Object.fromEntries(
        Object.entries(sizes).filter(([id, next]) => {
          const split = findNode(before, id);
          return (
            split?.type !== 'split' ||
            JSON.stringify(split.sizes) !== JSON.stringify(next)
          );
        })
      );
      if (Object.keys(changed).length > 0) onResize?.(changed);
      session?.end?.(false);
    }
  }

  return (
    <div
      ref={rootRef}
      className={`pierre-layout ${className ?? ''}`}
      style={style}
      role="group"
      aria-label={label}
      data-resizing={resizing}
      data-pane-layers={layered}
      data-dragging={dragging !== null}
      onPointerMove={pointerMove}
      onPointerUp={(event) => finishGesture(false, event.pointerId)}
      onPointerCancel={(event) => finishGesture(true, event.pointerId)}
      onLostPointerCapture={(event) => finishGesture(true, event.pointerId)}
      onKeyDown={(event) => {
        // Pane content that handles a key, for example Escape in a menu,
        // prevents its default, and the layout then leaves the key alone.
        if (event.defaultPrevented) return;
        if (event.key === 'Escape') {
          finishGesture(true);
          if (state.zoomedPane !== null) store.toggleZoom();
        }
      }}
    >
      {paneHosts.map(({ pane, hidden: notShown, stack, collapsed, edges }) => {
        const custom = getPaneProps?.(pane);
        const covered =
          !notShown &&
          state.zoomedPane !== null &&
          state.zoomedPane !== pane.id;
        const hidden = notShown || covered;
        const tabs =
          stack !== null
            ? stack.children.filter((tab) => tab.hidden !== true)
            : loneTabStrip
              ? [pane]
              : [];
        const tabbed = tabs.length > 0;
        const labelled = tabbed && !notShown;
        const zoomed = state.zoomedPane === pane.id;
        // A zoomed pane shows its content, also when it is collapsed.
        const folded = collapsed && !zoomed;
        const contact = zoomed ? ALL_EDGES : edges;
        const actions = actionsOf(pane);
        const edge = exitEdges[pane.id] ?? 'left';
        // A covered pane keeps its geometry and moves past an edge with a
        // transform, so that it does not lay out its content again. One
        // container size is always enough to leave the container.
        const exit =
          edge === 'left'
            ? `translateX(calc(-100cqw - ${gap}px))`
            : edge === 'right'
              ? `translateX(calc(100cqw + ${gap}px))`
              : edge === 'top'
                ? `translateY(calc(-100cqh - ${gap}px))`
                : `translateY(calc(100cqh + ${gap}px))`;
        const tablistProps: LayoutTablistProps = {
          role: 'tablist',
          'aria-label': `Tabs of ${getPaneTitle(pane)}`,
          'data-layout-tablist': '',
        };
        const getTabProps = (tab: PaneNode): LayoutTabProps => {
          const selected = tab.id === pane.id;
          return {
            id: tabIdOf(prefix, pane.id, tab.id),
            role: 'tab',
            'aria-selected': selected,
            'aria-controls': `${prefix}-${encodeURIComponent(tab.id)}`,
            tabIndex: selected ? 0 : -1,
            'data-layout-tab': tab.id,
            onPointerDown: (event) => startTabDrag(event, tab.id, tabs),
            onClick: () => {
              if (!selected) selectTab(tab.id);
            },
            onKeyDown: (event) => tabKey(event, tabs, tab, stack),
          };
        };
        const tabById = (id: string): PaneNode | undefined =>
          tabs.find((tab) => tab.id === id) ??
          (id === pane.id ? pane : undefined);
        const header = notShown ? null : renderHeader !== undefined ? (
          <CustomHeader
            render={renderHeader}
            pane={pane}
            stack={stack}
            tabs={tabs}
            edges={contact}
            focused={state.focusedPane === pane.id}
            zoomed={zoomed}
            collapsed={folded}
            canClose={(id) => {
              const tab = tabById(id);
              return tab !== undefined && closable(tab, stack);
            }}
            close={(id) => {
              const tab = tabById(id);
              if (tab !== undefined && closable(tab, stack)) closePane(tab);
            }}
            select={(id) => {
              if (id !== pane.id && stack !== null && tabById(id) !== undefined)
                selectTab(id);
            }}
            tablistProps={tablistProps}
            getTabProps={getTabProps}
          />
        ) : (
          <header className="pierre-layout-header">
            {actions.includes('move') && (
              <button
                type="button"
                className="pierre-layout-grip"
                aria-label={`Drag ${getPaneTitle(pane)}`}
                title="Drag to move this pane beside another"
                // Not `disabled`, and only on the zoomed pane: a state
                // change on every pane would lay each grip out again.
                // startMove ignores a drag while a pane is zoomed.
                aria-disabled={zoomed || undefined}
                onPointerDown={(event) => startMove(event, pane.id)}
              >
                ⠿
              </button>
            )}
            {tabbed ? (
              <div {...tablistProps} className="pierre-layout-tabs">
                {tabs.map((tab) => {
                  const title = getPaneTitle(tab);
                  return (
                    <button
                      key={tab.id}
                      type="button"
                      className="pierre-layout-tab"
                      {...getTabProps(tab)}
                    >
                      <span className="pierre-layout-tab-title">{title}</span>
                      {actionsOf(tab).includes('close') &&
                        closable(tab, stack) && (
                          // A pointer shortcut: Delete on the tab and the
                          // header's close button do the same.
                          <span
                            className="pierre-layout-tab-close"
                            data-layout-tab-close=""
                            aria-hidden="true"
                            title={`Close ${title}`}
                            onClick={(event) => {
                              event.stopPropagation();
                              closePane(tab);
                            }}
                          >
                            ×
                          </span>
                        )}
                    </button>
                  );
                })}
              </div>
            ) : (
              <span className="pierre-layout-title">{getPaneTitle(pane)}</span>
            )}
            {actions.includes('collapse') && (
              <button
                type="button"
                aria-label={`Collapse ${getPaneTitle(pane)}`}
                aria-pressed={collapsed}
                onClick={() => store.setCollapsed(pane.id, !collapsed)}
              >
                {collapsed ? '▸' : '▾'}
              </button>
            )}
            {actions.includes('zoom') && (
              <button
                type="button"
                aria-label={`${zoomed ? 'Restore' : 'Zoom'} ${getPaneTitle(pane)}`}
                aria-pressed={zoomed}
                onClick={() => store.toggleZoom(pane.id)}
              >
                {zoomed ? '↙' : '↗'}
              </button>
            )}
            {actions.includes('close') && (
              <button
                type="button"
                aria-label={`Close ${getPaneTitle(pane)}`}
                disabled={!closable(pane, stack)}
                onClick={() => closePane(pane)}
              >
                ×
              </button>
            )}
          </header>
        );
        return (
          <section
            key={pane.id}
            // First, so that the view's own attributes below take precedence.
            {...custom}
            id={`${prefix}-${encodeURIComponent(pane.id)}`}
            data-layout-pane={pane.id}
            data-layout-flip={`pane:${pane.id}`}
            data-layout-edges={edgeList(contact)}
            className={withClasses('pierre-layout-pane', custom?.className)}
            tabIndex={hidden ? -1 : (custom?.tabIndex ?? 0)}
            role={tabbed ? 'tabpanel' : undefined}
            aria-label={
              labelled
                ? undefined
                : (custom?.['aria-label'] ?? getPaneTitle(pane))
            }
            aria-labelledby={
              labelled ? tabIdOf(prefix, pane.id, pane.id) : undefined
            }
            aria-hidden={hidden}
            // A covered pane becomes inert when its content stops rendering,
            // at the end of the zoom animation (setCoveredHidden).
            inert={notShown}
            data-pane-hidden={notShown}
            data-collapsed={folded}
            data-focused={state.focusedPane === pane.id}
            data-zoomed={zoomed}
            data-moving={dragging === pane.id}
            style={
              zoomed
                ? FULL_SIZE
                : covered
                  ? { ...styles.panes.get(pane.id), transform: exit }
                  : styles.panes.get(pane.id)
            }
            onFocusCapture={() => store.focusPane(pane.id)}
            onPointerDown={() => store.focusPane(pane.id)}
          >
            {/* The inner wrapper counters the host's FLIP scale to preserve the content's shape. */}
            <div className="pierre-layout-pane-inner">
              {header}
              <PaneBody pane={pane} renderPane={renderPane} />
            </div>
          </section>
        );
      })}
      {/* The indicator has the FLIP key of its pane, so it moves with that
          pane. A focus change replaces it, so it never moves to another pane. */}
      {focused !== undefined && (
        <div
          key={focused.pane.id}
          className="pierre-layout-focus"
          data-layout-flip={`pane:${focused.pane.id}`}
          aria-hidden="true"
          style={
            state.zoomedPane !== null
              ? FULL_SIZE
              : styles.panes.get(focused.pane.id)
          }
        />
      )}
      {state.zoomedPane === null &&
        geometry.separators.map((separator) => {
          const custom = getSeparatorProps?.(separator);
          // The separator resizes the two children beside it first.
          const before = shownPanes(separator.before);
          const after = shownPanes(separator.split.children[separator.index]);
          const value = Math.round(separator.value * 100);
          return (
            <div
              key={separator.id}
              {...custom}
              className={withClasses(
                'pierre-layout-separator',
                custom?.className
              )}
              role="separator"
              tabIndex={0}
              aria-label={
                custom?.['aria-label'] ??
                `Resize ${before.map(getPaneTitle).join(', ')} and ${after.map(getPaneTitle).join(', ')}`
              }
              aria-orientation={
                separator.split.direction === 'horizontal'
                  ? 'vertical'
                  : 'horizontal'
              }
              aria-controls={[...before, ...after]
                .map(({ id }) => `${prefix}-${encodeURIComponent(id)}`)
                .join(' ')}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={value}
              aria-valuetext={`${value}% preferred position`}
              data-direction={separator.split.direction}
              data-layout-flip={`separator:${separator.id}`}
              style={styles.separators.get(separator.id)}
              onPointerDown={(event) => startResize(event, [separator.id])}
              onKeyDown={(event) => resizeKey(event, [separator.id])}
            />
          );
        })}
      {state.zoomedPane === null &&
        geometry.corners.map((corner) => (
          <button
            key={corner.id}
            type="button"
            className="pierre-layout-corner"
            aria-label="Resize both axes"
            style={styles.corners.get(corner.id)}
            data-layout-corner={corner.id}
            data-layout-flip={`corner:${corner.id}`}
            onPointerDown={(event) => startResize(event, corner.separatorIds)}
            onKeyDown={(event) => resizeKey(event, corner.separatorIds)}
          />
        ))}
      {drop !== null && (
        <div
          className="pierre-layout-drop"
          style={rectStyle(drop.rect)}
          aria-hidden="true"
        />
      )}
      <span className="pierre-layout-sr" role="status" aria-live="polite">
        {dragging !== null && drop !== null
          ? drop.place === 'center'
            ? `Move ${dragging} into the group of ${drop.paneId}`
            : `Move ${dragging} to the ${drop.place} of ${drop.paneId}`
          : state.zoomedPane !== null
            ? `${state.zoomedPane} zoomed`
            : `${visibleCount} panes`}
      </span>
    </div>
  );
}
