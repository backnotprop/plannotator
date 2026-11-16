import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { LayoutStore, naryTree, type ChildSize, type LayoutNode, type PaneNode } from '@plannotator/vendor-pierre-layouts';
import { Layout } from '@plannotator/vendor-pierre-layouts/react';
import { pressToDrag } from '../drag/threadDrag';
import type { PaneId } from './layoutModel';

export interface FreeLayoutProps {
  /** The tree to draw: the layout's, with the panes that stepped aside for room hidden (layoutRoom.ts). */
  tree: LayoutNode;
  active: PaneId;
  gap: number;
  /** The pane's thread's subject, for its accessible name and a drag's pill. */
  title: (id: PaneId) => string;
  /** Stable across draws: a pane's content follows the window through context (ThreadPanes.tsx). */
  renderPane: (pane: PaneNode) => ReactNode;
  onFocus: (id: PaneId) => void;
  onResize: (sizes: Readonly<Record<string, readonly ChildSize[]>>) => void;
}

const NO_ACTIONS = [] as const;
const noHeader = () => null;
/** What a press on a pane's header can start a drag from: its empty part and its title, never a control. */
const CONTROL = 'button, a, input, textarea, select, [role="menuitem"], [role="button"], [contenteditable="true"]';

/**
 * Several thread panes, placed by @pierre/layouts (packages/vendor-pierre-layouts). The layout's tree is the truth:
 * it is pushed into the engine's store on every change, and what the engine does on its own (a divider dragged, a
 * pane pressed into) comes back through `onResize` and `onFocus`. The engine draws no header and no actions of its
 * own: each pane's header is the thread's, and a press on it (not on a control) that moves 5 px picks the pane up
 * (drag/threadDrag.ts); where it lands is the drop target ThreadPanes registers.
 */
export default function FreeLayout({ tree, active, gap, title, renderPane, onFocus, onResize }: FreeLayoutProps) {
  const [store] = useState(() => new LayoutStore(tree, { model: naryTree }));
  const pushed = useRef<LayoutNode | null>(null);
  const syncing = useRef(false);
  const live = useRef({ active, onFocus, title });
  live.current = { active, onFocus, title };
  useLayoutEffect(() => {
    syncing.current = true;
    try {
      if (pushed.current !== tree) {
        pushed.current = tree;
        store.setRoot(tree);
      }
      store.focusPane(active);
    } finally {
      syncing.current = false;
    }
  }, [store, tree, active]);
  // A press or focus in a pane (the engine's own handlers) makes it the active one.
  useEffect(
    () =>
      store.subscribe(() => {
        if (syncing.current) return;
        const focused = store.getSnapshot().focusedPane;
        if (focused !== live.current.active) live.current.onFocus(focused);
      }),
    [store],
  );
  const pressHeader = (event: ReactPointerEvent<HTMLDivElement>) => {
    const target = event.target instanceof Element ? event.target : null;
    const head = target?.closest('.ib-phead');
    const host = head?.closest<HTMLElement>('[data-layout-pane]');
    if (!head || !host || target!.closest(CONTROL)) return;
    const paneId = host.dataset.layoutPane!;
    pressToDrag({
      event: event.nativeEvent,
      payload: { kind: 'pane', paneId, label: live.current.title(paneId) },
      onBegin: () => host.setAttribute('data-pane-dragging', ''),
      onEnd: () => host.removeAttribute('data-pane-dragging'),
    });
  };
  return (
    // `display: contents`: the engine's root is the flex item beside the list; this only hears presses.
    <div style={{ display: 'contents' }} onPointerDown={pressHeader}>
      <Layout
        store={store}
        className="ib-layout"
        gap={gap}
        label="Threads"
        renderPane={renderPane}
        renderHeader={noHeader}
        paneActions={NO_ACTIONS}
        getPaneTitle={(pane) => live.current.title(pane.id)}
        getPaneProps={(pane) => ({ tabIndex: -1, 'data-pane-quiet': pane.id === active ? undefined : '' })}
        onResize={onResize}
      />
    </div>
  );
}
